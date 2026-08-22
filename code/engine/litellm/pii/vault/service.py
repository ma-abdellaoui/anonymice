from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from litellm.pii.codec.transform import decode_text
from litellm.pii.service import DraftedBatch, EncodedBatch, EncodeFailure, PiiService
from litellm.pii.types import StoreError
from litellm.pii.vault.scope import VaultScope
from litellm.pii.vault.store import DatabaseTokenStore, MintRequest


@dataclass(frozen=True, slots=True)
class DecodedBatch:
    texts: tuple[str, ...]
    resolved: int


@dataclass(frozen=True, slots=True)
class VaultService:
    """The persistent path: the same detection and token space, a durable store.

    Composition rather than a shared store protocol. The vault needs the
    security scope, the entity type, the session, and the subject, none of which
    a cache entry keyed by token has any place for.
    """

    pii: PiiService
    store: DatabaseTokenStore

    async def encode(
        self,
        texts: Sequence[str],
        scope: VaultScope,
        session_id: str,
        subject_id: str | None = None,
        created_by: str | None = None,
        language: str = "en",
        entities: Sequence[str] | None = None,
    ) -> EncodedBatch | EncodeFailure:
        drafted: Final = await self.pii.draft(texts, language, entities)
        if not isinstance(drafted, DraftedBatch):
            return drafted

        mints: Final = tuple(
            MintRequest(token=issued.token, entity_type=issued.entity_type, value=drafted.draft.mapping[issued.token])
            for issued in drafted.draft.tokens
            if issued.token in drafted.draft.mapping
        )
        stored: Final = await self.store.put_many(
            scope=scope,
            session_id=session_id,
            mints=mints,
            subject_id=subject_id,
            created_by=created_by,
        )
        if stored is not None:
            return stored

        return EncodedBatch(
            texts=drafted.draft.texts,
            tokens=drafted.draft.tokens,
            session_id=session_id,
            spans_by_text=drafted.spans_by_text,
        )

    async def decode(self, texts: Sequence[str], scope: VaultScope) -> DecodedBatch | StoreError:
        """Resolve every token the scope owns, and report how many were resolved.

        The count is what the audit entry records, so it has to come from the
        read itself rather than from counting tokens in the request.
        """
        candidates: Final = tuple(sorted(self.pii.codec.grammar.canonical_tokens(texts)))
        if not candidates:
            return DecodedBatch(texts=tuple(texts), resolved=0)

        recovered: Final = self.pii.self_contained(candidates)
        deferred: Final = tuple(token for token in candidates if token not in recovered)
        stored: Final = await self.store.get_many(scope, deferred)
        if not isinstance(stored, Mapping):
            return stored

        resolved: Final = MappingProxyType({**recovered, **stored})
        return DecodedBatch(
            texts=tuple(decode_text(text, resolved, self.pii.codec.grammar) for text in texts),
            resolved=len(resolved),
        )

    async def revoke_session(self, scope: VaultScope, session_id: str) -> None | StoreError:
        return await self.store.revoke_session(scope, session_id)

    async def revoke_subject(self, scope: VaultScope, subject_id: str) -> None | StoreError:
        return await self.store.revoke_subject(scope, subject_id)

    async def export_subject(self, scope: VaultScope, subject_id: str) -> Mapping[str, str] | StoreError:
        return await self.store.export_subject(scope, subject_id)
