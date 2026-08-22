import base64
import hashlib
import os
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from litellm.pii.types import CodecError, DecodeFailed, KeyUnavailable

PII_ENCRYPTION_KEY_ENV: Final = "LITELLM_PII_ENCRYPTION_KEY"
AES_GCM_PREFIX: Final = "v1:gcm:"
NONCE_BYTES: Final = 12
KEY_BYTES: Final = 32


@runtime_checkable
class ValueCipher(Protocol):
    """Encrypts stored PII values at rest.

    The token store maps tokens to the original PII. Sealing those values means
    a compromised cache never yields plaintext on its own.
    """

    def seal(self, plaintext: str) -> str | KeyUnavailable: ...

    def unseal(self, sealed: str) -> str | CodecError: ...


@dataclass(frozen=True, slots=True)
class NullCipher:
    """Passthrough cipher for local development and tests."""

    def seal(self, plaintext: str) -> str | KeyUnavailable:
        return plaintext

    def unseal(self, sealed: str) -> str | CodecError:
        return sealed


@dataclass(frozen=True, slots=True)
class AesGcmCipher:
    """AES-256-GCM with a random 12-byte nonce per value.

    Wire format mirrors the proxy's existing ``encrypt_decrypt_utils`` layout
    (``prefix || base64url(nonce || ciphertext || tag)``) so the two stay legible
    to the same reader, but the key is injected rather than read from a global.
    """

    key: bytes

    @classmethod
    def from_secret(cls, secret: str) -> "AesGcmCipher":
        return cls(key=hashlib.sha256(secret.encode()).digest())

    def seal(self, plaintext: str) -> str | KeyUnavailable:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        if len(self.key) != KEY_BYTES:
            return KeyUnavailable(reason=f"key is {len(self.key)} bytes, expected {KEY_BYTES}")
        nonce: Final = os.urandom(NONCE_BYTES)
        blob: Final = AESGCM(self.key).encrypt(nonce, plaintext.encode("utf-8"), None)
        return AES_GCM_PREFIX + base64.urlsafe_b64encode(nonce + blob).decode("utf-8")

    def unseal(self, sealed: str) -> str | CodecError:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        if not sealed.startswith(AES_GCM_PREFIX):
            return DecodeFailed(reason="missing AES-GCM prefix")
        try:
            raw: Final = base64.urlsafe_b64decode(sealed[len(AES_GCM_PREFIX) :])
            return AESGCM(self.key).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], None).decode("utf-8")
        except (InvalidTag, ValueError, TypeError) as exc:
            return DecodeFailed(reason=f"unseal failed ({type(exc).__name__})")


def cipher_from_env() -> ValueCipher:
    secret: Final = os.getenv(PII_ENCRYPTION_KEY_ENV)
    return AesGcmCipher.from_secret(secret) if secret else NullCipher()
