"""Read and ingest the PII activity log.

Counts are metadata and any authenticated caller may read them. The captured
text is the protected data itself, so it is withheld under exactly the grant
that governs reading a value back, ``allow_pii_decode``, rather than under a
second rule that could drift away from it.
"""

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Annotated, Final

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from litellm.pii.activity import (
    Applied,
    Blocked,
    BrowserContext,
    Failed,
    PiiActivityEvent,
    PiiDirection,
    PiiOutcome,
    PiiSurface,
    Unscanned,
    activity_log,
    capture_enabled,
    counts_of,
    new_event,
)
from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.pii_endpoints.audit import DECODE_PERMISSION
from litellm.types.proxy.pii_activity import (
    PiiActivityEventModel,
    PiiActivityIngestRequest,
    PiiActivityIngestResponse,
    PiiActivityOutcomeModel,
    PiiActivityResponse,
    PiiBrowserContextModel,
    PiiTextCaptureModel,
    PiiTokenPlacementModel,
)

ACTIVITY_TAGS: Final[list[str]] = ["pii anonymization"]  # mutable-ok: FastAPI copies and mutates router tags
activity_router: Final = APIRouter(prefix="/pii/activity", tags=ACTIVITY_TAGS)

DEFAULT_LIMIT: Final = 100
MAX_LIMIT: Final = 500
STREAM_KEEPALIVE_SECONDS: Final = 15.0


def may_read_capture(user_api_key_dict: UserAPIKeyAuth) -> bool:
    """Reading a capture is reading a value, so it needs the decode grant."""
    return (
        user_api_key_dict.user_role == LitellmUserRoles.PROXY_ADMIN.value
        or user_api_key_dict.permissions.get(DECODE_PERMISSION) is True
    )


def _outcome_model(outcome: PiiOutcome) -> PiiActivityOutcomeModel:
    match outcome:
        case Applied():
            return PiiActivityOutcomeModel(kind="applied")
        case Blocked(entity_type=entity_type):
            return PiiActivityOutcomeModel(kind="blocked", entity_type=entity_type)
        case Failed(reason=reason):
            return PiiActivityOutcomeModel(kind="failed", reason=reason)
        case Unscanned(reason=reason):
            return PiiActivityOutcomeModel(kind="unscanned", reason=reason)


def _capture_model(event: PiiActivityEvent, with_capture: bool) -> PiiTextCaptureModel | None:
    if event.capture is None or not with_capture:
        return None
    return PiiTextCaptureModel(
        before=event.capture.before,
        after=event.capture.after,
        placements=tuple(
            PiiTokenPlacementModel(
                token=placement.token,
                entity_type=placement.entity_type,
                detector=placement.detector.value,
                score=placement.score,
                action=placement.action.value,
                text_index=placement.text_index,
                start=placement.start,
                end=placement.end,
                value=placement.value,
            )
            for placement in event.capture.placements
        ),
    )


def _browser_model(browser: BrowserContext | None) -> PiiBrowserContextModel | None:
    if browser is None:
        return None
    return PiiBrowserContextModel(host=browser.host, trust_class=browser.trust_class, action=browser.action)


def to_model(event: PiiActivityEvent, with_capture: bool) -> PiiActivityEventModel:
    return PiiActivityEventModel(
        id=event.id,
        at=event.at,
        surface=event.surface,
        direction=event.direction,
        outcome=_outcome_model(event.outcome),
        duration_ms=event.duration_ms,
        entity_counts=event.entity_counts,
        action_counts=event.action_counts,
        token_count=event.token_count,
        resolved_count=event.resolved_count,
        ner_stage_ran=event.ner_stage_ran,
        request_id=event.request_id,
        session_id=event.session_id,
        key_alias=event.key_alias,
        user_id=event.user_id,
        model=event.model,
        guardrail_name=event.guardrail_name,
        browser=_browser_model(event.browser),
        capture=_capture_model(event, with_capture),
        capture_withheld=event.capture is not None and not with_capture,
    )


@activity_router.get("", response_model=PiiActivityResponse)
async def read_pii_activity(
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    surface: PiiSurface | None = None,
    direction: PiiDirection | None = None,
    request_id: Annotated[str | None, Query(max_length=200)] = None,
) -> PiiActivityResponse:
    """The most recent events this worker recorded, newest first.

    ``request_id`` narrows to one completion, which is how a caller holding the
    ``x-litellm-call-id`` of a request it just made reads back what the
    guardrail did to that request and nothing else.
    """
    with_capture: Final = may_read_capture(user_api_key_dict)
    events: Final = activity_log().recent(
        limit=limit,
        surface=surface,
        direction=direction,
        request_id=request_id,
    )
    return PiiActivityResponse(
        events=tuple(to_model(event, with_capture) for event in events),
        capture_enabled=capture_enabled(),
    )


async def _events(user_api_key_dict: UserAPIKeyAuth) -> AsyncIterator[str]:
    """Server-sent events, with a comment frame so an idle proxy hop stays open."""
    with_capture: Final = may_read_capture(user_api_key_dict)
    async with activity_log().subscribe() as queue:
        while True:
            try:
                event: Final = await asyncio.wait_for(queue.get(), timeout=STREAM_KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield f"data: {to_model(event, with_capture).model_dump_json()}\n\n"


@activity_router.get("/stream")
async def stream_pii_activity(
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> StreamingResponse:
    """Live tail, so the log can be watched next to whatever is producing it."""
    return StreamingResponse(
        _events(user_api_key_dict),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},  # mutable-ok: Starlette takes a plain dict
    )


def _ingest_outcome(request: PiiActivityIngestRequest) -> PiiOutcome:
    if request.blocked_entity_type is not None:
        return Blocked(entity_type=request.blocked_entity_type)
    if request.failed_reason is not None:
        return Failed(reason=request.failed_reason)
    return Applied()


@activity_router.post("", response_model=PiiActivityIngestResponse)
async def ingest_pii_activity(
    request: PiiActivityIngestRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> PiiActivityIngestResponse:
    """Report what a client-side surface did.

    The browser extension is the caller. It sends entity classes and counts and
    never the page text, which is the same rule its own logger enforces, so the
    two halves of the product show up in one place without either of them
    turning into a transcript of what someone was reading.
    """
    activity_log().record(
        new_event(
            surface=PiiSurface.EXTENSION,
            direction=request.direction,
            outcome=_ingest_outcome(request),
            duration_ms=request.duration_ms,
            entity_counts=_ingest_counts(request.entity_types),
            token_count=request.token_count,
            resolved_count=request.resolved_count,
            key_alias=user_api_key_dict.key_alias,
            user_id=user_api_key_dict.user_id,
            browser=BrowserContext(
                host=request.host,
                trust_class=request.trust_class,
                action=request.action,
            ),
        )
    )
    return PiiActivityIngestResponse(recorded=True)


def _ingest_counts(entity_types: Sequence[str]) -> Mapping[str, int]:
    return counts_of(entity_types)
