import pytest

from litellm.pii.detection.http import JsonResponse, TransportFailure
from litellm.pii.detection.presidio_rules import (
    RULE_BASED_ENTITIES,
    PresidioRulesDetector,
    _normalize_base_url,
)
from litellm.pii.types import (
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    PiiSpan,
)


class RecordingPoster:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def post_json(self, url, payload):
        self.calls.append((url, dict(payload)))
        return self.result


def ok(body):
    return RecordingPoster(JsonResponse(status_code=200, body=body))


class TestNormalizeBaseUrl:
    @pytest.mark.parametrize(
        "given, expected",
        [
            ("http://presidio:3000", "http://presidio:3000/"),
            ("http://presidio:3000/", "http://presidio:3000/"),
            ("presidio:3000", "http://presidio:3000/"),
            ("https://presidio.internal", "https://presidio.internal/"),
        ],
    )
    def test_scheme_and_trailing_slash_are_normalized(self, given, expected):
        assert _normalize_base_url(given) == expected


class TestRequestPayload:
    @pytest.mark.asyncio
    async def test_posts_to_analyze_endpoint(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="presidio:3000", poster=poster).detect("hi there", "en", None)
        assert poster.calls[0][0] == "http://presidio:3000/analyze"

    @pytest.mark.asyncio
    async def test_entity_list_is_pinned_to_rule_based_set(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("hi there", "en", None)
        assert set(poster.calls[0][1]["entities"]) == RULE_BASED_ENTITIES

    @pytest.mark.asyncio
    async def test_ner_entities_are_never_requested_from_stage_one(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect(
            "hi there", "en", ["PERSON", "LOCATION", "EMAIL_ADDRESS"]
        )
        assert poster.calls[0][1]["entities"] == ("EMAIL_ADDRESS",)

    @pytest.mark.asyncio
    async def test_skips_call_when_no_requested_entity_is_rule_based(self):
        poster = ok([])
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("hi there", "en", ["PERSON"])
        assert poster.calls == []
        assert result == ()

    @pytest.mark.asyncio
    async def test_skips_call_for_blank_text(self):
        poster = ok([])
        assert await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("   ", "en", None) == ()
        assert poster.calls == []

    @pytest.mark.asyncio
    async def test_language_is_forwarded(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("hallo", "de", None)
        assert poster.calls[0][1]["language"] == "de"

    @pytest.mark.asyncio
    async def test_optional_fields_are_omitted_when_unset(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("hi there", "en", None)
        assert "score_threshold" not in poster.calls[0][1]
        assert "ad_hoc_recognizers" not in poster.calls[0][1]

    @pytest.mark.asyncio
    async def test_score_threshold_is_forwarded_when_set(self):
        poster = ok([])
        await PresidioRulesDetector(analyzer_api_base="p", poster=poster, score_threshold=0.7).detect(
            "hi there", "en", None
        )
        assert poster.calls[0][1]["score_threshold"] == 0.7


class TestResponseParsing:
    @pytest.mark.asyncio
    async def test_parses_analyzer_results_into_spans(self):
        poster = ok([{"entity_type": "US_SSN", "start": 4, "end": 15, "score": 0.85}])
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("ssn 123-45-6789", "en", None)
        assert result == (PiiSpan("US_SSN", 4, 15, 0.85, DetectorKind.RULES),)

    @pytest.mark.asyncio
    async def test_drops_malformed_items_without_failing_the_batch(self):
        poster = ok(
            [
                {"entity_type": "US_SSN", "start": 4, "end": 15, "score": 0.85},
                {"entity_type": "US_SSN", "start": 5},
                "not-a-dict",
                {"entity_type": 42, "start": 0, "end": 3, "score": 0.9},
                {"entity_type": "EMAIL_ADDRESS", "start": 9, "end": 4, "score": 0.9},
            ]
        )
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("ssn 123-45-6789", "en", None)
        assert result == (PiiSpan("US_SSN", 4, 15, 0.85, DetectorKind.RULES),)

    @pytest.mark.asyncio
    async def test_missing_score_defaults_to_zero(self):
        poster = ok([{"entity_type": "URL", "start": 0, "end": 3}])
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert result[0].score == 0.0


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_transport_failure_maps_to_detector_unavailable(self):
        poster = RecordingPoster(TransportFailure(reason="ConnectTimeout"))
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert result == DetectorUnavailable(detector=DetectorKind.RULES, reason="ConnectTimeout")

    @pytest.mark.asyncio
    async def test_http_error_status_maps_to_detector_unavailable(self):
        poster = RecordingPoster(JsonResponse(status_code=503, body={}))
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert isinstance(result, DetectorUnavailable)
        assert "503" in result.reason

    @pytest.mark.asyncio
    async def test_analyzer_error_body_maps_to_invalid_response(self):
        poster = ok({"error": "No text provided"})
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert isinstance(result, DetectorInvalidResponse)
        assert "No text provided" in result.reason

    @pytest.mark.asyncio
    async def test_non_list_body_maps_to_invalid_response(self):
        poster = ok("unexpected")
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert isinstance(result, DetectorInvalidResponse)

    @pytest.mark.asyncio
    async def test_failure_is_never_silently_an_empty_span_tuple(self):
        poster = RecordingPoster(TransportFailure(reason="boom"))
        result = await PresidioRulesDetector(analyzer_api_base="p", poster=poster).detect("abc", "en", None)
        assert result != ()
