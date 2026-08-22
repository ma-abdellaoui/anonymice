"""Tests for the standalone /pii detect, encode, and decode endpoints."""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath("../../../.."))

import litellm.proxy.proxy_server as ps
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import PiiService
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.types import DetectorKind, DetectorUnavailable, PiiSpan
from litellm.proxy._types import LiteLLMRoutes, LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.pii_endpoints.endpoints import get_pii_service
from litellm.proxy.proxy_server import app

DECODE_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="test-user",
    api_key="sk-decoder",
    permissions={"allow_pii_decode": True},
)
NO_DECODE_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="test-user",
    api_key="sk-encoder-only",
    permissions={},
)
OTHER_DECODE_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="other-user",
    api_key="sk-somebody-else",
    permissions={"allow_pii_decode": True},
)


class FakeCache:
    def __init__(self):
        self.entries = {}

    async def async_set_cache(self, key, value, **kwargs):
        self.entries[key] = value

    async def async_get_cache(self, key, **kwargs):
        return self.entries.get(key)


class SubstringDetector:
    def __init__(self, *needles, entity_type="PERSON", error=None):
        self.needles = needles
        self.entity_type = entity_type
        self.error = error

    async def detect(self, text, language, entities):
        if self.error is not None:
            return self.error
        return tuple(
            PiiSpan(
                entity_type=self.entity_type,
                start=text.index(n),
                end=text.index(n) + len(n),
                score=0.95,
                detector=DetectorKind.RULES,
            )
            for n in self.needles
            if n in text
        )


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def shared_cache():
    return FakeCache()


@pytest.fixture
def install_service(shared_cache):
    """Inject a service whose detector is a fake, so no Presidio deployment is needed."""

    def _install(detector_stage, codec=None):
        from litellm.pii.codec.handle import HandleCodec

        service = PiiService(
            detector=CascadingDetector(rules=detector_stage, ner=None, policy=NerStagePolicy.NEVER),
            codec=codec or HandleCodec(),
            store=DualCacheStore(cache=shared_cache),
        )
        app.dependency_overrides[get_pii_service] = lambda: service
        return service

    yield _install
    app.dependency_overrides.pop(get_pii_service, None)


@pytest.fixture
def as_key():
    def _as(key):
        app.dependency_overrides[ps.user_api_key_auth] = lambda: key

    yield _as
    app.dependency_overrides.pop(ps.user_api_key_auth, None)


class TestRouteRegistration:
    def test_pii_routes_are_registered_on_the_app(self):
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        assert {"/pii/detect", "/pii/encode", "/pii/decode"} <= paths

    def test_pii_routes_are_reachable_by_virtual_keys(self):
        assert set(LiteLLMRoutes.pii_routes.value) <= set(LiteLLMRoutes.llm_api_routes.value)


class TestDetect:
    def test_returns_spans_for_detected_pii(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/detect", json={"texts": ["hello Ada"]})
        assert response.status_code == 200
        assert response.json()["results"][0]["spans"][0]["entity_type"] == "PERSON"

    def test_does_not_alter_the_text(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/detect", json={"texts": ["hello Ada"]})
        assert "texts" not in response.json()

    def test_reports_span_offsets_into_the_original_text(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        span = client.post("/pii/detect", json={"texts": ["hello Ada"]}).json()["results"][0]["spans"][0]
        assert "hello Ada"[span["start"] : span["end"]] == "Ada"

    def test_detector_outage_maps_to_503(self, client, install_service, as_key):
        install_service(SubstringDetector(error=DetectorUnavailable(detector=DetectorKind.RULES, reason="down")))
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/detect", json={"texts": ["hello Ada"]}).status_code == 503

    def test_empty_texts_list_is_rejected(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/detect", json={"texts": []}).status_code == 422


class TestEncode:
    def test_replaces_pii_and_returns_a_session_id(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        body = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()
        assert "Ada" not in body["texts"][0]
        assert body["session_id"]

    def test_generates_a_session_id_when_none_is_supplied(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        first = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()["session_id"]
        second = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()["session_id"]
        assert first != second

    def test_honours_a_client_supplied_session_id(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        body = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "sess-1"}).json()
        assert body["session_id"] == "sess-1"

    def test_reports_issued_tokens(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        tokens = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()["tokens"]
        assert tokens[0]["entity_type"] == "PERSON"
        assert tokens[0]["codec_id"] == "handle"

    def test_shares_one_token_space_across_texts(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        body = client.post("/pii/encode", json={"texts": ["Ada wrote", "Ada signed"]}).json()
        assert body["texts"][0].split()[0] == body["texts"][1].split()[0]

    def test_clean_text_passes_through_untouched(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        body = client.post("/pii/encode", json={"texts": ["nothing to see"]}).json()
        assert body["texts"] == ["nothing to see"]
        assert body["tokens"] == []


class TestDecode:
    def test_round_trip_across_two_separate_requests(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["hello Ada"]

    def test_requires_the_allow_pii_decode_permission(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/decode", json={"texts": ["<PERSON:abc123>"], "session_id": "s1"})
        assert response.status_code == 403

    def test_another_key_cannot_decode_the_first_keys_tokens(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        as_key(OTHER_DECODE_KEY)
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == encoded["texts"]
        assert "Ada" not in decoded["texts"][0]

    def test_wrong_session_id_does_not_resolve_the_token(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s2"}).json()
        assert "Ada" not in decoded["texts"][0]

    def test_unknown_token_is_left_verbatim(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        decoded = client.post("/pii/decode", json={"texts": ["hi <PERSON:deadbeef>"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["hi <PERSON:deadbeef>"]

    def test_text_without_tokens_passes_through(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        decoded = client.post("/pii/decode", json={"texts": ["plain text"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["plain text"]


class TestUnconfigured:
    def test_returns_501_when_detection_is_not_configured(self, client, as_key, monkeypatch):
        monkeypatch.delenv("PRESIDIO_ANALYZER_API_BASE", raising=False)
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/detect", json={"texts": ["hello"]}).status_code == 501
