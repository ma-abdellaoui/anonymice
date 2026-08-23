"""Tests for /pii/activity: reading the log, ingesting from a client, and what stays hidden."""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath("../../../.."))

import litellm.proxy.proxy_server as ps
from litellm.pii.activity import (
    Applied,
    Blocked,
    Failed,
    PiiActivityLog,
    PiiDirection,
    PiiSurface,
    TextCapture,
    TokenPlacement,
    activity_log,
    new_event,
)
from litellm.pii.codec.action_aware import SpanAction
from litellm.pii.types import DetectorKind
from litellm.proxy._types import LiteLLMRoutes, LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.proxy_server import app

DECODE_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.INTERNAL_USER,
    user_id="decoder",
    api_key="sk-decoder",
    key_alias="decoder-key",
    permissions={"allow_pii_decode": True},
)
PLAIN_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.INTERNAL_USER,
    user_id="plain",
    api_key="sk-plain",
    key_alias="plain-key",
    permissions={},
)
ADMIN_KEY = UserAPIKeyAuth(
    user_role=LitellmUserRoles.PROXY_ADMIN,
    user_id="admin",
    api_key="sk-admin",
    permissions={},
)

A_CAPTURE = TextCapture(
    before=("email Ada",),
    after=("email <PERSON_1>",),
    placements=(
        TokenPlacement(
            token="<PERSON_1>",
            entity_type="PERSON",
            detector=DetectorKind.NER,
            score=0.98,
            action=SpanAction.ENCODE,
            text_index=0,
            start=6,
            end=9,
            value="Ada",
        ),
    ),
)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def as_key():
    def _as(key):
        app.dependency_overrides[ps.user_api_key_auth] = lambda: key

    yield _as
    app.dependency_overrides.pop(ps.user_api_key_auth, None)


@pytest.fixture(autouse=True)
def empty_log(monkeypatch):
    """A fresh ring per test, since the log is a process-wide singleton."""
    fresh = PiiActivityLog(capacity=50)
    monkeypatch.setattr("litellm.pii.activity._LOG", fresh)
    return fresh


def an_event(**overrides):
    base = dict(
        surface=PiiSurface.GUARDRAIL,
        direction=PiiDirection.ENCODE,
        outcome=Applied(),
        duration_ms=2.5,
    )
    return new_event(**{**base, **overrides})


class TestRouteRegistration:
    def test_the_activity_routes_are_mounted(self):
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        assert {"/pii/activity", "/pii/activity/stream"} <= paths

    def test_a_virtual_key_may_reach_the_activity_route(self):
        from litellm.proxy.auth.route_checks import RouteChecks

        assert RouteChecks.is_llm_api_route(route="/pii/activity") is True

    def test_the_activity_routes_are_listed_with_the_other_pii_routes(self):
        assert {"/pii/activity", "/pii/activity/stream"} <= set(LiteLLMRoutes.pii_routes.value)


class TestReading:
    def test_returns_recorded_events_newest_first(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        first, second = an_event(), an_event(direction=PiiDirection.DECODE)
        empty_log.record(first)
        empty_log.record(second)
        events = client.get("/pii/activity").json()["events"]
        assert [event["id"] for event in events] == [second.id, first.id]

    def test_filters_by_surface(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        empty_log.record(an_event(surface=PiiSurface.GUARDRAIL))
        empty_log.record(an_event(surface=PiiSurface.EXTENSION))
        events = client.get("/pii/activity", params={"surface": "extension"}).json()["events"]
        assert [event["surface"] for event in events] == ["extension"]

    def test_filters_by_direction(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        empty_log.record(an_event(direction=PiiDirection.ENCODE))
        empty_log.record(an_event(direction=PiiDirection.DECODE))
        events = client.get("/pii/activity", params={"direction": "decode"}).json()["events"]
        assert [event["direction"] for event in events] == ["decode"]

    def test_rejects_a_limit_beyond_the_cap(self, client, as_key):
        as_key(ADMIN_KEY)
        assert client.get("/pii/activity", params={"limit": 100_000}).status_code == 422

    def test_reports_a_blocked_outcome_with_the_entity_that_caused_it(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        empty_log.record(an_event(outcome=Blocked(entity_type="CREDIT_CARD")))
        outcome = client.get("/pii/activity").json()["events"][0]["outcome"]
        assert outcome == {"kind": "blocked", "entity_type": "CREDIT_CARD", "reason": None}

    def test_reports_a_failure_with_its_reason(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        empty_log.record(an_event(outcome=Failed(reason="detector unavailable")))
        outcome = client.get("/pii/activity").json()["events"][0]["outcome"]
        assert outcome["kind"] == "failed" and outcome["reason"] == "detector unavailable"


class TestCaptureAuthorization:
    def test_a_key_without_the_decode_grant_never_sees_the_text(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        empty_log.record(an_event(capture=A_CAPTURE))
        event = client.get("/pii/activity").json()["events"][0]
        assert event["capture"] is None

    def test_and_is_told_the_text_was_withheld_rather_than_absent(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        empty_log.record(an_event(capture=A_CAPTURE))
        assert client.get("/pii/activity").json()["events"][0]["capture_withheld"] is True

    def test_the_decode_grant_opens_it(self, client, as_key, empty_log):
        as_key(DECODE_KEY)
        empty_log.record(an_event(capture=A_CAPTURE))
        event = client.get("/pii/activity").json()["events"][0]
        assert event["capture"]["placements"][0]["value"] == "Ada"
        assert event["capture_withheld"] is False

    def test_an_admin_may_read_it(self, client, as_key, empty_log):
        as_key(ADMIN_KEY)
        empty_log.record(an_event(capture=A_CAPTURE))
        assert client.get("/pii/activity").json()["events"][0]["capture"]["before"] == ["email Ada"]

    def test_an_event_with_no_capture_is_not_reported_as_withheld(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        empty_log.record(an_event())
        assert client.get("/pii/activity").json()["events"][0]["capture_withheld"] is False

    def test_counts_stay_readable_without_the_grant(self, client, as_key, empty_log):
        """Metadata is not the protected thing; withholding it would make the log useless."""
        as_key(PLAIN_KEY)
        empty_log.record(an_event(entity_counts={"PERSON": 2}, token_count=2, capture=A_CAPTURE))
        event = client.get("/pii/activity").json()["events"][0]
        assert event["entity_counts"] == {"PERSON": 2} and event["token_count"] == 2


class TestIngest:
    def a_beacon(self, **overrides):
        return {
            "direction": "encode",
            "action": "mint",
            "host": "crm.internal",
            "trust_class": "NATIVE",
            "entity_types": ["IBAN", "IBAN", "PERSON"],
            "token_count": 3,
            **overrides,
        }

    def test_records_what_a_client_surface_reports(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        assert client.post("/pii/activity", json=self.a_beacon()).json() == {"recorded": True}
        recorded = empty_log.recent(limit=10)[0]
        assert recorded.surface is PiiSurface.EXTENSION
        assert dict(recorded.entity_counts) == {"IBAN": 2, "PERSON": 1}

    def test_keeps_the_host_and_trust_class(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        client.post("/pii/activity", json=self.a_beacon())
        browser = empty_log.recent(limit=1)[0].browser
        assert (browser.host, browser.trust_class, browser.action) == ("crm.internal", "NATIVE", "mint")

    def test_an_ingested_event_never_carries_captured_text(self, client, as_key, empty_log):
        """The ingest model has no field for it, so a client cannot push page text in."""
        as_key(PLAIN_KEY)
        client.post("/pii/activity", json={**self.a_beacon(), "capture": {"before": ["secret"]}})
        assert empty_log.recent(limit=1)[0].capture is None

    def test_a_blocked_egress_is_recorded_as_blocked(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        client.post("/pii/activity", json=self.a_beacon(action="egress-block", blocked_entity_type="IBAN"))
        assert empty_log.recent(limit=1)[0].outcome == Blocked(entity_type="IBAN")

    def test_a_failure_is_recorded_with_its_reason(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        client.post("/pii/activity", json=self.a_beacon(failed_reason="no vault"))
        assert empty_log.recent(limit=1)[0].outcome == Failed(reason="no vault")

    def test_attributes_the_event_to_the_calling_key(self, client, as_key, empty_log):
        as_key(PLAIN_KEY)
        client.post("/pii/activity", json=self.a_beacon())
        assert empty_log.recent(limit=1)[0].key_alias == "plain-key"

    def test_rejects_an_unknown_direction(self, client, as_key):
        as_key(PLAIN_KEY)
        assert client.post("/pii/activity", json=self.a_beacon(direction="exfiltrate")).status_code == 422

    def test_rejects_an_overlong_host(self, client, as_key):
        as_key(PLAIN_KEY)
        assert client.post("/pii/activity", json=self.a_beacon(host="h" * 300)).status_code == 422


class TestUnscannedOutcome:
    def test_an_unscanned_request_is_reported_distinctly_from_a_failure(self, client, as_key, empty_log):
        from litellm.pii.activity import Unscanned

        as_key(ADMIN_KEY)
        empty_log.record(an_event(outcome=Unscanned(reason="no PII detector is configured")))
        outcome = client.get("/pii/activity").json()["events"][0]["outcome"]
        assert outcome["kind"] == "unscanned"
        assert outcome["reason"] == "no PII detector is configured"
