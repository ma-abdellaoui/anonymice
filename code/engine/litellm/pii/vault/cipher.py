import base64
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Final

from litellm.pii.types import CodecError, DecodeFailed, KeyUnavailable
from litellm.pii.vault.keys import KEY_BYTES, KEY_CACHE_SIZE, PiiKeyProvider
from litellm.pii.vault.scope import VaultScope

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VAULT_PREFIX: Final = "p1:gcm:"
NONCE_BYTES: Final = 12
AAD_SEPARATOR: Final = b"\x00"


@lru_cache(maxsize=KEY_CACHE_SIZE)
def _aead(key: bytes) -> "AESGCM":
    """Building the cipher costs more than the encryption it performs, so keep it."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return AESGCM(key)


@dataclass(frozen=True, slots=True)
class SealedValue:
    ciphertext: str
    key_version: int


def aad_for(token_id: str, scope: VaultScope, key_version: int) -> bytes:
    """Bind a ciphertext to the row it belongs in.

    A row copied into another scope, or a token_id swapped between rows, fails
    to decrypt rather than silently resolving, so authorization is enforced by
    cryptography as well as by the query. NUL separates the parts because it
    cannot occur in any of them, which keeps the encoding unambiguous.
    """
    parts: Final = (token_id, scope.scope_type.value, scope.scope_id, str(key_version))
    return AAD_SEPARATOR.join(part.encode("utf-8") for part in parts)


def open_sealed(key: bytes, sealed: SealedValue, token_id: str, scope: VaultScope) -> str | CodecError:
    """The decrypt itself, without the async key fetch.

    Separate so a bulk scan can fetch one key per version and then run thousands
    of decrypts on a worker thread instead of on the event loop.
    """
    from cryptography.exceptions import InvalidTag

    if not sealed.ciphertext.startswith(VAULT_PREFIX):
        return DecodeFailed(reason="missing PII vault prefix")
    try:
        raw: Final = base64.urlsafe_b64decode(sealed.ciphertext[len(VAULT_PREFIX) :])
        opened: Final = _aead(key).decrypt(
            raw[:NONCE_BYTES],
            raw[NONCE_BYTES:],
            aad_for(token_id, scope, sealed.key_version),
        )
    except (InvalidTag, ValueError, TypeError) as exc:
        return DecodeFailed(reason=f"vault unseal failed ({type(exc).__name__})")
    return opened.decode("utf-8")


@dataclass(frozen=True, slots=True)
class VaultCipher:
    """AES-256-GCM over a per-scope key, with the row's identity as AAD."""

    keys: PiiKeyProvider

    async def seal(self, plaintext: str, token_id: str, scope: VaultScope) -> SealedValue | KeyUnavailable:
        version: Final = self.keys.current_version()
        key: Final = await self.checked_key(scope, version)
        if not isinstance(key, bytes):
            return key
        nonce: Final = os.urandom(NONCE_BYTES)
        blob: Final = _aead(key).encrypt(nonce, plaintext.encode("utf-8"), aad_for(token_id, scope, version))
        packed: Final = base64.urlsafe_b64encode(nonce + blob).decode("utf-8")
        return SealedValue(ciphertext=VAULT_PREFIX + packed, key_version=version)

    async def checked_key(self, scope: VaultScope, version: int) -> bytes | KeyUnavailable:
        """A provider returning the wrong key size is a configuration error, not a crash."""
        key: Final = await self.keys.key_for(scope, version)
        if isinstance(key, bytes) and len(key) != KEY_BYTES:
            return KeyUnavailable(reason=f"key provider returned {len(key)} bytes, expected {KEY_BYTES}")
        return key

    async def unseal(self, sealed: SealedValue, token_id: str, scope: VaultScope) -> str | CodecError:
        """Decrypt at the version the row names, which is what makes rotation lazy."""
        key: Final = await self.checked_key(scope, sealed.key_version)
        if not isinstance(key, bytes):
            return key
        return open_sealed(key, sealed, token_id, scope)
