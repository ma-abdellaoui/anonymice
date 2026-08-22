from collections.abc import Iterable
from functools import reduce
from itertools import chain
from typing import Final

from litellm.pii.types import DetectorKind, PiiSpan

MAX_COALESCE_GAP: Final = 1


def _overlaps(left: PiiSpan, right: PiiSpan) -> bool:
    return left.start < right.end and right.start < left.end


def _selection_priority(span: PiiSpan) -> tuple[float, int, int, int]:
    """Higher sorts first: score, then rules over NER, then longer, then leftmost."""
    return (
        span.score,
        1 if span.detector is DetectorKind.RULES else 0,
        span.length,
        -span.start,
    )


def _accept_if_disjoint(accepted: tuple[PiiSpan, ...], candidate: PiiSpan) -> tuple[PiiSpan, ...]:
    if any(_overlaps(candidate, span) for span in accepted):
        return accepted
    return (*accepted, candidate)


def resolve_overlaps(spans: Iterable[PiiSpan]) -> tuple[PiiSpan, ...]:
    """Drop overlapping spans, keeping the highest-priority one from each cluster."""
    ranked: Final = sorted(spans, key=_selection_priority, reverse=True)
    accepted: Final = reduce(_accept_if_disjoint, ranked, ())
    return tuple(sorted(accepted, key=lambda span: span.start))


def _is_coalescable(left: PiiSpan, right: PiiSpan, text: str) -> bool:
    if left.entity_type != right.entity_type:
        return False
    gap: Final = text[left.end : right.start]
    return len(gap) <= MAX_COALESCE_GAP and gap.strip() == ""


def _coalesce_step(merged: tuple[PiiSpan, ...], candidate: PiiSpan, text: str) -> tuple[PiiSpan, ...]:
    if not merged:
        return (candidate,)
    previous: Final = merged[-1]
    if not _is_coalescable(previous, candidate, text):
        return (*merged, candidate)
    joined: Final = PiiSpan(
        entity_type=previous.entity_type,
        start=previous.start,
        end=candidate.end,
        score=min(previous.score, candidate.score),
        detector=previous.detector,
    )
    return (*merged[:-1], joined)


def coalesce_adjacent(spans: Iterable[PiiSpan], text: str) -> tuple[PiiSpan, ...]:
    """Join same-entity spans separated only by a single space.

    Token-classification models emit given name and surname as separate spans
    that both map to PERSON; joining them yields one token for "Ada Lovelace"
    instead of two, which reads far better to the downstream model.
    """
    ordered: Final = sorted(spans, key=lambda span: span.start)
    return reduce(lambda acc, span: _coalesce_step(acc, span, text), ordered, ())


def merge_spans(text: str, *groups: Iterable[PiiSpan]) -> tuple[PiiSpan, ...]:
    return coalesce_adjacent(resolve_overlaps(chain.from_iterable(groups)), text)
