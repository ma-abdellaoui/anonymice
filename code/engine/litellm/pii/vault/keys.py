from dataclasses import dataclass
from functools import lru_cache
from typing import Final, Protocol, runtime_checkable

from litellm.pii.types import KeyUnavailable
from litellm.pii.vault.scope import VaultScope

HKDF_SALT: Final = b"litellm-pii-v1"
KEY_BYTES: Final = 32
DEFAULT_KEY_VERSION: Final = 1
KEY_CACHE_SIZE: Final = 1024


@runtime_checkable
class PiiKeyProvider(Protocol):
    """Supplies the key a scope's stored values are encrypted under.

    ``key_for`` is async because a secret manager is a network call. A
    deployment needing HSM-backed keys implements this and nothing else changes.
    """

    def current_version(self) -> int: ...

    async def key_for(self, scope: VaultScope, version: int) -> bytes | KeyUnavailable: ...


@lru_cache(maxsize=KEY_CACHE_SIZE)
def derive_key(ikm: str, scope_type: str, scope_id: str, version: int) -> bytes:
    """HKDF-SHA256, bound to the scope and key version.

    Cached because HKDF is the expensive part of a decode, not the cipher.

    HKDF rather than the single-pass SHA-256 the proxy's existing helpers use.
    Those document their derivation as a limitation kept for compatibility with
    already-written data; a new table has no such constraint.
    """
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    info: Final = f"{scope_type}:{scope_id}:{version}".encode()
    return HKDF(algorithm=SHA256(), length=KEY_BYTES, salt=HKDF_SALT, info=info).derive(ikm.encode("utf-8"))


@dataclass(frozen=True, slots=True)
class DerivedKeyProvider:
    """Per-scope keys derived from one root secret, so no new infrastructure.

    Compromising one scope's key yields nothing about another's. Rotation is
    lazy: raising ``version`` changes new writes only, and a read uses whatever
    version its row names, so there is no migration window.
    """

    secret: str
    version: int = DEFAULT_KEY_VERSION

    def current_version(self) -> int:
        return self.version

    async def key_for(self, scope: VaultScope, version: int) -> bytes | KeyUnavailable:
        if not self.secret:
            return KeyUnavailable(reason="no PII vault secret configured")
        return derive_key(self.secret, scope.scope_type.value, scope.scope_id, version)


@runtime_checkable
class SecretReader(Protocol):
    """Structural view of ``BaseSecretManager``, so tests inject a fake."""

    async def async_read_secret(self, secret_name: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class SecretManagerKeyProvider:
    """Per-scope keys fetched through the proxy's existing secret manager.

    AWS Secrets Manager, Vault, Google, and CyberArk all already implement
    ``BaseSecretManager``, so they work here with no new integration code. The
    fetched secret is still run through HKDF so a short or low-entropy secret
    cannot become the raw key.
    """

    reader: SecretReader
    name_prefix: str = "litellm-pii"
    version: int = DEFAULT_KEY_VERSION

    def current_version(self) -> int:
        return self.version

    def secret_name(self, scope: VaultScope, version: int) -> str:
        return f"{self.name_prefix}/{scope.scope_type.value}/{scope.scope_id}/v{version}"

    async def key_for(self, scope: VaultScope, version: int) -> bytes | KeyUnavailable:
        name: Final = self.secret_name(scope, version)
        try:
            secret: Final = await self.reader.async_read_secret(name)
        except Exception as exc:
            return KeyUnavailable(reason=f"secret manager read failed ({type(exc).__name__})")
        if not secret:
            return KeyUnavailable(reason=f"no secret at {name}")
        return derive_key(secret, scope.scope_type.value, scope.scope_id, version)
