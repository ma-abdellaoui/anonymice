from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from types import MappingProxyType
from typing import Final, TypeVar

from litellm.pii.types import StoreError, StoreUnavailable
from litellm.pii.vault.cipher import SealedValue, VaultCipher
from litellm.pii.vault.repository import PiiVaultRepository, VaultRow, utcnow
from litellm.pii.vault.scope import VaultScope

DEFAULT_RETENTION_DAYS: Final = 30

_T = TypeVar("_T")  # rebind-ok: a TypeVar is a declaration, not a rebindable value


async def guarded(action: Awaitable[_T], what: str) -> _T | StoreUnavailable:
    """One boundary where a database failure becomes a value.

    The client can raise anything, so the catch is deliberately broad; keeping it
    in one place is what stops that breadth from spreading through the store.
    """
    try:
        return await action
    except Exception as exc:
        return StoreUnavailable(reason=f"PII vault {what} failed ({type(exc).__name__})")


@dataclass(frozen=True, slots=True)
class MintRequest:
    token: str
    entity_type: str
    value: str


@dataclass(frozen=True, slots=True)
class DatabaseTokenStore:
    """The persistent path's store: encrypted rows, resolved in one query.

    Not a ``PiiTokenStore``: that protocol carries the ephemeral ``TokenScope``,
    and these operations need the vault's security scope, the entity type, and
    the session a token was minted under. The service composes the two paths by
    construction rather than by forcing one signature onto both.
    """

    repository: PiiVaultRepository
    cipher: VaultCipher
    retention_days: int = DEFAULT_RETENTION_DAYS

    async def put_many(
        self,
        scope: VaultScope,
        session_id: str,
        mints: Sequence[MintRequest],
        subject_id: str | None = None,
        created_by: str | None = None,
    ) -> None | StoreError:
        """Write before returning, so an unresolvable token is never handed back."""
        if not mints:
            return None

        expires_at: Final = utcnow() + timedelta(days=self.retention_days)
        sealed: Final = tuple([(mint, await self.cipher.seal(mint.value, mint.token, scope)) for mint in mints])
        failure: Final = next((blob for _, blob in sealed if not isinstance(blob, SealedValue)), None)
        if failure is not None:
            return StoreUnavailable(reason=failure.reason)

        rows: Final = tuple(
            VaultRow(
                token_id=mint.token,
                entity_type=mint.entity_type,
                ciphertext=blob.ciphertext,
                key_version=blob.key_version,
                scope=scope,
                session_id=session_id,
                subject_id=subject_id,
                created_by=created_by,
                expires_at=expires_at,
            )
            for mint, blob in sealed
            if isinstance(blob, SealedValue)
        )
        written: Final = await guarded(self.repository.insert_many(rows), "write")
        return written if isinstance(written, StoreUnavailable) else None

    async def get_many(self, scope: VaultScope, tokens: Sequence[str]) -> Mapping[str, str] | StoreError:
        """One indexed query for every token, filtered by scope and expiry.

        A row that fails to open is dropped rather than surfaced: the AAD binding
        means that is a row which does not belong to this scope, and the caller
        should see the token left verbatim, not another scope's value.
        """
        if not tokens:
            return MappingProxyType({})
        rows: Final = await guarded(self.repository.find_live(scope, tokens, utcnow()), "read")
        if isinstance(rows, StoreUnavailable):
            return rows

        opened: Final = tuple(
            [
                (
                    row.token_id,
                    await self.cipher.unseal(SealedValue(row.ciphertext, row.key_version), row.token_id, scope),
                )
                for row in rows
            ]
        )
        return MappingProxyType({token: value for token, value in opened if isinstance(value, str)})

    async def session_tokens(self, scope: VaultScope, session_id: str) -> tuple[VaultRow, ...] | StoreError:
        """What a session holds, without opening any of it.

        Deliberately never decrypts: a browser needs to show what exists and
        when it expires, which is a different question from what it says.
        """
        rows: Final = await guarded(self.repository.find_session(scope, session_id, utcnow()), "read")
        return rows if isinstance(rows, tuple) else rows

    async def revoke_session(self, scope: VaultScope, session_id: str) -> None | StoreError:
        deleted: Final = await guarded(self.repository.delete_session(scope, session_id), "delete")
        return deleted if isinstance(deleted, StoreUnavailable) else None

    async def revoke_subject(self, scope: VaultScope, subject_id: str) -> None | StoreError:
        deleted: Final = await guarded(self.repository.delete_subject(scope, subject_id), "delete")
        return deleted if isinstance(deleted, StoreUnavailable) else None

    async def export_subject(self, scope: VaultScope, subject_id: str) -> Mapping[str, str] | StoreError:
        rows: Final = await guarded(self.repository.find_subject(scope, subject_id, utcnow()), "read")
        if isinstance(rows, StoreUnavailable):
            return rows

        opened: Final = tuple(
            [
                (
                    row.token_id,
                    await self.cipher.unseal(SealedValue(row.ciphertext, row.key_version), row.token_id, scope),
                )
                for row in rows
            ]
        )
        return MappingProxyType({token: value for token, value in opened if isinstance(value, str)})

    async def sweep_expired(self) -> None | StoreError:
        swept: Final = await guarded(self.repository.sweep_expired(utcnow()), "sweep")
        return swept if isinstance(swept, StoreUnavailable) else None
