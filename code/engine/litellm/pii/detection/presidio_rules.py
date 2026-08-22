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
from litellm.pii.types import (
    DetectionError,
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    PiiSpan,
)

RULE_BASED_ENTITIES: Final[frozenset[str]] = frozenset(
    {
        "CREDIT_CARD",
        "CRYPTO",
        "EMAIL_ADDRESS",
        "IBAN_CODE",
        "IP_ADDRESS",
        "MEDICAL_LICENSE",
        "PHONE_NUMBER",
        "URL",
        "US_BANK_NUMBER",
        "US_DRIVER_LICENSE",
        "US_ITIN",
        "US_PASSPORT",
        "US_SSN",
        "UK_NHS",
        "UK_NINO",
        "UK_PASSPORT",
        "UK_POSTCODE",
        "UK_VEHICLE_REGISTRATION",
        "ES_NIF",
        "ES_NIE",
        "IT_FISCAL_CODE",
        "IT_DRIVER_LICENSE",
        "IT_VAT_CODE",
        "IT_PASSPORT",
        "IT_IDENTITY_CARD",
        "PL_PESEL",
        "SG_NRIC_FIN",
        "SG_UEN",
        "AU_ABN",
        "AU_ACN",
        "AU_TFN",
        "AU_MEDICARE",
        "IN_PAN",
        "IN_AADHAAR",
        "IN_VEHICLE_REGISTRATION",
        "IN_VOTER",
        "IN_PASSPORT",
        "FI_PERSONAL_IDENTITY_CODE",
    }
)


def _normalize_base_url(api_base: str) -> str:
    with_scheme: Final = api_base if api_base.startswith(("http://", "https://")) else f"http://{api_base}"
    return with_scheme if with_scheme.endswith("/") else f"{with_scheme}/"


def _parse_item(item: object) -> PiiSpan | None:
    if not isinstance(item, Mapping):
        return None
    entity_type: Final = item.get("entity_type")
    start: Final = item.get("start")
    end: Final = item.get("end")
    score: Final = item.get("score", 0.0)
    if not isinstance(entity_type, str) or not isinstance(start, int) or not isinstance(end, int):
        return None
    if not isinstance(score, (int, float)) or end <= start:
        return None
    return PiiSpan(
        entity_type=entity_type,
        start=start,
        end=end,
        score=float(score),
        detector=DetectorKind.RULES,
    )


@dataclass(frozen=True, slots=True)
class PresidioRulesDetector:
    """Stage 1: Presidio pattern and checksum recognizers.

    Deterministic, no model, low latency. The entity list is pinned to the
    pattern-based recognizers so a Presidio deployment that also loads an NLP
    engine cannot silently return NER entities from this stage.
    """

    analyzer_api_base: str
    poster: JsonPoster = field(default_factory=HttpxJsonPoster)
    ad_hoc_recognizers: tuple[Mapping[str, object], ...] | None = None
    score_threshold: float | None = None

    async def detect(
        self,
        text: str,
        language: str,
        entities: Sequence[str] | None,
    ) -> tuple[PiiSpan, ...] | DetectionError:
        if not text.strip():
            return ()

        requested: Final = frozenset(entities) & RULE_BASED_ENTITIES if entities else RULE_BASED_ENTITIES
        if not requested:
            return ()

        optional: Final = tuple(
            entry
            for entry in (
                ("score_threshold", self.score_threshold) if self.score_threshold is not None else None,
                ("ad_hoc_recognizers", self.ad_hoc_recognizers) if self.ad_hoc_recognizers else None,
            )
            if entry is not None
        )
        payload: Final[Mapping[str, object]] = MappingProxyType(
            {
                "text": text,
                "language": language,
                "entities": tuple(sorted(requested)),
                **dict(optional),  # mutable-ok: spread into the MappingProxyType wrapping this literal
            }
        )
        url: Final = f"{_normalize_base_url(self.analyzer_api_base)}analyze"
        result: Final = await self.poster.post_json(url, payload)

        match result:
            case TransportFailure(reason=reason):
                return DetectorUnavailable(detector=DetectorKind.RULES, reason=reason)
            case JsonResponse(status_code=status, body=body):
                if status >= 400:
                    return DetectorUnavailable(
                        detector=DetectorKind.RULES,
                        reason=f"HTTP {status} from Presidio analyzer",
                    )
                if isinstance(body, Mapping) and "error" in body:
                    return DetectorInvalidResponse(
                        detector=DetectorKind.RULES,
                        reason=f"analyzer error: {body.get('error')}",
                    )
                if not isinstance(body, list):
                    return DetectorInvalidResponse(
                        detector=DetectorKind.RULES,
                        reason=f"expected list, received {type(body).__name__}",
                    )
                return tuple(span for span in (_parse_item(item) for item in body) if span is not None)
