"""Sign in to a ChatGPT subscription from the Admin UI.

The device-code flow needs someone to open a page and type a code, which a CLI
does by blocking for fifteen minutes. Splitting it into start, poll and status
lets a browser do the waiting instead, against the same
:class:`~litellm.llms.chatgpt.authenticator.Authenticator` the provider uses,
so a session created here is the one an inference call picks up.

Admin-only: this writes a credential to the proxy's own disk, and every request
that afterwards routes to a ``chatgpt/*`` model spends that subscription.
"""

from typing import Annotated, Final

from fastapi import APIRouter, Depends, HTTPException

from litellm.llms.chatgpt.authenticator import Authenticator
from litellm.llms.chatgpt.common_utils import (
    CHATGPT_DEVICE_VERIFY_URL,
    GetAccessTokenError,
    GetDeviceCodeError,
)
from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.types.proxy.chatgpt_endpoints import (
    ChatgptLoginPollRequest,
    ChatgptLoginPollResponse,
    ChatgptLoginStart,
    ChatgptLoginStatus,
)

CHATGPT_TAGS: Final[list[str]] = ["chatgpt subscription"]  # mutable-ok: FastAPI copies and mutates router tags
chatgpt_router: Final = APIRouter(prefix="/chatgpt/login", tags=CHATGPT_TAGS)

PENDING: Final = "pending"
COMPLETE: Final = "complete"


def get_authenticator() -> Authenticator:
    """Injected so a test can drive the routes without touching a real token file."""
    return Authenticator()


def require_admin(user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)]) -> UserAPIKeyAuth:
    if user_api_key_dict.user_role != LitellmUserRoles.PROXY_ADMIN.value:
        raise HTTPException(
            status_code=403,
            detail={"error": "Signing in to a ChatGPT subscription is restricted to proxy admins."},
        )
    return user_api_key_dict


@chatgpt_router.get("", response_model=ChatgptLoginStatus)
async def read_chatgpt_login(
    _: Annotated[UserAPIKeyAuth, Depends(require_admin)],
    authenticator: Annotated[Authenticator, Depends(get_authenticator)],
) -> ChatgptLoginStatus:
    """Whether a session exists. Never returns the token itself."""
    if not authenticator.has_session():
        return ChatgptLoginStatus(signed_in=False)
    return ChatgptLoginStatus(
        signed_in=True,
        account_id=authenticator.get_account_id(),
        expires_at=authenticator.session_expires_at(),
    )


@chatgpt_router.post("/start", response_model=ChatgptLoginStart)
async def start_chatgpt_login(
    _: Annotated[UserAPIKeyAuth, Depends(require_admin)],
    authenticator: Annotated[Authenticator, Depends(get_authenticator)],
) -> ChatgptLoginStart:
    """Request a device code and hand back what to show the person."""
    try:
        device_code: Final = authenticator.begin_device_login()
    except GetDeviceCodeError as exc:
        raise HTTPException(status_code=502, detail={"error": exc.message})

    return ChatgptLoginStart(
        verification_url=CHATGPT_DEVICE_VERIFY_URL,
        user_code=device_code["user_code"],
        device_auth_id=device_code["device_auth_id"],
        interval_seconds=int(device_code.get("interval") or 5),
    )


@chatgpt_router.post("/poll", response_model=ChatgptLoginPollResponse)
async def poll_chatgpt_login(
    request: ChatgptLoginPollRequest,
    _: Annotated[UserAPIKeyAuth, Depends(require_admin)],
    authenticator: Annotated[Authenticator, Depends(get_authenticator)],
) -> ChatgptLoginPollResponse:
    """Check once whether the code has been approved, and finish if it has."""
    try:
        approved: Final = authenticator.poll_device_login(request.device_auth_id, request.user_code)
    except GetAccessTokenError as exc:
        raise HTTPException(status_code=502, detail={"error": exc.message})

    if approved is None:
        return ChatgptLoginPollResponse(status=PENDING)

    try:
        authenticator.complete_device_login(approved)
    except GetAccessTokenError as exc:
        raise HTTPException(status_code=502, detail={"error": exc.message})
    return ChatgptLoginPollResponse(status=COMPLETE, account_id=authenticator.get_account_id())


@chatgpt_router.delete("", response_model=ChatgptLoginStatus)
async def end_chatgpt_login(
    _: Annotated[UserAPIKeyAuth, Depends(require_admin)],
    authenticator: Annotated[Authenticator, Depends(get_authenticator)],
) -> ChatgptLoginStatus:
    """Forget the session on this proxy."""
    authenticator.sign_out()
    return ChatgptLoginStatus(signed_in=False)
