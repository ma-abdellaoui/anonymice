import asyncio
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Final

from litellm.pii.detection.base import PiiDetector
from litellm.pii.types import DetectionError, PiiSpan

# A transformer's attention cost grows with the square of the input, so one
# long prompt takes far longer than the same text split up: measured against
# the NER stage, 4k characters answered in 0.8s and 13k in 13.9s, past the
# detector timeout. Windows keep each call in the flat part of that curve.
DEFAULT_MAX_CHARS: Final = 2000

# Wide enough that an entity cut by a window edge is whole inside the next
# window, since edge-touching spans are dropped in favour of that copy.
DEFAULT_OVERLAP_CHARS: Final = 200

# Preferred cut points, most structural first. Splitting on a blank line rather
# than mid-sentence keeps each window readable to a model that uses context.
BOUNDARIES: Final = ("\n\n", "\n", ". ", ", ", " ")


@dataclass(frozen=True, slots=True)
class Window:
    """A slice of the original text, carrying the offset needed to map spans back."""

    start: int
    end: int

    def text_from(self, text: str) -> str:
        return text[self.start : self.end]


def _cut_at(text: str, floor: int, ceiling: int) -> int:
    """The latest natural boundary in ``[floor, ceiling)``, or ``ceiling`` if there is none."""
    for boundary in BOUNDARIES:
        found = text.rfind(boundary, floor, ceiling)
        if found > floor:
            return found + len(boundary)
    return ceiling


def plan_windows(text: str, max_chars: int, overlap_chars: int) -> tuple[Window, ...]:
    """Cover ``text`` with overlapping windows of at most ``max_chars``.

    Every character lands in at least one window, and consecutive windows share
    ``overlap_chars``, so an entity straddling a cut is intact in one of them.
    """
    if len(text) <= max_chars:
        return (Window(start=0, end=len(text)),)
    # Guarantee forward progress even if the caller asks for an overlap that
    # would otherwise make each window start where the previous one did.
    stride: Final = max(max_chars - overlap_chars, max_chars // 2, 1)
    windows: list[Window] = []  # mutable-ok: accumulator, frozen into a tuple on return
    start = 0
    while start < len(text):
        ceiling = min(start + max_chars, len(text))
        end = ceiling if ceiling == len(text) else _cut_at(text, start + stride // 2, ceiling)
        windows.append(Window(start=start, end=end))
        if end >= len(text):
            break
        start = max(end - overlap_chars, start + 1)
    return tuple(windows)


def _touches_interior_edge(span: PiiSpan, window: Window, length: int) -> bool:
    """Whether a span runs into a cut, meaning a neighbouring window holds it whole.

    Only interior edges count: a span at the very start or end of the text was
    not cut by us, so dropping it would lose it entirely.
    """
    at_start: Final = span.start == 0 and window.start > 0
    at_end: Final = span.end == window.end - window.start and window.end < length
    return at_start or at_end


def shift_spans(spans: Iterable[PiiSpan], window: Window, length: int) -> tuple[PiiSpan, ...]:
    """Re-index window-relative spans onto the original text, dropping cut ones."""
    return tuple(
        replace(span, start=span.start + window.start, end=span.end + window.start)
        for span in spans
        if not _touches_interior_edge(span, window, length)
    )


@dataclass(frozen=True, slots=True)
class ChunkedDetector:
    """Runs an inner detector over windows when the text is too long for one call.

    Short text is handed straight through, so ordinary traffic keeps the exact
    behaviour and latency of the detector being wrapped. Only oversized text
    pays for the split, and the windows run concurrently, so wall-clock stays
    close to the cost of a single window.
    """

    inner: PiiDetector
    max_chars: int = DEFAULT_MAX_CHARS
    overlap_chars: int = DEFAULT_OVERLAP_CHARS

    async def detect(
        self,
        text: str,
        language: str,
        entities: Sequence[str] | None,
    ) -> tuple[PiiSpan, ...] | DetectionError:
        windows: Final = plan_windows(text, self.max_chars, self.overlap_chars)
        if len(windows) == 1:
            return await self.inner.detect(text=text, language=language, entities=entities)

        results: Final = await asyncio.gather(
            *(
                self.inner.detect(text=window.text_from(text), language=language, entities=entities)
                for window in windows
            )
        )
        # One failed window means an unknown part of the text went unscanned, so
        # the whole detection fails rather than reporting a partial answer that
        # reads like a clean one.
        for result in results:
            if not isinstance(result, tuple):
                return result
        return tuple(
            span
            for window, result in zip(windows, results)
            if isinstance(result, tuple)
            for span in shift_spans(result, window, len(text))
        )
