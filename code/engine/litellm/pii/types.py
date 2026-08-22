from dataclasses import dataclass
from enum import Enum
from typing import Final, Literal, TypeAlias


class DetectorKind(str, Enum):
    RULES = "rules"
    NER = "ner"


@dataclass(frozen=True, slots=True)
class PiiSpan:
    """A single detected PII occurrence.

    ``start`` and ``end`` always index the *original* text. Mixing these with
    offsets taken from anonymized output is the defect class this type exists
    to rule out, so never reuse a span against rewritten text.
    """

    entity_type: str
    start: int
    end: int
    score: float
    detector: DetectorKind

    @property
    def length(self) -> int:
        return self.end - self.start

    def text_from(self, source: str) -> str:
        return source[self.start : self.end]


@dataclass(frozen=True, slots=True)
class DetectionResult:
    spans: tuple[PiiSpan, ...]
    ner_stage_ran: bool


@dataclass(frozen=True, slots=True)
class DetectorUnavailable:
    kind: Literal["detector_unavailable"] = "detector_unavailable"
    detector: DetectorKind = DetectorKind.RULES
    reason: str = ""


@dataclass(frozen=True, slots=True)
class DetectorInvalidResponse:
    kind: Literal["detector_invalid_response"] = "detector_invalid_response"
    detector: DetectorKind = DetectorKind.RULES
    reason: str = ""


DetectionError: TypeAlias = DetectorUnavailable | DetectorInvalidResponse


@dataclass(frozen=True, slots=True)
class IssuedToken:
    token: str
    entity_type: str
    codec_id: str


@dataclass(frozen=True, slots=True)
class EncodedText:
    text: str
    tokens: tuple[IssuedToken, ...]
    session_id: str


@dataclass(frozen=True, slots=True)
class UnknownToken:
    token: str
    kind: Literal["unknown_token"] = "unknown_token"


@dataclass(frozen=True, slots=True)
class KeyUnavailable:
    reason: str
    kind: Literal["key_unavailable"] = "key_unavailable"


@dataclass(frozen=True, slots=True)
class DecodeFailed:
    reason: str
    kind: Literal["decode_failed"] = "decode_failed"


CodecError: TypeAlias = UnknownToken | KeyUnavailable | DecodeFailed


@dataclass(frozen=True, slots=True)
class StoreUnavailable:
    reason: str
    kind: Literal["store_unavailable"] = "store_unavailable"


StoreError: TypeAlias = StoreUnavailable

DEFAULT_NER_SCORE_THRESHOLD: Final = 0.5
