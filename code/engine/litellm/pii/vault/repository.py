from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final, Protocol, runtime_checkable

from litellm.pii.vault.scope import VaultScope, VaultScopeType

TABLE_NAME: Final = "litellm_piitokentable"
DEFAULT_ALGORITHM: Final = "aes-256-gcm"


@dataclass(frozen=True, slots=True)
class VaultRow:
    """One stored token. ``ciphertext`` is the only place a value ever lives."""

    token_id: str
    entity_type: str
    ciphertext: str
    key_version: int
    scope: VaultScope
    session_id: str | None = None
    subject_id: str | None = None
    created_by: str | None = None
    expires_at: datetime | None = None


def row_to_record(row: VaultRow) -> dict[str, object]:  # mutable-ok: Prisma takes a plain dict
    """The column mapping, in one place, so a schema rename touches one function."""
    return {  # mutable-ok: Prisma takes a plain dict
        "token_id": row.token_id,
        "entity_type": row.entity_type,
        "ciphertext": row.ciphertext,
        "key_version": row.key_version,
        "algorithm": DEFAULT_ALGORITHM,
        "scope_type": row.scope.scope_type.value,
        "scope_id": row.scope.scope_id,
        "session_id": row.session_id,
        "subject_id": row.subject_id,
        "created_by": row.created_by,
        "expires_at": row.expires_at,
    }


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def record_to_row(record: Mapping[str, object]) -> VaultRow | None:
    """None for a record we cannot trust, so a malformed row is skipped rather than guessed at."""
    token_id: Final = _text(record.get("token_id"))
    ciphertext: Final = _text(record.get("ciphertext"))
    scope_id: Final = _text(record.get("scope_id"))
    scope_type: Final = _text(record.get("scope_type"))
    if token_id is None or ciphertext is None or scope_id is None:
        return None
    if scope_type not in VaultScopeType.__members__.values():
        return None
    version: Final = record.get("key_version")
    expires_at: Final = record.get("expires_at")
    return VaultRow(
        token_id=token_id,
        entity_type=_text(record.get("entity_type")) or "",
        ciphertext=ciphertext,
        key_version=version if isinstance(version, int) else 1,
        scope=VaultScope(scope_type=VaultScopeType(scope_type), scope_id=scope_id),
        session_id=_text(record.get("session_id")),
        subject_id=_text(record.get("subject_id")),
        created_by=_text(record.get("created_by")),
        expires_at=expires_at if isinstance(expires_at, datetime) else None,
    )


def live_filter(scope: VaultScope, now: datetime) -> dict[str, object]:  # mutable-ok: Prisma takes a dict
    """Scope plus expiry, applied in the query itself.

    Expiry is filtered on read as well as swept, so a late or failed sweep can
    never resolve a row that should be gone.
    """
    unexpired: Final = [{"expires_at": None}, {"expires_at": {"gt": now}}]  # mutable-ok: Prisma takes plain data
    return {  # mutable-ok: Prisma takes a plain dict
        "scope_type": scope.scope_type.value,
        "scope_id": scope.scope_id,
        "OR": unexpired,
    }


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@runtime_checkable
class VaultTable(Protocol):
    """Structural view of the Prisma table actions, so tests inject a fake."""

    async def create_many(self, data: Sequence[Mapping[str, object]], skip_duplicates: bool) -> object: ...

    async def find_many(self, where: Mapping[str, object]) -> Sequence[Mapping[str, object]]: ...

    async def delete_many(self, where: Mapping[str, object]) -> object: ...


@dataclass(frozen=True, slots=True)
class PiiVaultRepository:
    """Every read is scope-filtered and expiry-filtered in the query itself."""

    table: VaultTable

    async def insert_many(self, rows: Sequence[VaultRow]) -> None:
        await self.table.create_many(
            data=[row_to_record(row) for row in rows],  # mutable-ok: Prisma takes a list
            skip_duplicates=True,
        )

    async def find_live(self, scope: VaultScope, token_ids: Sequence[str], now: datetime) -> tuple[VaultRow, ...]:
        if not token_ids:
            return ()
        where: Final = {  # mutable-ok: Prisma takes a plain dict
            **live_filter(scope, now),
            "token_id": {"in": list(token_ids)},  # mutable-ok: Prisma takes a list
        }
        records: Final = await self.table.find_many(where=where)
        parsed: Final = (record_to_row(record) for record in records)
        return tuple(row for row in parsed if row is not None)

    async def delete_session(self, scope: VaultScope, session_id: str) -> None:
        """Revocation for everything one encode call minted, in one statement."""
        where: Final = {  # mutable-ok: Prisma takes a plain dict
            "scope_type": scope.scope_type.value,
            "scope_id": scope.scope_id,
            "session_id": session_id,
        }
        await self.table.delete_many(where=where)

    async def delete_subject(self, scope: VaultScope, subject_id: str) -> None:
        where: Final = {  # mutable-ok: Prisma takes a plain dict
            "scope_type": scope.scope_type.value,
            "scope_id": scope.scope_id,
            "subject_id": subject_id,
        }
        await self.table.delete_many(where=where)

    async def find_subject(self, scope: VaultScope, subject_id: str, now: datetime) -> tuple[VaultRow, ...]:
        where: Final = {**live_filter(scope, now), "subject_id": subject_id}  # mutable-ok: Prisma takes a dict
        records: Final = await self.table.find_many(where=where)
        parsed: Final = (record_to_row(record) for record in records)
        return tuple(row for row in parsed if row is not None)

    async def sweep_expired(self, now: datetime) -> None:
        where: Final = {"expires_at": {"lt": now}}  # mutable-ok: Prisma takes a plain dict
        await self.table.delete_many(where=where)
