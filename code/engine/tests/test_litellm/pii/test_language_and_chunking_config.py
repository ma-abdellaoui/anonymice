"""The wiring that decides a request is scanned in the right language, whole."""

import pytest

from litellm.pii.config import (
    DEFAULT_LANGUAGE,
    ENV_LANGUAGE,
    ENV_NER_MAX_CHARS,
    PiiSettings,
    build_detector,
    build_ner_stage,
)
from litellm.pii.detection.chunking import ChunkedDetector
from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer.pii_anonymizer_guardrail import (
    guardrail_settings,
)

CONFIGURED = {"analyzer_api_base": "http://analyzer", "ner_api_base": "http://ner"}


def test_language_defaults_to_english() -> None:
    assert PiiSettings().language == DEFAULT_LANGUAGE


def test_language_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_LANGUAGE, "de")
    assert PiiSettings.from_env().language == "de"


def test_chunk_size_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_NER_MAX_CHARS, "512")
    assert PiiSettings.from_env().ner_max_chars == 512


def test_a_junk_chunk_size_falls_back_rather_than_crashing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_NER_MAX_CHARS, "not-a-number")
    assert PiiSettings.from_env().ner_max_chars > 0


def test_the_ner_stage_is_windowed() -> None:
    """Unwrapped, a long prompt times the model stage out and fails the request closed."""
    stage = build_ner_stage(PiiSettings(**CONFIGURED, ner_max_chars=1234))
    assert isinstance(stage, ChunkedDetector)
    assert stage.max_chars == 1234


def test_the_rules_stage_is_not_windowed() -> None:
    """Regex is linear, and a seam there would split an IBAN for no gain."""
    detector = build_detector(PiiSettings(**CONFIGURED))
    assert not isinstance(detector.rules, ChunkedDetector)


def test_no_ner_stage_without_a_configured_base() -> None:
    assert build_ner_stage(PiiSettings(analyzer_api_base="http://analyzer")) is None


def test_guardrail_language_overrides_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_LANGUAGE, "en")
    settings = guardrail_settings(
        presidio_analyzer_api_base=None,
        ner_api_base=None,
        ner_stage_policy=None,
        ner_score_threshold=None,
        fail_closed=None,
        language="de",
    )
    assert settings.language == "de"


def test_guardrail_falls_back_to_the_environment_language(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_LANGUAGE, "de")
    settings = guardrail_settings(
        presidio_analyzer_api_base=None,
        ner_api_base=None,
        ner_stage_policy=None,
        ner_score_threshold=None,
        fail_closed=None,
        language=None,
    )
    assert settings.language == "de"
