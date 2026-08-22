from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Final, assert_never

from litellm.pii.detection.base import PiiDetector
from litellm.pii.detection.spans import merge_spans
from litellm.pii.types import (
    DEFAULT_NER_SCORE_THRESHOLD,
    DetectionError,
    DetectionResult,
    PiiSpan,
)


class NerStagePolicy(str, Enum):
    NEVER = "never"
    ON_MISS = "on_miss"
    ON_LOW_CONFIDENCE = "on_low_confidence"
    ALWAYS = "always"


def _should_run_ner(
    policy: NerStagePolicy,
    rule_spans: tuple[PiiSpan, ...],
    low_confidence_threshold: float,
) -> bool:
    match policy:
        case NerStagePolicy.NEVER:
            return False
        case NerStagePolicy.ALWAYS:
            return True
        case NerStagePolicy.ON_MISS:
            return not rule_spans
        case NerStagePolicy.ON_LOW_CONFIDENCE:
            if not rule_spans:
                return True
            return max(span.score for span in rule_spans) < low_confidence_threshold
        case _:
            assert_never(policy)


@dataclass(frozen=True, slots=True)
class CascadingDetector:
    """Rule-based primary stage with a model-based stage behind a staging policy.

    ``fail_closed`` decides what a stage-1 outage means. When any entity is
    configured to block or encode, a detector we cannot reach must surface as an
    error rather than an empty result, or PII passes through unnoticed.
    """

    rules: PiiDetector
    ner: PiiDetector | None = None
    policy: NerStagePolicy = NerStagePolicy.ON_MISS
    low_confidence_threshold: float = DEFAULT_NER_SCORE_THRESHOLD
    fail_closed: bool = True

    async def detect(
        self,
        text: str,
        language: str = "en",
        entities: Sequence[str] | None = None,
    ) -> DetectionResult | DetectionError:
        rule_result: Final = await self.rules.detect(text=text, language=language, entities=entities)
        if not isinstance(rule_result, tuple):
            if self.fail_closed:
                return rule_result
            return DetectionResult(spans=(), ner_stage_ran=False)

        if self.ner is None or not _should_run_ner(self.policy, rule_result, self.low_confidence_threshold):
            return DetectionResult(spans=merge_spans(text, rule_result), ner_stage_ran=False)

        ner_result: Final = await self.ner.detect(text=text, language=language, entities=entities)
        if not isinstance(ner_result, tuple):
            if self.fail_closed:
                return ner_result
            return DetectionResult(spans=merge_spans(text, rule_result), ner_stage_ran=False)

        return DetectionResult(spans=merge_spans(text, rule_result, ner_result), ner_stage_ran=True)
