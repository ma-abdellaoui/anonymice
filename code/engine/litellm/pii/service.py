import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, TypeAlias

from litellm._uuid import uuid
from litellm.pii.codec.base import PiiCodec, find_tokens
from litellm.pii.codec.transform import BatchDraft, decode_text, encode_batch
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

    async def encode(
        self,
        texts: Sequence[str],
        scope: TokenScope,
        language: str = "en",
        entities: Sequence[str] | None = None,
        is_reversible: Callable[[PiiSpan], bool] | None = None,
    ) -> EncodedBatch | EncodeFailure:
        detected: Final = await self.detect_many(texts=texts, language=language, entities=entities)
        if not isinstance(detected, tuple):
            return detected

        spans_by_text: Final = tuple(result.spans for result in detected)
        draft: Final = encode_batch(
            texts=texts, spans_by_text=spans_by_text, codec=self.codec, is_reversible=is_reversible
        )
        if not isinstance(draft, BatchDraft):
            return draft

        if draft.mapping:
            stored: Final = await self.store.put_many(scope, draft.mapping)
            if stored is not None:
                return stored

        return EncodedBatch(
            texts=draft.texts,
            tokens=draft.tokens,
            session_id=scope.session_id,
            spans_by_text=spans_by_text,
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

    async def _resolve(self, token: str, scope: TokenScope) -> tuple[str, str] | StoreError | None:
        recovered: Final = self.codec.recover(token)
        if isinstance(recovered, str):
            return (token, recovered)
        if recovered is not None:
            return None

        stored: Final = await self.store.get(scope, token)
        if stored is None:
            return None
        if isinstance(stored, str):
            return (token, stored)
        return stored

    async def decode(self, texts: Sequence[str], scope: TokenScope) -> tuple[str, ...] | DecodeFailure:
        """Restore original values for every token this scope can resolve.

        A token the store has never heard of is left verbatim rather than
        treated as an error: a stale or truncated token should degrade to
        showing the placeholder, not fail the whole response. A store *outage*
        is different and does surface, since silently returning tokenized text
        would look like success.
        """
        candidates: Final = frozenset(found.token for text in texts for found in find_tokens(text))
        if not candidates:
            return tuple(texts)

        resolutions: Final = await asyncio.gather(*(self._resolve(token, scope) for token in sorted(candidates)))
        outage: Final = next((r for r in resolutions if not isinstance(r, (tuple, type(None)))), None)
        if outage is not None:
            return outage

        resolved: Final = MappingProxyType(
            {token: value for token, value in (r for r in resolutions if isinstance(r, tuple))}
        )
        return tuple(decode_text(text, resolved) for text in texts)

    async def decode_one(self, text: str, scope: TokenScope) -> str | DecodeFailure:
        decoded: Final = await self.decode(texts=(text,), scope=scope)
        if not isinstance(decoded, tuple):
            return decoded
        return decoded[0]
