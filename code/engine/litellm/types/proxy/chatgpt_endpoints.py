from pydantic import BaseModel, Field


class ChatgptLoginStatus(BaseModel):
    """Whether this proxy holds a ChatGPT subscription session, and whose."""

    signed_in: bool
    account_id: str | None = None
    expires_at: float | None = None


class ChatgptLoginStart(BaseModel):
    """What the person has to do, and what to poll with."""

    verification_url: str
    user_code: str
    device_auth_id: str
    interval_seconds: int


class ChatgptLoginPollRequest(BaseModel):
    device_auth_id: str = Field(min_length=1, max_length=256)
    user_code: str = Field(min_length=1, max_length=64)


class ChatgptLoginPollResponse(BaseModel):
    """``pending`` until the browser tab is approved, then ``complete``."""

    status: str
    account_id: str | None = None
