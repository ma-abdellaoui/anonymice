import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, TypeAlias

from litellm._uuid import uuid
from litellm.pii.codec.base import PiiCodec
from litellm.pii.codec.transform import BatchDraft, Placement, decode_text, encode_batch
from litellm.pii.detection.cascade import CascadingDetector
from litellm.pii.store.base import PiiTokenStore, TokenScope
from litellm.pii.types import (
    CodecError,
    DetectionError,
    DetectionResult,
    EncodedText,
    IssuedToken,
    PiiSpan,
    StoreError,
)

EncodeFailure: TypeAlias = DetectionError | CodecError | StoreError
DecodeFailure: TypeAlias = StoreError | CodecError


@dataclass(frozen=True, slots=True)
class EncodedBatch:
    texts: tuple[str, ...]
    tokens: tuple[IssuedToken, ...]
    session_id: str
    spans_by_text: tuple[tuple[PiiSpan, ...], ...]
    placements: tuple[Placement, ...] = ()
    ner_stage_ran: bool = False


@dataclass(frozen=True, slots=True)
class DraftedBatch:
    """Tokenized text that has not been persisted yet.

    The split exists so the ephemeral and the vault paths share one detection
    and one token space while writing to stores whose signatures differ.
    """

    draft: BatchDraft
    spans_by_text: tuple[tuple[PiiSpan, ...], ...]
    ner_stage_ran: bool = False


def new_session_id() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True, slots=True)
class PiiService:
    """The single implementation of detect, encode, and decode.

    The guardrail hook and the REST endpoints are both thin adapters over this
    class, so the behaviour a browser extension sees through ``/pii/encode`` is
    by construction the behaviour applied to an in-flight LLM request.
    """

    detector: CascadingDetector
    codec: PiiCodec
    store: PiiTokenStore

    async def detect(
        self,
        text: str,
        language: str = "en",
        entities: Sequence[str] | None = None,
    ) -> DetectionResult | DetectionError:
        return await self.detector.detect(text=text, language=language, entities=entities)

    async def detect_many(
        self,
        texts: Sequence[str],
        language: str = "en",
        entities: Sequence[str] | None = None,
    ) -> tuple[DetectionResult, ...] | DetectionError:
        results: Final = await asyncio.gather(
            *(self.detector.detect(text=text, language=language, entities=entities) for text in texts)
        )
        failure: Final = next((r for r in results if not isinstance(r, DetectionResult)), None)
        if failure is not None:
            return failure
        return tuple(r for r in results if isinstance(r, DetectionResult))

    async def draft(
        self,
        texts: Sequence[str],
        language: str = "en",
        entities: Sequence[str] | None = None,
        is_reversible: Callable[[PiiSpan], bool] | None = None,
    ) -> DraftedBatch | DetectionError | CodecError:
        """Detect and tokenize without storing, so either store can take the result."""
        detected: Final = await self.detect_many(texts=texts, language=language, entities=entities)
        if not isinstance(detected, tuple):
            return detected

        spans_by_text: Final = tuple(result.spans for result in detected)
        drafted: Final = encode_batch(
            texts=texts, spans_by_text=spans_by_text, codec=self.codec, is_reversible=is_reversible
        )
        if not isinstance(drafted, BatchDraft):
            return drafted
        return DraftedBatch(
            draft=drafted,
            spans_by_text=spans_by_text,
            ner_stage_ran=any(result.ner_stage_ran for result in detected),
        )

    async def encode(
        self,
        texts: Sequence[str],
        scope: TokenScope,
        language: str = "en",
        entities: Sequence[str] | None = None,
        is_reversible: Callable[[PiiSpan], bool] | None = None,
    ) -> EncodedBatch | EncodeFailure:
        drafted: Final = await self.draft(texts, language, entities, is_reversible)
        if not isinstance(drafted, DraftedBatch):
            return drafted

        if drafted.draft.mapping:
            stored: Final = await self.store.put_many(scope, drafted.draft.mapping)
            if stored is not None:
                return stored

        return EncodedBatch(
            texts=drafted.draft.texts,
            tokens=drafted.draft.tokens,
            session_id=scope.session_id,
            spans_by_text=drafted.spans_by_text,
            placements=drafted.draft.placements,
            ner_stage_ran=drafted.ner_stage_ran,
        )

    async def encode_one(
        self,
        text: str,
        scope: TokenScope,
        language: str = "en",
        entities: Sequence[str] | None = None,
    ) -> EncodedText | EncodeFailure:
        batch: Final = await self.encode(texts=(text,), scope=scope, language=language, entities=entities)
        if not isinstance(batch, EncodedBatch):
            return batch
        return EncodedText(text=batch.texts[0], tokens=batch.tokens, session_id=batch.session_id)

    def self_contained(self, tokens: Sequence[str]) -> Mapping[str, str]:
        """Values the codec recovers from the token alone, needing no store.

        A codec error is not propagated: an unopenable token is left verbatim.
        """
        recovered: Final = tuple((token, self.codec.recover(token)) for token in tokens)
        return MappingProxyType({token: value for token, value in recovered if isinstance(value, str)})

    async def decode(self, texts: Sequence[str], scope: TokenScope) -> tuple[str, ...] | DecodeFailure:
        """Restore original values for every token this scope can resolve.

        A token the store has never heard of is left verbatim rather than
        treated as an error: a stale or truncated token should degrade to
        showing the placeholder, not fail the whole response. A store *outage*
        is different and does surface, since silently returning tokenized text
        would look like success.
        """
        candidates: Final = tuple(sorted(self.codec.grammar.canonical_tokens(texts)))
        if not candidates:
            return tuple(texts)

        recovered: Final = self.self_contained(candidates)
        deferred: Final = tuple(token for token in candidates if token not in recovered)
        stored: Final = await self.store.get_many(scope, deferred)
        if not isinstance(stored, Mapping):
            return stored

        resolved: Final = MappingProxyType({**recovered, **stored})
        return tuple(decode_text(text, resolved, self.codec.grammar) for text in texts)

    async def decode_one(self, text: str, scope: TokenScope) -> str | DecodeFailure:
        decoded: Final = await self.decode(texts=(text,), scope=scope)
        if not isinstance(decoded, tuple):
            return decoded
        return decoded[0]
