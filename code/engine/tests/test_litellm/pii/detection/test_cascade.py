import pytest

from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.types import (
    DetectionResult,
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    PiiSpan,
)


class RecordingDetector:
    """Fake stage, injected instead of monkeypatching a real detector."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    async def detect(self, text, language, entities):
        self.calls.append((text, language, entities))
        return self.result


def span(entity_type="PERSON", start=0, end=4, score=0.9, detector=DetectorKind.RULES):
    return PiiSpan(entity_type=entity_type, start=start, end=end, score=score, detector=detector)


TEXT = "Ada Lovelace ada@example.com"


class TestStagingPolicy:
    @pytest.mark.asyncio
    async def test_never_policy_skips_ner_even_when_rules_miss(self):
        rules = RecordingDetector(())
        ner = RecordingDetector((span(detector=DetectorKind.NER),))
        result = await CascadingDetector(rules=rules, ner=ner, policy=NerStagePolicy.NEVER).detect(TEXT)
        assert ner.calls == []
        assert result == DetectionResult(spans=(), ner_stage_ran=False)

    @pytest.mark.asyncio
    async def test_on_miss_skips_ner_when_rules_hit(self):
        rules = RecordingDetector((span("EMAIL_ADDRESS", 13, 28),))
        ner = RecordingDetector((span(detector=DetectorKind.NER),))
        result = await CascadingDetector(rules=rules, ner=ner, policy=NerStagePolicy.ON_MISS).detect(TEXT)
        assert ner.calls == []
        assert result.ner_stage_ran is False
        assert result.spans == (span("EMAIL_ADDRESS", 13, 28),)

    @pytest.mark.asyncio
    async def test_on_miss_runs_ner_when_rules_find_nothing(self):
        rules = RecordingDetector(())
        ner = RecordingDetector((span(detector=DetectorKind.NER),))
        result = await CascadingDetector(rules=rules, ner=ner, policy=NerStagePolicy.ON_MISS).detect(TEXT)
        assert len(ner.calls) == 1
        assert result.ner_stage_ran is True
        assert result.spans == (span(detector=DetectorKind.NER),)

    @pytest.mark.asyncio
    async def test_always_runs_ner_even_when_rules_hit(self):
        rules = RecordingDetector((span("EMAIL_ADDRESS", 13, 28),))
        ner = RecordingDetector((span("PERSON", 0, 12, detector=DetectorKind.NER),))
        result = await CascadingDetector(rules=rules, ner=ner, policy=NerStagePolicy.ALWAYS).detect(TEXT)
        assert len(ner.calls) == 1
        assert result.ner_stage_ran is True
        assert {s.entity_type for s in result.spans} == {"EMAIL_ADDRESS", "PERSON"}

    @pytest.mark.asyncio
    async def test_low_confidence_runs_ner_below_threshold(self):
        rules = RecordingDetector((span("EMAIL_ADDRESS", 13, 28, score=0.3),))
        ner = RecordingDetector(())
        result = await CascadingDetector(
            rules=rules, ner=ner, policy=NerStagePolicy.ON_LOW_CONFIDENCE, low_confidence_threshold=0.6
        ).detect(TEXT)
        assert len(ner.calls) == 1
        assert result.ner_stage_ran is True

    @pytest.mark.asyncio
    async def test_low_confidence_skips_ner_at_or_above_threshold(self):
        rules = RecordingDetector((span("EMAIL_ADDRESS", 13, 28, score=0.6),))
        ner = RecordingDetector(())
        result = await CascadingDetector(
            rules=rules, ner=ner, policy=NerStagePolicy.ON_LOW_CONFIDENCE, low_confidence_threshold=0.6
        ).detect(TEXT)
        assert ner.calls == []
        assert result.ner_stage_ran is False

    @pytest.mark.asyncio
    async def test_missing_ner_stage_never_runs_stage_two(self):
        rules = RecordingDetector(())
        result = await CascadingDetector(rules=rules, ner=None, policy=NerStagePolicy.ALWAYS).detect(TEXT)
        assert result == DetectionResult(spans=(), ner_stage_ran=False)


class TestFailurePropagation:
    @pytest.mark.asyncio
    async def test_fail_closed_surfaces_rules_outage(self):
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503")
        result = await CascadingDetector(rules=RecordingDetector(error), fail_closed=True).detect(TEXT)
        assert result == error

    @pytest.mark.asyncio
    async def test_fail_closed_never_calls_ner_after_rules_outage(self):
        ner = RecordingDetector(())
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503")
        await CascadingDetector(rules=RecordingDetector(error), ner=ner, fail_closed=True).detect(TEXT)
        assert ner.calls == []

    @pytest.mark.asyncio
    async def test_fail_open_degrades_to_empty_on_rules_outage(self):
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503")
        result = await CascadingDetector(rules=RecordingDetector(error), fail_closed=False).detect(TEXT)
        assert result == DetectionResult(spans=(), ner_stage_ran=False)

    @pytest.mark.asyncio
    async def test_fail_closed_surfaces_ner_outage(self):
        error = DetectorInvalidResponse(detector=DetectorKind.NER, reason="expected list")
        result = await CascadingDetector(
            rules=RecordingDetector(()), ner=RecordingDetector(error), fail_closed=True
        ).detect(TEXT)
        assert result == error

    @pytest.mark.asyncio
    async def test_fail_open_keeps_rule_spans_when_ner_fails(self):
        rule_spans = (span("EMAIL_ADDRESS", 13, 28),)
        error = DetectorUnavailable(detector=DetectorKind.NER, reason="timeout")
        result = await CascadingDetector(
            rules=RecordingDetector(rule_spans),
            ner=RecordingDetector(error),
            policy=NerStagePolicy.ALWAYS,
            fail_closed=False,
        ).detect(TEXT)
        assert result == DetectionResult(spans=rule_spans, ner_stage_ran=False)


class TestArgumentForwarding:
    @pytest.mark.asyncio
    async def test_language_and_entities_reach_both_stages(self):
        rules = RecordingDetector(())
        ner = RecordingDetector(())
        await CascadingDetector(rules=rules, ner=ner, policy=NerStagePolicy.ALWAYS).detect(
            TEXT, language="de", entities=["PERSON"]
        )
        assert rules.calls == [(TEXT, "de", ["PERSON"])]
        assert ner.calls == [(TEXT, "de", ["PERSON"])]
