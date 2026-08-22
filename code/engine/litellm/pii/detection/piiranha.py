from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final

from litellm.pii.detection.http import (
    HttpxJsonPoster,
    JsonPoster,
    JsonResponse,
    TransportFailure,
)
from litellm.pii.detection.piiranha_labels import map_label
from litellm.pii.types import (
    DEFAULT_NER_SCORE_THRESHOLD,
    DetectionError,
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    PiiSpan,
)


def _unwrap_batch(body: object) -> tuple[object, ...] | None:
    """Accept both a flat prediction list and a batch-of-one nesting."""
    if not isinstance(body, list):
        return None
    if len(body) == 1 and isinstance(body[0], list):
        return tuple(body[0])
    return tuple(body)


def _parse_prediction(item: object, threshold: float) -> PiiSpan | None:
    if not isinstance(item, Mapping):
        return None
    raw_label: Final = item.get("entity_group") or item.get("entity")
    start: Final = item.get("start")
    end: Final = item.get("end")
    score: Final = item.get("score", 0.0)
    if not isinstance(raw_label, str) or not isinstance(start, int) or not isinstance(end, int):
        return None
    if not isinstance(score, (int, float)) or float(score) < threshold or end <= start:
        return None
    entity_type: Final = map_label(raw_label)
    if entity_type is None:
        return None
    return PiiSpan(
        entity_type=entity_type,
        start=start,
        end=end,
        score=float(score),
        detector=DetectorKind.NER,
    )


@dataclass(frozen=True, slots=True)
class PiiranhaDetector:
    """Stage 2: model-based detection via a token-classification inference server.

    Speaks the standard HuggingFace token-classification pipeline contract
    (``{"inputs": text}`` in, ``[{entity_group, score, start, end}]`` out), so
    it works unchanged against HF Inference Endpoints, TorchServe, or a thin
    ``transformers`` wrapper.
    """

    api_base: str
    poster: JsonPoster = field(default_factory=HttpxJsonPoster)
    score_threshold: float = DEFAULT_NER_SCORE_THRESHOLD
    api_key: str | None = None

    async def detect(
        self,
        text: str,
        language: str,
        entities: Sequence[str] | None,
    ) -> tuple[PiiSpan, ...] | DetectionError:
        if not text.strip():
            return ()

        result: Final = await self.poster.post_json(self.api_base, MappingProxyType({"inputs": text}))

        match result:
            case TransportFailure(reason=reason):
                return DetectorUnavailable(detector=DetectorKind.NER, reason=reason)
            case JsonResponse(status_code=status, body=body):
                if status >= 400:
                    return DetectorUnavailable(
                        detector=DetectorKind.NER,
                        reason=f"HTTP {status} from NER inference server",
                    )
                if isinstance(body, Mapping) and "error" in body:
                    return DetectorInvalidResponse(
                        detector=DetectorKind.NER,
                        reason=f"inference error: {body.get('error')}",
                    )
                predictions: Final = _unwrap_batch(body)
                if predictions is None:
                    return DetectorInvalidResponse(
                        detector=DetectorKind.NER,
                        reason=f"expected list, received {type(body).__name__}",
                    )
                parsed: Final = (_parse_prediction(item, self.score_threshold) for item in predictions)
                spans: Final = tuple(span for span in parsed if span is not None)
                requested: Final = frozenset(entities) if entities else None
                if requested is None:
                    return spans
                return tuple(span for span in spans if span.entity_type in requested)
