import base64
import json
import time
from unittest.mock import mock_open, patch

import pytest

from litellm.llms.chatgpt.authenticator import Authenticator


def _make_jwt(payload: dict) -> str:
    header = {"alg": "none", "typ": "JWT"}

    def _b64(obj: dict) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

    return f"{_b64(header)}.{_b64(payload)}."


class TestChatGPTAuthenticator:
    @pytest.fixture
    def authenticator(self):
        with patch("os.path.exists", return_value=True):
            return Authenticator()

    def test_get_access_token_from_file(self, authenticator):
        future_time = time.time() + 3600
        auth_data = json.dumps({"access_token": "token-123", "expires_at": future_time})

        with patch("builtins.open", mock_open(read_data=auth_data)):
            token = authenticator.get_access_token()
            assert token == "token-123"

    def test_get_access_token_refresh(self, authenticator):
        past_time = time.time() - 10
        auth_data = json.dumps(
            {
                "access_token": "token-old",
                "refresh_token": "refresh-123",
                "expires_at": past_time,
            }
        )
        refreshed = {
            "access_token": "token-new",
            "refresh_token": "refresh-123",
            "id_token": "id-123",
        }

        with (
            patch("builtins.open", mock_open(read_data=auth_data)),
            patch.object(authenticator, "_refresh_tokens", return_value=refreshed),
        ):
            token = authenticator.get_access_token()
            assert token == "token-new"

    def test_get_account_id_from_id_token(self, authenticator):
        id_token = _make_jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "acct-123"}})
        auth_data = json.dumps({"id_token": id_token})

        with (
            patch("builtins.open", mock_open(read_data=auth_data)),
            patch.object(authenticator, "_write_auth_file") as mock_write,
        ):
            account_id = authenticator.get_account_id()
            assert account_id == "acct-123"
            mock_write.assert_called_once()
            assert mock_write.call_args[0][0]["account_id"] == "acct-123"


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise AssertionError(f"unexpected raise_for_status at {self.status_code}")


class FakeClient:
    def __init__(self, *responses):
        self._responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self._responses.pop(0)


APPROVED = {"authorization_code": "ac", "code_challenge": "cc", "code_verifier": "cv"}


class TestNonBlockingDeviceLogin:
    """The split that lets a browser own the waiting instead of a blocked request."""

    @pytest.fixture
    def authenticator(self):
        with patch("os.path.exists", return_value=True):
            return Authenticator()

    def test_a_single_poll_returns_the_code_once_approved(self, authenticator):
        client = FakeClient(FakeResponse(200, APPROVED))
        with patch("litellm.llms.chatgpt.authenticator._get_httpx_client", return_value=client):
            assert authenticator.poll_device_login("dev-1", "ABCD") == APPROVED

    @pytest.mark.parametrize("status", [403, 404])
    def test_not_yet_approved_reads_as_pending_rather_than_an_error(self, authenticator, status):
        client = FakeClient(FakeResponse(status))
        with patch("litellm.llms.chatgpt.authenticator._get_httpx_client", return_value=client):
            assert authenticator.poll_device_login("dev-1", "ABCD") is None

    def test_a_200_missing_the_code_fields_is_pending_not_success(self, authenticator):
        client = FakeClient(FakeResponse(200, {"authorization_code": "ac"}))
        with patch("litellm.llms.chatgpt.authenticator._get_httpx_client", return_value=client):
            assert authenticator.poll_device_login("dev-1", "ABCD") is None

    def test_one_poll_makes_exactly_one_request(self, authenticator):
        """A blocking retry loop here would be the bug this method exists to avoid."""
        client = FakeClient(FakeResponse(404))
        with patch("litellm.llms.chatgpt.authenticator._get_httpx_client", return_value=client):
            authenticator.poll_device_login("dev-1", "ABCD")
        assert len(client.calls) == 1

    def test_sign_out_removes_the_stored_session(self, authenticator):
        with patch("os.remove") as removed:
            authenticator.sign_out()
        removed.assert_called_once_with(authenticator.auth_file)

    def test_sign_out_on_a_machine_that_never_signed_in_is_not_an_error(self, authenticator):
        with patch("os.remove", side_effect=OSError("no such file")):
            authenticator.sign_out()

    def test_has_session_is_false_without_a_token(self, authenticator):
        with patch("builtins.open", mock_open(read_data=json.dumps({}))):
            assert authenticator.has_session() is False

    def test_has_session_is_true_with_one(self, authenticator):
        with patch("builtins.open", mock_open(read_data=json.dumps({"access_token": "t"}))):
            assert authenticator.has_session() is True

    def test_has_session_does_not_trigger_a_login(self, authenticator):
        """Asking whether we are signed in must never start signing in."""
        with patch("builtins.open", side_effect=OSError("missing")):
            with patch.object(Authenticator, "_login_device_code", side_effect=AssertionError("logged in")):
                assert authenticator.has_session() is False

    def test_expiry_is_reported_when_stored(self, authenticator):
        with patch("builtins.open", mock_open(read_data=json.dumps({"expires_at": 1800000000.0}))):
            assert authenticator.session_expires_at() == 1800000000.0

    def test_expiry_is_none_when_not_stored(self, authenticator):
        with patch("builtins.open", mock_open(read_data=json.dumps({"access_token": "t"}))):
            assert authenticator.session_expires_at() is None
