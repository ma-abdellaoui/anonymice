"""What the PII layer did, as a bounded in-process log.

A record carries counts, entity types, timings and an outcome, never a value.
Text capture is a separate, opt-in field so the surface built to demonstrate
that the anonymizer works cannot itself become the leak it exists to prevent.

The ring is per-process and holds nothing durable. A split gateway/backend
deployment therefore reads only what its own workers produced, and a restart
starts empty; a shared store is the fix and is deliberately not paid for until
something needs to retain these longer than a demo or a debugging session.
"""

import asyncio
import os
from collections import Counter, deque
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from itertools import islice
from types import MappingProxyType
from typing import Final, Literal, Protocol, TypeAlias

from litellm._uuid import uuid
from litellm.pii.codec.action_aware import SpanAction
from litellm.pii.codec.grammar import TokenGrammar
from litellm.pii.codec.transform import Placement
from litellm.pii.types import DetectorKind, PiiSpan
from litellm.secret_managers.main import str_to_bool

ENV_CAPTURE_TEXT: Final = "LITELLM_PII_ACTIVITY_CAPTURE_TEXT"
ENV_CAPACITY: Final = "LITELLM_PII_ACTIVITY_CAPACITY"
DEFAULT_CAPACITY: Final = 500
SUBSCRIBER_BACKLOG: Final = 64


class ActionLookup(Protocol):
    def __call__(self, entity_type: str) -> SpanAction: ...


class PiiSurface(str, Enum):
    """Which half of the system produced the event."""

    GUARDRAIL = "guardrail"
    ENDPOINT = "endpoint"
    EXTENSION = "extension"


class PiiDirection(str, Enum):
    DETECT = "detect"
    ENCODE = "encode"
    DECODE = "decode"


@dataclass(frozen=True, slots=True)
class Applied:
    kind: Literal["applied"] = "applied"


@dataclass(frozen=True, slots=True)
class Blocked:
    entity_type: str
    kind: Literal["blocked"] = "blocked"


@dataclass(frozen=True, slots=True)
class Failed:
    reason: str
    kind: Literal["failed"] = "failed"


@dataclass(frozen=True, slots=True)
class Unscanned:
    """Text reached the provider without being scanned at all.

    Distinct from a failure because the request succeeded. It is the one outcome
    that looks like nothing happened and means real data left, so it gets its
    own arm rather than being folded into ``Failed``.
    """

    reason: str
    kind: Literal["unscanned"] = "unscanned"


PiiOutcome: TypeAlias = Applied | Blocked | Failed | Unscanned


@dataclass(frozen=True, slots=True)
class TokenPlacement:
    """One span and the token that replaced it.

    ``value`` is the protected data, so this type is only ever reachable through
    :class:`TextCapture`, which is built only when capture is switched on.
    """

    token: str
    entity_type: str
    detector: DetectorKind
    score: float
    action: SpanAction
    text_index: int
    start: int
    end: int
    value: str


@dataclass(frozen=True, slots=True)
class TextCapture:
    before: tuple[str, ...]
    after: tuple[str, ...]
    placements: tuple[TokenPlacement, ...]


@dataclass(frozen=True, slots=True)
class BrowserContext:
    """Where in the browser an extension event happened.

    Host and trust class only. The full URL is browsing history, and the page
    text is the thing the extension exists to keep out of logs.
    """

    host: str
    trust_class: str
    action: str


@dataclass(frozen=True, slots=True)
class PiiActivityEvent:
    id: str
    at: datetime
    surface: PiiSurface
    direction: PiiDirection
    outcome: PiiOutcome
    duration_ms: float
    entity_counts: Mapping[str, int]
    action_counts: Mapping[str, int]
    token_count: int
    resolved_count: int
    ner_stage_ran: bool
    request_id: str | None = None
    session_id: str | None = None
    key_alias: str | None = None
    user_id: str | None = None
    model: str | None = None
    guardrail_name: str | None = None
    browser: BrowserContext | None = None
    capture: TextCapture | None = None


def capture_enabled() -> bool:
    """Whether events may carry the text they describe.

    Off unless deliberately switched on, because the honest default for a log
    about sensitive data is that it does not contain any.
    """
    return str_to_bool(os.getenv(ENV_CAPTURE_TEXT)) is True


def _capacity_from_env() -> int:
    raw: Final = os.getenv(ENV_CAPACITY)
    if raw is None:
        return DEFAULT_CAPACITY
    try:
        parsed: Final = int(raw)
    except ValueError:
        return DEFAULT_CAPACITY
    return parsed if parsed > 0 else DEFAULT_CAPACITY


def counts_of(values: Iterable[str]) -> Mapping[str, int]:
    return MappingProxyType(dict(Counter(values)))


def entity_counts_of(spans_by_text: Sequence[Sequence[PiiSpan]]) -> Mapping[str, int]:
    return counts_of(span.entity_type for spans in spans_by_text for span in spans)


def action_counts_of(
    spans_by_text: Sequence[Sequence[PiiSpan]],
    action_for: ActionLookup,
) -> Mapping[str, int]:
    return counts_of(action_for(span.entity_type).value for spans in spans_by_text for span in spans)


def placements_of(
    texts: Sequence[str],
    placements: Sequence[Placement],
    action_for: ActionLookup,
) -> tuple[TokenPlacement, ...]:
    return tuple(
        TokenPlacement(
            token=placement.token,
            entity_type=placement.span.entity_type,
            detector=placement.span.detector,
            score=placement.span.score,
            action=action_for(placement.span.entity_type),
            text_index=placement.text_index,
            start=placement.span.start,
            end=placement.span.end,
            value=placement.span.text_from(texts[placement.text_index]),
        )
        for placement in placements
    )


def capture_of(
    before: Sequence[str],
    after: Sequence[str],
    placements: Sequence[Placement],
    action_for: ActionLookup,
) -> TextCapture | None:
    """A capture when it is switched on, ``None`` when it is not."""
    if not capture_enabled():
        return None
    return TextCapture(
        before=tuple(before),
        after=tuple(after),
        placements=placements_of(before, placements, action_for),
    )


@dataclass(frozen=True, slots=True)
class DecodeTally:
    entity_counts: Mapping[str, int]
    token_count: int
    resolved_count: int


def decode_tally(grammar: TokenGrammar, before: Sequence[str], after: Sequence[str]) -> DecodeTally:
    """What a decode was asked for and what it recovered.

    Counted from the texts rather than reported by the store, so a token left
    verbatim because nothing could resolve it shows up as unresolved instead of
    disappearing from the record.
    """
    present: Final = grammar.canonical_tokens(before)
    parsed: Final = tuple(grammar.parse(token) for token in present)
    return DecodeTally(
        entity_counts=counts_of(token.entity_type for token in parsed if token is not None),
        token_count=len(present),
        resolved_count=len(present - grammar.canonical_tokens(after)),
    )


def new_event(
    surface: PiiSurface,
    direction: PiiDirection,
    outcome: PiiOutcome,
    duration_ms: float,
    entity_counts: Mapping[str, int] = MappingProxyType({}),
    action_counts: Mapping[str, int] = MappingProxyType({}),
    token_count: int = 0,
    resolved_count: int = 0,
    ner_stage_ran: bool = False,
    request_id: str | None = None,
    session_id: str | None = None,
    key_alias: str | None = None,
    user_id: str | None = None,
    model: str | None = None,
    guardrail_name: str | None = None,
    browser: BrowserContext | None = None,
    capture: TextCapture | None = None,
) -> PiiActivityEvent:
    return PiiActivityEvent(
        id=str(uuid.uuid4()),
        at=datetime.now(timezone.utc),
        surface=surface,
        direction=direction,
        outcome=outcome,
        duration_ms=duration_ms,
        entity_counts=entity_counts,
        action_counts=action_counts,
        token_count=token_count,
        resolved_count=resolved_count,
        ner_stage_ran=ner_stage_ran,
        request_id=request_id,
        session_id=session_id,
        key_alias=key_alias,
        user_id=user_id,
        model=model,
        guardrail_name=guardrail_name,
        browser=browser,
        capture=capture,
    )


class PiiActivityLog:
    """A bounded ring plus live subscribers.

    Recording must never be able to fail or block the request it describes, so
    a subscriber that has stopped reading loses events rather than applying
    back pressure to the proxy.
    """

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        self._events: Final[deque[PiiActivityEvent]] = deque(
            maxlen=capacity
        )  # mutable-ok: a bounded ring is the data structure
        self._subscribers: Final[set[asyncio.Queue[PiiActivityEvent]]] = (
            set()
        )  # mutable-ok: membership changes as watchers connect

    def record(self, event: PiiActivityEvent) -> None:
        self._events.append(event)
        for queue in tuple(self._subscribers):
            if not queue.full():
                queue.put_nowait(event)

    def recent(
        self,
        limit: int,
        surface: PiiSurface | None = None,
        direction: PiiDirection | None = None,
    ) -> tuple[PiiActivityEvent, ...]:
        matching: Final = (
            event
            for event in reversed(self._events)
            if (surface is None or event.surface is surface) and (direction is None or event.direction is direction)
        )
        return tuple(islice(matching, limit))

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[PiiActivityEvent]]:
        queue: Final[asyncio.Queue[PiiActivityEvent]] = asyncio.Queue(maxsize=SUBSCRIBER_BACKLOG)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)


_LOG: Final = PiiActivityLog(capacity=_capacity_from_env())


def activity_log() -> PiiActivityLog:
    return _LOG
