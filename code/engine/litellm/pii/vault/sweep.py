from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from litellm.pii.vault.store import DatabaseTokenStore

PII_VAULT_SWEEP_JOB_NAME: Final = "pii_vault_sweep"
DEFAULT_SWEEP_INTERVAL_SECONDS: Final = 3600


@runtime_checkable
class CronLock(Protocol):
    """Structural view of ``PodLockManager``, so the sweep is testable without Redis."""

    async def acquire_lock(self, cronjob_id: str) -> bool | None: ...

    async def release_lock(self, cronjob_id: str) -> None: ...


@dataclass(frozen=True, slots=True)
class PiiVaultSweeper:
    """Deletes rows past ``expires_at``.

    Best effort by design: expiry is filtered in the read query too, so a
    skipped or failed sweep costs disk, never a resolved dead token.
    """

    store: DatabaseTokenStore
    lock: CronLock | None = None

    async def sweep(self) -> None:
        from litellm._logging import verbose_proxy_logger

        if self.lock is not None and not await self.lock.acquire_lock(cronjob_id=PII_VAULT_SWEEP_JOB_NAME):
            return
        try:
            swept: Final = await self.store.sweep_expired()
            if swept is not None:
                verbose_proxy_logger.warning("PII vault sweep failed: %s", swept.reason)
        finally:
            if self.lock is not None:
                await self.lock.release_lock(cronjob_id=PII_VAULT_SWEEP_JOB_NAME)
