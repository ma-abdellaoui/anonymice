from collections.abc import Mapping
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from litellm.pii.activity import PiiDirection, PiiSurface


class PiiActivityOutcomeModel(BaseModel):
    kind: Literal["applied", "blocked", "failed"]
    entity_type: str | None = None
    reason: str | None = None


class PiiTokenPlacementModel(BaseModel):
    """One span and the token that replaced it, including the value it stood for."""

    token: str
    entity_type: str
    detector: str
    score: float
    action: str
    text_index: int
    start: int
    end: int
    value: str


class PiiTextCaptureModel(BaseModel):
    before: tuple[str, ...]
    after: tuple[str, ...]
    placements: tuple[PiiTokenPlacementModel, ...]


class PiiBrowserContextModel(BaseModel):
    host: str
    trust_class: str
    action: str


class PiiActivityEventModel(BaseModel):
    id: str
    at: datetime
    surface: PiiSurface
    direction: PiiDirection
    outcome: PiiActivityOutcomeModel
    duration_ms: float
    entity_counts: Mapping[str, int]
    action_counts: Mapping[str, int]
    token_count: int
    resolved_count: int
    ner_stage_ran: bool
    request_id: str | None
    session_id: str | None
    key_alias: str | None
    user_id: str | None
    model: str | None
    guardrail_name: str | None
    browser: PiiBrowserContextModel | None
    capture: PiiTextCaptureModel | None
    capture_withheld: bool


class PiiActivityResponse(BaseModel):
    events: tuple[PiiActivityEventModel, ...]
    capture_enabled: bool


class PiiActivityIngestRequest(BaseModel):
    """What a client-side surface reports. Entity classes and counts, never text."""

    direction: PiiDirection
    action: str = Field(max_length=64)
    host: str = Field(max_length=255)
    trust_class: str = Field(max_length=32)
    entity_types: tuple[str, ...] = ()
    token_count: int = Field(default=0, ge=0)
    resolved_count: int = Field(default=0, ge=0)
    duration_ms: float = Field(default=0.0, ge=0.0)
    blocked_entity_type: str | None = Field(default=None, max_length=64)
    failed_reason: str | None = Field(default=None, max_length=200)


class PiiActivityIngestResponse(BaseModel):
    recorded: bool
