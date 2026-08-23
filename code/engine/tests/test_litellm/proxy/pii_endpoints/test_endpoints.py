"""Tests for the standalone /pii detect, encode, and decode endpoints."""

import os
import sys
from typing import get_args

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath("../../../.."))

import litellm.proxy.proxy_server as ps
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import PiiService
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.types import (
    AuthorizationError,
    CodecError,
    DecodeFailed,
    DetectionError,
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    KeyUnavailable,
    PiiSpan,
    SearchError,
    SearchRefused,
    StoreError,
    StoreUnavailable,
    TokenSpaceExhausted,
    UnknownToken,
    VaultForbidden,
)
from litellm.pii.vault.cipher import VaultCipher
from litellm.pii.vault.keys import DerivedKeyProvider
from litellm.pii.vault.repository import PiiVaultRepository
from litellm.pii.vault.search import VaultSearch
from litellm.pii.vault.service import VaultService
from litellm.pii.vault.store import DatabaseTokenStore
from litellm.proxy._types import LiteLLMRoutes, LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.pii_endpoints.endpoints import (
    _raise_public,
    get_decode_recorder,
    get_pii_search,
    get_pii_service,
    get_pii_vault,
    get_search_recorder,
    require_pii_vault,
)
from litellm.proxy.proxy_server import app

from ...pii.vault.test_store import FakeTable

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

    async def async_batch_get_cache(self, keys, **kwargs):
        return [self.entries.get(key) for key in keys]


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

    def test_pii_routes_are_listed_as_llm_api_routes(self):
        assert set(LiteLLMRoutes.pii_routes.value) <= set(LiteLLMRoutes.llm_api_routes.value)

    @pytest.mark.parametrize(
        "route",
        ["/pii/detect", "/pii/encode", "/pii/decode", "/pii/search", "/pii/session/s1", "/pii/subject/subject-a"],
    )
    def test_a_virtual_key_may_reach_every_pii_route(self, route):
        """Membership in llm_api_routes is not what the runtime consults.

        is_llm_api_route enumerates the sub-lists itself, and omitting pii_routes
        there refused every virtual key with an admin-only error while the
        membership assertion above still passed.
        """
        from litellm.proxy.auth.route_checks import RouteChecks

        assert RouteChecks.is_llm_api_route(route=route) is True

    def test_an_unrelated_route_is_still_not_an_llm_api_route(self):
        from litellm.proxy.auth.route_checks import RouteChecks

        assert RouteChecks.is_llm_api_route(route="/pii-ish/not-ours") is False


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


ERROR_SAMPLES = {
    VaultForbidden: VaultForbidden(reason="not on that team"),
    SearchRefused: SearchRefused(scanned=200_000, limit=100_000),
    DetectorUnavailable: DetectorUnavailable(detector=DetectorKind.RULES, reason="down"),
    DetectorInvalidResponse: DetectorInvalidResponse(detector=DetectorKind.NER, reason="not json"),
    UnknownToken: UnknownToken(token="<PERSON_9>"),
    KeyUnavailable: KeyUnavailable(reason="no key configured"),
    DecodeFailed: DecodeFailed(reason="ciphertext corrupt"),
    TokenSpaceExhausted: TokenSpaceExhausted(entity_type="PERSON"),
    StoreUnavailable: StoreUnavailable(reason="redis down"),
}


def error_variants():
    return tuple(
        variant
        for union in (DetectionError, CodecError, StoreError, AuthorizationError, SearchError)
        for variant in (get_args(union) or (union,))
    )


class TestPublicErrorContract:
    """The boundary must stay exhaustive: a new error variant has to be mapped here."""

    def test_every_error_variant_has_a_sample(self):
        assert set(error_variants()) == set(ERROR_SAMPLES)

    @pytest.mark.parametrize("variant", error_variants(), ids=lambda v: v.__name__)
    def test_every_variant_maps_to_an_http_status(self, variant):
        with pytest.raises(HTTPException) as raised:
            _raise_public(ERROR_SAMPLES[variant])
        assert 400 <= raised.value.status_code < 600


BREAK_GLASS_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="admin",
    api_key="sk-admin",
    permissions={"allow_pii_decode_any": True},
)
TEAM_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="test-user",
    api_key="sk-decoder",
    team_id="team-eng",
    permissions={"allow_pii_decode": True},
)
END_USER_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="test-user",
    api_key="sk-decoder",
    end_user_id="customer-42",
    permissions={"allow_pii_decode": True},
)


class RecordingAudit:
    def __init__(self):
        self.entries = []

    async def record(self, user_api_key_dict, scope, token_count, break_glass):
        self.entries.append((scope, token_count, break_glass))


@pytest.fixture
def vault_table():
    return FakeTable()


@pytest.fixture
def install_vault(install_service, vault_table):
    """Serve the routes a real DatabaseTokenStore over an in-memory table."""

    def _install(detector_stage):
        service = install_service(detector_stage)
        vault = VaultService(
            pii=service,
            store=DatabaseTokenStore(
                repository=PiiVaultRepository(table=vault_table),
                cipher=VaultCipher(keys=DerivedKeyProvider(secret="root-secret")),
            ),
        )
        app.dependency_overrides[get_pii_vault] = lambda: vault
        app.dependency_overrides[require_pii_vault] = lambda: vault
        return vault

    yield _install
    app.dependency_overrides.pop(get_pii_vault, None)
    app.dependency_overrides.pop(require_pii_vault, None)


@pytest.fixture
def audit():
    recorder = RecordingAudit()
    app.dependency_overrides[get_decode_recorder] = lambda: recorder.record
    yield recorder
    app.dependency_overrides.pop(get_decode_recorder, None)


class TestVaultRouteRegistration:
    def test_the_erasure_and_export_routes_are_registered(self):
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        assert {"/pii/session/{session_id}", "/pii/subject/{subject_id}"} <= paths

    def test_the_new_routes_are_reachable_by_virtual_keys(self):
        assert {"/pii/session/{session_id}", "/pii/subject/{subject_id}"} <= set(LiteLLMRoutes.pii_routes.value)


class TestVaultBackedEncode:
    def test_the_mapping_is_written_to_the_vault_not_the_cache(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})
        assert [row["session_id"] for row in vault_table.rows] == ["s1"]

    def test_it_round_trips_through_the_vault(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["hello Ada"]

    def test_it_defaults_to_the_key_scope(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert (vault_table.rows[0]["scope_type"], vault_table.rows[0]["scope_id"]) == ("key", DECODE_KEY.api_key)

    def test_a_wider_scope_is_honoured_when_the_caller_belongs_to_it(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(TEAM_KEY)
        response = client.post("/pii/encode", json={"texts": ["hello Ada"], "scope_type": "team"})
        assert response.status_code == 200
        assert (vault_table.rows[0]["scope_type"], vault_table.rows[0]["scope_id"]) == ("team", "team-eng")

    def test_a_key_on_no_team_cannot_mint_a_team_token(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        assert client.post("/pii/encode", json={"texts": ["hello Ada"], "scope_type": "team"}).status_code == 403
        assert vault_table.rows == []

    def test_subject_id_defaults_to_the_requests_end_user(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(END_USER_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert vault_table.rows[0]["subject_id"] == "customer-42"

    def test_an_explicit_subject_id_wins_over_the_end_user(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(END_USER_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})
        assert vault_table.rows[0]["subject_id"] == "subject-a"

    def test_a_request_with_no_end_user_leaves_the_subject_untagged(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert vault_table.rows[0]["subject_id"] is None

    def test_the_minting_key_is_recorded(self, client, install_vault, as_key, vault_table):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert vault_table.rows[0]["created_by"] == "test-user"


class TestVaultBackedDecode:
    def test_another_key_cannot_resolve_the_first_keys_tokens(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        as_key(OTHER_DECODE_KEY)
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert "Ada" not in decoded["texts"][0]

    def test_it_still_requires_the_decode_permission(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/decode", json={"texts": ["<PERSON:abc123>"], "session_id": "s1"})
        assert response.status_code == 403

    def test_naming_another_scope_without_break_glass_is_refused(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        response = client.post(
            "/pii/decode",
            json={"texts": ["<PERSON:abc123>"], "session_id": "s1", "scope_id": OTHER_DECODE_KEY.api_key},
        )
        assert response.status_code == 403

    def test_break_glass_reaches_another_scope(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        as_key(BREAK_GLASS_KEY)
        decoded = client.post(
            "/pii/decode",
            json={"texts": encoded["texts"], "session_id": "s1", "scope_id": DECODE_KEY.api_key},
        ).json()
        assert decoded["texts"] == ["hello Ada"]

    def test_break_glass_use_is_audited(self, client, install_vault, as_key, audit):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        as_key(BREAK_GLASS_KEY)
        client.post(
            "/pii/decode",
            json={"texts": encoded["texts"], "session_id": "s1", "scope_id": DECODE_KEY.api_key},
        )
        assert audit.entries[-1][2] is True

    def test_an_ordinary_decode_is_audited_without_the_break_glass_flag(self, client, install_vault, as_key, audit):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()
        client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"})
        assert audit.entries[-1][1:] == (1, False)

    def test_a_decode_that_resolves_nothing_is_still_audited(self, client, install_vault, as_key, audit):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/decode", json={"texts": ["hi <PERSON:deadbeef>"], "session_id": "s1"})
        assert audit.entries[-1][1] == 0


class TestSessionRevocation:
    def test_it_makes_the_sessions_tokens_unresolvable(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        assert client.delete("/pii/session/s1").status_code == 200
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == encoded["texts"]

    def test_it_leaves_another_session_alone(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada", "Grace"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})
        kept = client.post("/pii/encode", json={"texts": ["hello Grace"], "session_id": "s2"}).json()

        client.delete("/pii/session/s1")
        decoded = client.post("/pii/decode", json={"texts": kept["texts"], "session_id": "s2"}).json()
        assert decoded["texts"] == ["hello Grace"]

    def test_it_cannot_erase_another_keys_session(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()

        as_key(OTHER_DECODE_KEY)
        client.delete("/pii/session/s1")

        as_key(DECODE_KEY)
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["hello Ada"]

    def test_erasure_does_not_need_the_decode_permission(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.delete("/pii/session/s1").status_code == 200

    def test_a_key_on_no_team_cannot_erase_a_team_scope(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        assert client.delete("/pii/session/s1?scope_type=team").status_code == 403


class TestSubjectErasureAndExport:
    def test_export_returns_the_values_held_for_a_subject(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})

        body = client.get("/pii/subject/subject-a").json()
        assert [entry["value"] for entry in body["values"]] == ["Ada"]

    def test_export_needs_the_decode_permission(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.get("/pii/subject/subject-a").status_code == 403

    def test_export_is_audited_as_a_bulk_read(self, client, install_vault, as_key, audit):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})
        client.get("/pii/subject/subject-a")
        assert audit.entries[-1][1] == 1

    def test_export_finds_nothing_from_another_key(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})

        as_key(OTHER_DECODE_KEY)
        assert client.get("/pii/subject/subject-a").json()["values"] == []

    def test_erasing_a_subject_removes_its_values(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})

        assert client.delete("/pii/subject/subject-a").status_code == 200
        assert client.get("/pii/subject/subject-a").json()["values"] == []

    def test_erasing_one_subject_leaves_another_alone(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada", "Grace"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "subject_id": "subject-a"})
        client.post("/pii/encode", json={"texts": ["hello Grace"], "subject_id": "subject-b"})

        client.delete("/pii/subject/subject-a")
        assert [entry["value"] for entry in client.get("/pii/subject/subject-b").json()["values"]] == ["Grace"]


class TestVaultUnconfigured:
    def test_the_erasure_route_reports_that_the_vault_is_off(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        assert client.delete("/pii/session/s1").status_code == 501

    def test_encode_and_decode_still_work_off_the_cache_store(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"}).json()
        decoded = client.post("/pii/decode", json={"texts": encoded["texts"], "session_id": "s1"}).json()
        assert decoded["texts"] == ["hello Ada"]


SEARCH_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="test-user",
    api_key="sk-decoder",
    permissions={"allow_pii_decode": True, "allow_pii_search": True},
)


@pytest.fixture
def install_search(vault_table):
    from ...pii.vault.test_search import OrderedFakeTable

    def _install(candidate_cap=100_000):
        ordered = OrderedFakeTable()
        ordered.rows = vault_table.rows
        searcher = VaultSearch(
            repository=PiiVaultRepository(table=ordered),
            cipher=VaultCipher(keys=DerivedKeyProvider(secret="root-secret")),
            candidate_cap=candidate_cap,
        )
        app.dependency_overrides[get_pii_search] = lambda: searcher
        return searcher

    yield _install
    app.dependency_overrides.pop(get_pii_search, None)


class RecordingSearchAudit:
    def __init__(self):
        self.entries = []

    async def record(self, user_api_key_dict, scope, entity_type, hit_count, scanned):
        self.entries.append((scope, entity_type, hit_count, scanned))


@pytest.fixture
def search_audit():
    recorder = RecordingSearchAudit()
    app.dependency_overrides[get_search_recorder] = lambda: recorder.record
    yield recorder
    app.dependency_overrides.pop(get_search_recorder, None)


class TestSearchRoute:
    def test_the_route_is_registered_and_reachable_by_virtual_keys(self):
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        assert "/pii/search" in paths
        assert "/pii/search" in set(LiteLLMRoutes.pii_routes.value)

    def test_it_finds_a_token_this_key_minted(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})

        body = client.post("/pii/search", json={"query": "ada"}).json()
        assert len(body["hits"]) == 1
        assert body["hits"][0]["entity_type"] == "PERSON"

    def test_search_needs_its_own_permission_not_the_decode_one(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(DECODE_KEY)
        assert client.post("/pii/search", json={"query": "ada"}).status_code == 403

    def test_a_key_with_only_search_may_search(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(UserAPIKeyAuth(api_key="sk-searcher", user_id="u", permissions={"allow_pii_search": True}))
        assert client.post("/pii/search", json={"query": "ada"}).status_code == 200

    def test_it_finds_nothing_from_another_key(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})

        as_key(UserAPIKeyAuth(api_key="sk-elsewhere", user_id="other", permissions={"allow_pii_search": True}))
        assert client.post("/pii/search", json={"query": "ada"}).json()["hits"] == []

    def test_substring_mode_finds_a_partial_value(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Lovelace"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Lovelace"]})

        body = client.post("/pii/search", json={"query": "lovel", "mode": "substring"}).json()
        assert len(body["hits"]) == 1

    def test_exact_mode_does_not_match_a_different_case(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert client.post("/pii/search", json={"query": "ada", "mode": "exact"}).json()["hits"] == []

    def test_a_scan_over_the_cap_is_refused_with_422(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada", "Grace"))
        install_search(candidate_cap=1)
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["Ada met Grace"]})
        assert client.post("/pii/search", json={"query": "ada"}).status_code == 422

    def test_an_empty_query_is_rejected(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        assert client.post("/pii/search", json={"query": ""}).status_code == 422

    def test_it_reports_how_much_it_scanned(self, client, install_vault, install_search, as_key):
        install_vault(SubstringDetector("Ada", "Grace"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["Ada met Grace"]})
        assert client.post("/pii/search", json={"query": "ada"}).json()["scanned"] == 2


class TestSearchAudit:
    def test_a_query_is_audited(self, client, install_vault, install_search, as_key, search_audit):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        client.post("/pii/search", json={"query": "ada", "entity_type": "PERSON"})
        assert len(search_audit.entries) == 1

    def test_the_audit_records_the_entity_type_and_the_counts(
        self, client, install_vault, install_search, as_key, search_audit
    ):
        install_vault(SubstringDetector("Ada"))
        install_search()
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        client.post("/pii/search", json={"query": "ada", "entity_type": "PERSON"})
        scope, entity_type, hit_count, scanned = search_audit.entries[0]
        assert (entity_type, hit_count, scanned) == ("PERSON", 1, 1)

    def test_the_audit_never_carries_the_query_string(self, client, install_vault, install_search, as_key):
        from litellm.pii.vault.scope import VaultScope, VaultScopeType
        from litellm.proxy.pii_endpoints.audit import search_audit_entry

        entry = search_audit_entry(
            SEARCH_KEY, VaultScope(VaultScopeType.KEY, "k"), entity_type="PERSON", hit_count=1, scanned=1
        )
        assert "ada" not in entry.updated_values.lower()

    def test_a_refused_search_is_not_recorded_as_a_successful_read(
        self, client, install_vault, install_search, as_key, search_audit
    ):
        install_vault(SubstringDetector("Ada", "Grace"))
        install_search(candidate_cap=1)
        as_key(SEARCH_KEY)
        client.post("/pii/encode", json={"texts": ["Ada met Grace"]})
        client.post("/pii/search", json={"query": "ada"})
        assert search_audit.entries == []


class TestSessionBrowsing:
    def test_it_lists_the_tokens_a_session_holds(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada", "Grace"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["Ada met Grace"], "session_id": "s1"})

        body = client.get("/pii/session/s1").json()
        assert len(body["tokens"]) == 2
        assert body["session_id"] == "s1"

    def test_it_reports_the_entity_type_and_expiry(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})

        token = client.get("/pii/session/s1").json()["tokens"][0]
        assert token["entity_type"] == "PERSON"
        assert token["expires_at"] is not None

    def test_it_never_returns_the_value_or_the_ciphertext(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})

        raw = client.get("/pii/session/s1").text
        assert "Ada" not in raw
        assert "ciphertext" not in raw
        assert "p1:gcm:" not in raw

    def test_it_carries_the_subject_tag_so_erasure_can_be_targeted(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1", "subject_id": "subject-a"})
        assert client.get("/pii/session/s1").json()["tokens"][0]["subject_id"] == "subject-a"

    def test_browsing_does_not_need_the_decode_permission(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.get("/pii/session/s1").status_code == 200

    def test_another_key_sees_nothing_of_this_session(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})

        as_key(OTHER_DECODE_KEY)
        assert client.get("/pii/session/s1").json()["tokens"] == []

    def test_an_unknown_session_is_empty_rather_than_an_error(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        response = client.get("/pii/session/never-existed")
        assert (response.status_code, response.json()["tokens"]) == (200, [])

    def test_a_revoked_session_lists_nothing(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"], "session_id": "s1"})
        client.delete("/pii/session/s1")
        assert client.get("/pii/session/s1").json()["tokens"] == []


@pytest.fixture
def recorded(monkeypatch):
    from litellm.pii.activity import PiiActivityLog

    fresh = PiiActivityLog(capacity=50)
    monkeypatch.setattr("litellm.pii.activity._LOG", fresh)
    return fresh


class TestCodecSelection:
    def test_defaults_to_the_handle_form(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()
        assert encoded["texts"][0].startswith("hello <PERSON:")

    def test_placeholder_mints_the_ordinal_form_the_llm_path_uses(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        assert encoded["texts"] == ["hello <PERSON_1>"]

    def test_a_placeholder_token_still_decodes(self, client, install_service, as_key):
        """The grammar recognises both forms, so decode needs no matching option."""
        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        decoded = client.post(
            "/pii/decode", json={"texts": encoded["texts"], "session_id": encoded["session_id"]}
        ).json()
        assert decoded["texts"] == ["hello Ada"]

    def test_rejects_a_codec_that_does_not_exist(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "rot13"})
        assert response.status_code == 422


class TestEndpointActivityRecording:
    def test_a_detect_is_recorded(self, client, install_service, as_key, recorded):
        from litellm.pii.activity import PiiDirection, PiiSurface

        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        client.post("/pii/detect", json={"texts": ["hello Ada"]})
        event = recorded.recent(limit=1)[0]
        assert (event.surface, event.direction) == (PiiSurface.ENDPOINT, PiiDirection.DETECT)
        assert dict(event.entity_counts) == {"PERSON": 1}

    def test_an_encode_records_its_session_so_the_two_halves_can_be_joined(
        self, client, install_service, as_key, recorded
    ):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()
        assert recorded.recent(limit=1)[0].session_id == encoded["session_id"]

    def test_a_decode_records_how_much_it_resolved(self, client, install_service, as_key, recorded):
        from litellm.pii.activity import PiiDirection

        install_service(SubstringDetector("Ada"))
        as_key(DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        client.post(
            "/pii/decode",
            json={"texts": ["<PERSON_1> and <PERSON_9>"], "session_id": encoded["session_id"]},
        )
        event = recorded.recent(limit=1, direction=PiiDirection.DECODE)[0]
        assert (event.token_count, event.resolved_count) == (2, 1)

    def test_a_detector_outage_is_recorded_as_a_failure(self, client, install_service, as_key, recorded):
        from litellm.pii.activity import Failed

        install_service(SubstringDetector("Ada", error=DetectorUnavailable(detector=DetectorKind.RULES, reason="down")))
        as_key(NO_DECODE_KEY)
        client.post("/pii/detect", json={"texts": ["hello Ada"]})
        outcome = recorded.recent(limit=1)[0].outcome
        assert isinstance(outcome, Failed) and "down" in outcome.reason

    def test_attributes_the_event_to_the_calling_key(self, client, install_service, as_key, recorded):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        client.post("/pii/encode", json={"texts": ["hello Ada"]})
        assert recorded.recent(limit=1)[0].user_id == "test-user"


class TestEncodePlacements:
    def test_reports_where_each_token_went(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"), codec=None)
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        assert encoded["placements"] == [
            {
                "text_index": 0,
                "start": 6,
                "end": 9,
                "entity_type": "PERSON",
                "detector": "rules",
                "score": 0.95,
                "token": "<PERSON_1>",
            }
        ]

    def test_offsets_index_the_text_the_caller_sent(self, client, install_service, as_key):
        """A caller must be able to slice its own input with these, not the encoded output."""
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        source = "hello Ada"
        placement = client.post("/pii/encode", json={"texts": [source]}).json()["placements"][0]
        assert source[placement["start"] : placement["end"]] == "Ada"

    def test_a_repeated_value_reports_both_positions_under_one_token(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["Ada", "Ada again"], "codec": "placeholder"}).json()
        placements = encoded["placements"]
        assert [p["text_index"] for p in placements] == [0, 1]
        assert {p["token"] for p in placements} == {"<PERSON_1>"}

    def test_reports_whether_the_model_stage_ran(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/encode", json={"texts": ["hello Ada"]}).json()["ner_stage_ran"] is False

    def test_clean_text_reports_no_placements(self, client, install_service, as_key):
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/encode", json={"texts": ["nothing here"]}).json()["placements"] == []


class TestCodecAgainstTheVault:
    """The vault keys a row by the token, so an ordinal token cannot live in it."""

    def test_placeholder_is_refused_rather_than_silently_dropped(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        response = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"})
        assert response.status_code == 422
        assert "handle codec" in response.text

    def test_the_refusal_explains_what_would_have_been_lost(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        detail = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        assert "nothing can resolve" in detail["detail"]["error"]

    def test_the_default_handle_codec_is_unaffected(self, client, install_vault, as_key):
        install_vault(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        assert client.post("/pii/encode", json={"texts": ["hello Ada"]}).status_code == 200

    def test_placeholder_is_still_allowed_without_a_vault(self, client, install_service, as_key):
        """The cache store keys by scope and session, so ordinals are safe there."""
        install_service(SubstringDetector("Ada"))
        as_key(NO_DECODE_KEY)
        encoded = client.post("/pii/encode", json={"texts": ["hello Ada"], "codec": "placeholder"}).json()
        assert encoded["texts"] == ["hello <PERSON_1>"]


class TestPermissions:
    """A surface that offers decode has to be able to ask first, not learn from a 403."""

    def test_a_key_without_the_grant_is_told_so(self, client, as_key):
        as_key(NO_DECODE_KEY)
        assert client.get("/pii/permissions").json()["can_decode"] is False

    def test_a_key_with_the_grant_is_told_so(self, client, as_key):
        as_key(DECODE_KEY)
        assert client.get("/pii/permissions").json()["can_decode"] is True

    def test_reports_break_glass_separately(self, client, as_key):
        as_key(
            UserAPIKeyAuth(
                user_role=LitellmUserRoles.PROXY_ADMIN,
                user_id="breaker",
                api_key="sk-break",
                permissions={"allow_pii_decode": True, "allow_pii_decode_any": True},
            )
        )
        body = client.get("/pii/permissions").json()
        assert body["can_decode"] is True and body["can_decode_any"] is True

    def test_being_a_proxy_admin_does_not_imply_decode(self, client, as_key):
        """The rule the console's own grant flow exists to respect."""
        as_key(UserAPIKeyAuth(user_role=LitellmUserRoles.PROXY_ADMIN, user_id="admin", api_key="sk-admin"))
        assert client.get("/pii/permissions").json()["can_decode"] is False

    def test_reports_search_separately_from_decode(self, client, as_key):
        as_key(
            UserAPIKeyAuth(
                user_role=LitellmUserRoles.PROXY_ADMIN,
                user_id="searcher",
                api_key="sk-search",
                permissions={"allow_pii_search": True},
            )
        )
        body = client.get("/pii/permissions").json()
        assert body["can_search"] is True and body["can_decode"] is False

    def test_never_returns_anything_from_the_vault(self, client, as_key):
        as_key(DECODE_KEY)
        assert set(client.get("/pii/permissions").json()) == {"can_decode", "can_decode_any", "can_search"}
