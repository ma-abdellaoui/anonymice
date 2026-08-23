"""Tests for signing in to a ChatGPT subscription from the Admin UI."""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath("../../../.."))

import litellm.proxy.proxy_server as ps
from litellm.llms.chatgpt.common_utils import GetAccessTokenError, GetDeviceCodeError
from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.chatgpt_endpoints.endpoints import get_authenticator
from litellm.proxy.proxy_server import app

ADMIN = UserAPIKeyAuth(user_role=LitellmUserRoles.PROXY_ADMIN, user_id="admin", api_key="sk-admin")
NOT_ADMIN = UserAPIKeyAuth(user_role=LitellmUserRoles.INTERNAL_USER, user_id="dev", api_key="sk-dev")

APPROVED = {"authorization_code": "ac", "code_challenge": "cc", "code_verifier": "cv"}


class FakeAuthenticator:
    """Stands in for the real one, which would write a credential and call OpenAI."""

    def __init__(self, *, signed_in=False, approve_on=None, start_error=None, poll_error=None):
        self.signed_in = signed_in
        self.approve_on = approve_on
        self.start_error = start_error
        self.poll_error = poll_error
        self.polls = 0
        self.completed = None
        self.signed_out = False

    def begin_device_login(self):
        if self.start_error:
            raise self.start_error
        return {"device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "5"}

    def poll_device_login(self, device_auth_id, user_code):
        if self.poll_error:
            raise self.poll_error
        self.polls += 1
        return APPROVED if self.polls == self.approve_on else None

    def complete_device_login(self, code_data):
        self.completed = code_data
        self.signed_in = True

    def has_session(self):
        return self.signed_in

    def get_account_id(self):
        return "acct-123" if self.signed_in else None

    def session_expires_at(self):
        return 1800000000.0 if self.signed_in else None

    def sign_out(self):
        self.signed_out = True
        self.signed_in = False


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def as_key():
    def _as(key):
        app.dependency_overrides[ps.user_api_key_auth] = lambda: key

    yield _as
    app.dependency_overrides.pop(ps.user_api_key_auth, None)


@pytest.fixture
def install():
    def _install(authenticator):
        app.dependency_overrides[get_authenticator] = lambda: authenticator
        return authenticator

    yield _install
    app.dependency_overrides.pop(get_authenticator, None)


class TestAuthorization:
    @pytest.mark.parametrize(
        "method,path,body",
        [
            ("get", "/chatgpt/login", None),
            ("post", "/chatgpt/login/start", {}),
            ("post", "/chatgpt/login/poll", {"device_auth_id": "d", "user_code": "u"}),
            ("delete", "/chatgpt/login", None),
        ],
    )
    def test_a_non_admin_is_refused_every_route(self, client, as_key, install, method, path, body):
        """This writes a credential to the proxy's disk and spends a subscription."""
        install(FakeAuthenticator())
        as_key(NOT_ADMIN)
        response = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert response.status_code == 403

    def test_a_refused_start_never_requests_a_code(self, client, as_key, install):
        fake = install(FakeAuthenticator())
        as_key(NOT_ADMIN)
        client.post("/chatgpt/login/start")
        assert fake.polls == 0 and fake.completed is None


class TestStatus:
    def test_reports_no_session_when_there_is_none(self, client, as_key, install):
        install(FakeAuthenticator(signed_in=False))
        as_key(ADMIN)
        assert client.get("/chatgpt/login").json() == {"signed_in": False, "account_id": None, "expires_at": None}

    def test_reports_the_account_when_signed_in(self, client, as_key, install):
        install(FakeAuthenticator(signed_in=True))
        as_key(ADMIN)
        body = client.get("/chatgpt/login").json()
        assert body["signed_in"] is True and body["account_id"] == "acct-123"

    def test_never_returns_the_token_itself(self, client, as_key, install):
        install(FakeAuthenticator(signed_in=True))
        as_key(ADMIN)
        assert "access_token" not in client.get("/chatgpt/login").text


class TestStart:
    def test_hands_back_the_code_and_where_to_enter_it(self, client, as_key, install):
        install(FakeAuthenticator())
        as_key(ADMIN)
        body = client.post("/chatgpt/login/start").json()
        assert body["user_code"] == "ABCD-1234"
        assert body["device_auth_id"] == "dev-1"
        assert body["verification_url"].startswith("https://")

    def test_returns_immediately_rather_than_waiting_for_approval(self, client, as_key, install):
        """The whole point of the split: the browser owns the waiting, not the request."""
        fake = install(FakeAuthenticator(approve_on=None))
        as_key(ADMIN)
        assert client.post("/chatgpt/login/start").status_code == 200
        assert fake.polls == 0

    def test_a_provider_failure_surfaces_as_a_gateway_error(self, client, as_key, install):
        install(FakeAuthenticator(start_error=GetDeviceCodeError(message="upstream down", status_code=500)))
        as_key(ADMIN)
        response = client.post("/chatgpt/login/start")
        assert response.status_code == 502 and "upstream down" in response.text


class TestPoll:
    def a_poll(self, client):
        return client.post("/chatgpt/login/poll", json={"device_auth_id": "dev-1", "user_code": "ABCD-1234"})

    def test_reports_pending_while_the_person_has_not_approved(self, client, as_key, install):
        install(FakeAuthenticator(approve_on=None))
        as_key(ADMIN)
        assert self.a_poll(client).json() == {"status": "pending", "account_id": None}

    def test_completes_and_stores_the_session_once_approved(self, client, as_key, install):
        fake = install(FakeAuthenticator(approve_on=1))
        as_key(ADMIN)
        body = self.a_poll(client).json()
        assert body["status"] == "complete" and body["account_id"] == "acct-123"
        assert fake.completed == APPROVED

    def test_pending_does_not_store_anything(self, client, as_key, install):
        fake = install(FakeAuthenticator(approve_on=None))
        as_key(ADMIN)
        self.a_poll(client)
        assert fake.completed is None and fake.signed_in is False

    def test_a_polling_failure_surfaces_rather_than_looking_pending(self, client, as_key, install):
        install(FakeAuthenticator(poll_error=GetAccessTokenError(message="revoked", status_code=400)))
        as_key(ADMIN)
        response = self.a_poll(client)
        assert response.status_code == 502 and "revoked" in response.text

    def test_rejects_an_empty_device_id(self, client, as_key, install):
        install(FakeAuthenticator())
        as_key(ADMIN)
        assert client.post("/chatgpt/login/poll", json={"device_auth_id": "", "user_code": "u"}).status_code == 422


class TestSignOut:
    def test_forgets_the_session(self, client, as_key, install):
        fake = install(FakeAuthenticator(signed_in=True))
        as_key(ADMIN)
        assert client.delete("/chatgpt/login").json()["signed_in"] is False
        assert fake.signed_out is True
