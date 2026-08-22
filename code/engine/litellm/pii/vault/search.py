import asyncio
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from types import MappingProxyType
from typing import Final, Protocol, assert_never, runtime_checkable

from litellm.pii.types import KeyUnavailable, SearchError, SearchRefused, StoreError
from litellm.pii.vault.cipher import SealedValue, VaultCipher, open_sealed
from litellm.pii.vault.repository import PiiVaultRepository, VaultRow, utcnow
from litellm.pii.vault.scope import VaultScope
from litellm.pii.vault.store import guarded

PAGE_SIZE: Final = 1000
DEFAULT_CANDIDATE_CAP: Final = 100_000


class MatchMode(str, Enum):
    EXACT = "exact"
    NORMALIZED = "normalized"
    SUBSTRING = "substring"


def normalize(text: str) -> str:
    """Case-fold, strip accents, collapse whitespace.

    So "Ada  Lovelace" and "ada lovelacé" are the same query. Applied to the
    stored value only after it is decrypted, never before it is encrypted.
    """
    decomposed: Final = unicodedata.normalize("NFKD", text)
    stripped: Final = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(stripped.casefold().split())


def matches(value: str, query: str, normalized_query: str, mode: MatchMode) -> bool:
    match mode:
        case MatchMode.EXACT:
            return value == query
        case MatchMode.NORMALIZED:
            return normalize(value) == normalized_query
        case MatchMode.SUBSTRING:
            return normalized_query in normalize(value)
        case _:
            assert_never(mode)


@dataclass(frozen=True, slots=True)
class SearchHit:
    token: str
    entity_type: str
    session_id: str | None
    subject_id: str | None


@dataclass(frozen=True, slots=True)
class SearchResult:
    hits: tuple[SearchHit, ...]
    scanned: int


@runtime_checkable
class PiiSearchIndex(Protocol):
    """Terms the vault stores alongside a row so a scope can be searched without a scan.

    The vault stores whatever terms it is handed and knows nothing about how they
    were derived, which is what keeps a blind index a deployment decision.
    """

    def index_terms(self, scope: VaultScope, entity_type: str, plaintext: str) -> tuple[str, ...]: ...

    def query_terms(self, scope: VaultScope, entity_type: str, query: str) -> tuple[str, ...]: ...


@dataclass(frozen=True, slots=True)
class NullSearchIndex:
    """The default: writes nothing, so no equality information is ever stored.

    With no terms to narrow on, search falls back to the filtered scan, which is
    the design's recommended path and the only one that does substring matching.
    """

    def index_terms(self, scope: VaultScope, entity_type: str, plaintext: str) -> tuple[str, ...]:
        return ()

    def query_terms(self, scope: VaultScope, entity_type: str, query: str) -> tuple[str, ...]:
        return ()


def _hits_in(
    rows: Sequence[VaultRow],
    keys: Mapping[int, bytes],
    scope: VaultScope,
    query: str,
    normalized_query: str,
    mode: MatchMode,
) -> tuple[SearchHit, ...]:
    """Decrypt and compare. Sync so a whole page can run on a worker thread."""
    opened: Final = (
        (row, open_sealed(keys[row.key_version], SealedValue(row.ciphertext, row.key_version), row.token_id, scope))
        for row in rows
        if row.key_version in keys
    )
    return tuple(
        SearchHit(
            token=row.token_id,
            entity_type=row.entity_type,
            session_id=row.session_id,
            subject_id=row.subject_id,
        )
        for row, value in opened
        if isinstance(value, str) and matches(value, query, normalized_query, mode)
    )


@dataclass(frozen=True, slots=True)
class VaultSearch:
    """Filtered exhaustive scan: narrow on metadata, then decrypt and compare.

    Nothing derived from a value is ever written down, so the database leaks no
    equality information at all. The authorization boundary doubles as the
    performance boundary: a key-scoped search touches only that key's rows.
    """

    repository: PiiVaultRepository
    cipher: VaultCipher
    candidate_cap: int = DEFAULT_CANDIDATE_CAP
    page_size: int = PAGE_SIZE

    async def _keys_for(self, scope: VaultScope, rows: Sequence[VaultRow]) -> Mapping[int, bytes] | KeyUnavailable:
        """One key derivation per version per page, not one per row."""
        versions: Final = sorted(frozenset(row.key_version for row in rows))
        fetched: Final = tuple([(version, await self.cipher.checked_key(scope, version)) for version in versions])
        failure: Final = next((key for _, key in fetched if not isinstance(key, bytes)), None)
        if failure is not None:
            return failure
        return MappingProxyType({version: key for version, key in fetched if isinstance(key, bytes)})

    async def _page(
        self,
        scope: VaultScope,
        query: str,
        normalized_query: str,
        mode: MatchMode,
        entity_type: str | None,
        subject_id: str | None,
        now: datetime,
        cursor: str | None,
    ) -> "_Page | StoreError | KeyUnavailable":
        """One page: fetch, derive its keys, then decrypt and compare off the event loop."""
        rows: Final = await guarded(
            self.repository.scan(
                scope=scope,
                now=now,
                limit=self.page_size,
                entity_type=entity_type,
                subject_id=subject_id,
                after_token_id=cursor,
            ),
            "search",
        )
        if not isinstance(rows, tuple):
            return rows
        if not rows:
            return _Page(hits=(), cursor=None, count=0)

        keys: Final = await self._keys_for(scope, rows)
        if not isinstance(keys, Mapping):
            return keys

        hits: Final = await asyncio.to_thread(_hits_in, rows, keys, scope, query, normalized_query, mode)
        return _Page(hits=hits, cursor=rows[-1].token_id, count=len(rows))

    async def search(
        self,
        scope: VaultScope,
        query: str,
        mode: MatchMode = MatchMode.NORMALIZED,
        entity_type: str | None = None,
        subject_id: str | None = None,
    ) -> SearchResult | StoreError | SearchError | KeyUnavailable:
        """Walk the scope one page at a time; never hold more than a page of rows."""
        normalized_query: Final = normalize(query)
        now: Final = utcnow()
        found: Final[list[SearchHit]] = []  # mutable-ok: the accumulator of an unbounded walk
        state = _Walk()  # rebind-ok: the keyset position and running count advance per page

        while True:
            page = await self._page(  # rebind-ok: one page at a time is the point of the walk
                scope, query, normalized_query, mode, entity_type, subject_id, now, state.cursor
            )
            if not isinstance(page, _Page):
                return page
            if page.cursor is None:
                return SearchResult(hits=tuple(found), scanned=state.scanned)

            state = state.advance(page)
            if state.scanned > self.candidate_cap:
                return SearchRefused(scanned=state.scanned, limit=self.candidate_cap)
            found.extend(page.hits)


@dataclass(frozen=True, slots=True)
class _Page:
    hits: tuple[SearchHit, ...]
    cursor: str | None
    count: int


@dataclass(frozen=True, slots=True)
class _Walk:
    cursor: str | None = None
    scanned: int = 0

    def advance(self, page: _Page) -> "_Walk":
        return _Walk(cursor=page.cursor, scanned=self.scanned + page.count)
