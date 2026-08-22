"""The NER stage is mandatory, and an unconfigured detector must never forward."""

import pytest

from litellm.pii.config import (
    DEFAULT_NER_STAGE_POLICY,
    ENV_NER_API_BASE,
    ENV_REQUIRE_NER,
    PiiSettings,
    build_detector,
    unmet_requirement,
)
from litellm.pii.detection.cascade import NerStagePolicy

CONFIGURED = PiiSettings(analyzer_api_base="http://presidio:3000", ner_api_base="http://piiranha:8080")
RULES_ONLY = PiiSettings(analyzer_api_base="http://presidio:3000")


class TestNerIsMandatory:
    def test_a_rules_only_deployment_is_refused(self):
        assert unmet_requirement(RULES_ONLY) is not None

    def test_the_refusal_names_the_missing_setting(self):
        assert ENV_NER_API_BASE in (unmet_requirement(RULES_ONLY) or "")

    def test_the_refusal_says_what_would_leak(self):
        assert "clear" in (unmet_requirement(RULES_ONLY) or "")

    def test_no_detector_is_built_without_the_ner_stage(self):
        assert build_detector(RULES_ONLY) is None

    def test_a_fully_configured_deployment_builds(self):
        assert build_detector(CONFIGURED) is not None

    def test_a_missing_analyzer_is_still_refused(self):
        assert unmet_requirement(PiiSettings(ner_api_base="http://piiranha:8080")) is not None

    def test_rules_only_can_be_chosen_deliberately(self):
        relaxed = PiiSettings(analyzer_api_base="http://presidio:3000", require_ner=False)
        assert unmet_requirement(relaxed) is None
        assert build_detector(relaxed) is not None

    def test_requiring_ner_is_the_default(self):
        assert PiiSettings().require_ner is True

    @pytest.mark.parametrize("raw", ["false", "FALSE", "0", "no", "off"])
    def test_the_requirement_can_be_turned_off_by_env(self, monkeypatch, raw):
        monkeypatch.setenv(ENV_REQUIRE_NER, raw)
        assert PiiSettings.from_env().require_ner is False

    @pytest.mark.parametrize("raw", ["true", "1", "yes", "anything-else"])
    def test_anything_else_leaves_it_required(self, monkeypatch, raw):
        monkeypatch.setenv(ENV_REQUIRE_NER, raw)
        assert PiiSettings.from_env().require_ner is True


class TestStagePolicyDefault:
    def test_the_model_stage_runs_on_every_request(self):
        """Under on_miss a single email suppresses the whole NER stage, so every
        name in that same text reaches the provider unredacted."""
        assert DEFAULT_NER_STAGE_POLICY is NerStagePolicy.ALWAYS

    def test_settings_carry_that_default(self):
        assert PiiSettings().ner_stage_policy is NerStagePolicy.ALWAYS

    def test_a_deployment_may_still_choose_on_miss(self, monkeypatch):
        monkeypatch.setenv("LITELLM_PII_NER_STAGE_POLICY", "on_miss")
        assert PiiSettings.from_env().ner_stage_policy is NerStagePolicy.ON_MISS
