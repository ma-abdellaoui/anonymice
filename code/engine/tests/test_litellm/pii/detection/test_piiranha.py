import pytest

from litellm.pii.detection.http import JsonResponse, TransportFailure
from litellm.pii.detection.piiranha import PiiranhaDetector
from litellm.pii.detection.ner_labels import (
    PIIRANHA_LABEL_MAP,
    map_label,
    normalize_label,
)
from litellm.pii.types import DetectorInvalidResponse, DetectorKind, DetectorUnavailable


class RecordingPoster:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def post_json(self, url, payload):
        self.calls.append((url, dict(payload)))
        return self.result


def ok(body):
    return RecordingPoster(JsonResponse(status_code=200, body=body))


def prediction(label="GIVENNAME", start=0, end=3, score=0.99):
    return {"entity_group": label, "score": score, "word": "Ada", "start": start, "end": end}


class TestLabelMapping:
    @pytest.mark.parametrize(
        "raw, expected",
        [("B-CITY", "CITY"), ("I-GIVENNAME", "GIVENNAME"), ("SURNAME", "SURNAME"), ("A-WEIRD", "A-WEIRD")],
    )
    def test_bio_prefix_is_stripped_only_for_b_and_i(self, raw, expected):
        assert normalize_label(raw) == expected

    def test_given_name_and_surname_both_map_to_person(self):
        assert map_label("GIVENNAME") == "PERSON"
        assert map_label("SURNAME") == "PERSON"

    def test_address_fragments_map_to_location(self):
        assert {map_label(x) for x in ("CITY", "STREET", "ZIPCODE", "BUILDINGNUM")} == {"LOCATION"}

    def test_unknown_label_is_dropped_rather_than_passed_through(self):
        assert map_label("SOMETHING_NEW") is None

    def test_every_mapped_value_is_a_non_empty_string(self):
        assert all(isinstance(v, str) and v for v in PIIRANHA_LABEL_MAP.values())


class TestRequestPayload:
    @pytest.mark.asyncio
    async def test_posts_hf_token_classification_payload(self):
        poster = ok([])
        await PiiranhaDetector(api_base="http://ner:8080", poster=poster).detect("Ada", "en", None)
        assert poster.calls == [("http://ner:8080", {"inputs": "Ada"})]

    @pytest.mark.asyncio
    async def test_skips_call_for_blank_text(self):
        poster = ok([])
        assert await PiiranhaDetector(api_base="http://ner", poster=poster).detect("  ", "en", None) == ()
        assert poster.calls == []


class TestResponseParsing:
    @pytest.mark.asyncio
    async def test_maps_prediction_to_span_with_ner_detector_kind(self):
        poster = ok([prediction()])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert result[0].entity_type == "PERSON"
        assert result[0].detector is DetectorKind.NER

    @pytest.mark.asyncio
    async def test_accepts_non_aggregated_entity_key(self):
        poster = ok([{"entity": "B-SURNAME", "score": 0.9, "start": 0, "end": 8}])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Lovelace", "en", None)
        assert result[0].entity_type == "PERSON"

    @pytest.mark.asyncio
    async def test_unwraps_batch_of_one_nesting(self):
        poster = ok([[prediction()]])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert len(result) == 1

    @pytest.mark.asyncio
    async def test_predictions_below_threshold_are_dropped(self):
        poster = ok([prediction(score=0.4), prediction(label="SURNAME", start=4, end=12, score=0.8)])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster, score_threshold=0.5).detect(
            "Ada Lovelace", "en", None
        )
        assert len(result) == 1
        assert result[0].start == 4

    @pytest.mark.asyncio
    async def test_unmapped_label_is_dropped(self):
        poster = ok([prediction(label="BRAND_NEW_LABEL")])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert result == ()

    @pytest.mark.asyncio
    async def test_requested_entity_filter_is_applied_after_mapping(self):
        poster = ok([prediction(), prediction(label="CITY", start=4, end=10)])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada Paris", "en", ["PERSON"])
        assert [s.entity_type for s in result] == ["PERSON"]

    @pytest.mark.asyncio
    async def test_inverted_span_is_dropped(self):
        poster = ok([prediction(start=9, end=4)])
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert result == ()


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_transport_failure_maps_to_detector_unavailable(self):
        poster = RecordingPoster(TransportFailure(reason="ReadTimeout"))
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert result == DetectorUnavailable(detector=DetectorKind.NER, reason="ReadTimeout")

    @pytest.mark.asyncio
    async def test_http_error_maps_to_detector_unavailable(self):
        poster = RecordingPoster(JsonResponse(status_code=500, body={}))
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert isinstance(result, DetectorUnavailable)

    @pytest.mark.asyncio
    async def test_model_loading_error_body_maps_to_invalid_response(self):
        poster = ok({"error": "Model is currently loading"})
        result = await PiiranhaDetector(api_base="http://ner", poster=poster).detect("Ada", "en", None)
        assert isinstance(result, DetectorInvalidResponse)
