import os
from dataclasses import dataclass
from typing import Final

from litellm.pii.service import PiiService
from litellm.pii.vault.cipher import VaultCipher
from litellm.pii.vault.keys import DEFAULT_KEY_VERSION, DerivedKeyProvider
from litellm.pii.vault.repository import PiiVaultRepository, table_from_prisma
from litellm.pii.vault.scope import VaultScopeType
from litellm.pii.vault.search import DEFAULT_CANDIDATE_CAP, VaultSearch
from litellm.pii.vault.service import VaultService
from litellm.pii.vault.store import DEFAULT_RETENTION_DAYS, DatabaseTokenStore

ENV_VAULT_ENABLED: Final = "LITELLM_PII_VAULT_ENABLED"
ENV_RETENTION_DAYS: Final = "LITELLM_PII_RETENTION_DAYS"
ENV_KEY_VERSION: Final = "LITELLM_PII_KEY_VERSION"
ENV_DEFAULT_SCOPE: Final = "LITELLM_PII_VAULT_SCOPE"
ENV_SALT_KEY: Final = "LITELLM_SALT_KEY"
ENV_CANDIDATE_CAP: Final = "LITELLM_PII_SEARCH_CANDIDATE_CAP"

TRUTHY: Final = frozenset({"1", "true", "yes", "on"})


def _int_from_env(name: str, fallback: int) -> int:
    raw: Final = os.getenv(name)
    if raw is None:
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def _scope_from_env() -> VaultScopeType:
    raw: Final = os.getenv(ENV_DEFAULT_SCOPE, VaultScopeType.KEY.value)
    try:
        return VaultScopeType(raw)
    except ValueError:
        return VaultScopeType.KEY


@dataclass(frozen=True, slots=True)
class VaultSettings:
    enabled: bool = False
    retention_days: int = DEFAULT_RETENTION_DAYS
    key_version: int = DEFAULT_KEY_VERSION
    default_scope: VaultScopeType = VaultScopeType.KEY
    candidate_cap: int = DEFAULT_CANDIDATE_CAP

    @classmethod
    def from_env(cls) -> "VaultSettings":
        return cls(
            enabled=os.getenv(ENV_VAULT_ENABLED, "").strip().lower() in TRUTHY,
            retention_days=_int_from_env(ENV_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
            key_version=_int_from_env(ENV_KEY_VERSION, DEFAULT_KEY_VERSION),
            default_scope=_scope_from_env(),
            candidate_cap=_int_from_env(ENV_CANDIDATE_CAP, DEFAULT_CANDIDATE_CAP),
        )


def vault_secret() -> str:
    """The proxy's salt key, falling back to the master key as its own helpers do."""
    from litellm.proxy.proxy_server import master_key

    return os.getenv(ENV_SALT_KEY) or master_key or ""


def build_vault_store(
    prisma_client: object | None,
    settings: VaultSettings | None = None,
    secret: str | None = None,
) -> DatabaseTokenStore | None:
    """``None`` when the vault is off or there is no database, so the caller falls back."""
    resolved: Final = settings or VaultSettings.from_env()
    if not resolved.enabled or prisma_client is None:
        return None
    keys: Final = DerivedKeyProvider(
        secret=secret if secret is not None else vault_secret(), version=resolved.key_version
    )
    return DatabaseTokenStore(
        repository=PiiVaultRepository(table=table_from_prisma(prisma_client)),
        cipher=VaultCipher(keys=keys),
        retention_days=resolved.retention_days,
    )


def build_vault(
    prisma_client: object | None,
    pii: PiiService,
    settings: VaultSettings | None = None,
    secret: str | None = None,
) -> VaultService | None:
    store: Final = build_vault_store(prisma_client, settings, secret)
    return None if store is None else VaultService(pii=pii, store=store)


def build_search(
    prisma_client: object | None,
    settings: VaultSettings | None = None,
    secret: str | None = None,
) -> VaultSearch | None:
    """Search reuses the vault's repository and cipher; it stores nothing of its own."""
    resolved: Final = settings or VaultSettings.from_env()
    store: Final = build_vault_store(prisma_client, resolved, secret)
    if store is None:
        return None
    return VaultSearch(
        repository=store.repository,
        cipher=store.cipher,
        candidate_cap=resolved.candidate_cap,
    )
