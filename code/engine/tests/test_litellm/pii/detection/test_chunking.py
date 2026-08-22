import asyncio
from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from litellm.pii.detection.chunking import (
    ChunkedDetector,
    plan_windows,
    shift_spans,
)
from litellm.pii.types import DetectorKind, DetectorUnavailable, PiiSpan


def span(start: int, end: int, entity_type: str = "PERSON") -> PiiSpan:
    return PiiSpan(entity_type=entity_type, start=start, end=end, score=0.9, detector=DetectorKind.NER)


@dataclass
class RecordingDetector:
    """Finds a fixed needle in whatever slice it is handed."""

    needle: str
    calls: list = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.calls = []

    async def detect(self, text: str, language: str, entities: Sequence[str] | None):
        self.calls.append(text)
        return tuple(
            span(index, index + len(self.needle)) for index in range(len(text)) if text.startswith(self.needle, index)
        )


class FailingDetector:
    async def detect(self, text: str, language: str, entities: Sequence[str] | None):
        return DetectorUnavailable(detector=DetectorKind.NER, reason="Timeout")


def test_short_text_is_one_window() -> None:
    assert plan_windows("short", max_chars=100, overlap_chars=10) == (
        plan_windows("short", max_chars=100, overlap_chars=10)[0],
    )


def test_windows_cover_every_character() -> None:
    text = ("Die Kontaktperson heisst Regula Zbinden. " * 200).strip()
    windows = plan_windows(text, max_chars=500, overlap_chars=50)
    assert len(windows) > 1
    covered = {index for window in windows for index in range(window.start, window.end)}
    assert covered == set(range(len(text)))


def test_windows_respect_the_size_limit() -> None:
    text = "a" * 5000
    for window in plan_windows(text, max_chars=500, overlap_chars=50):
        assert window.end - window.start <= 500


def test_windows_always_progress_with_a_degenerate_overlap() -> None:
    """An overlap wider than the window must not loop forever."""
    text = "x" * 3000
    windows = plan_windows(text, max_chars=100, overlap_chars=500)
    assert windows[-1].end == len(text)
    assert all(later.start > earlier.start for earlier, later in zip(windows, windows[1:]))


def test_windows_prefer_a_paragraph_boundary() -> None:
    text = "erster absatz\n\n" + "b" * 400 + "\n\n" + "c" * 400
    windows = plan_windows(text, max_chars=450, overlap_chars=50)
    assert text[: windows[0].end].endswith("\n\n")


def test_shift_maps_spans_back_onto_the_original() -> None:
    from litellm.pii.detection.chunking import Window

    window = Window(start=100, end=200)
    shifted = shift_spans([span(5, 12)], window, length=1000)
    assert (shifted[0].start, shifted[0].end) == (105, 112)


def test_shift_drops_a_span_cut_by_an_interior_edge() -> None:
    from litellm.pii.detection.chunking import Window

    window = Window(start=100, end=200)
    assert shift_spans([span(90, 100)], window, length=1000) == ()


def test_shift_keeps_a_span_at_the_true_end_of_the_text() -> None:
    from litellm.pii.detection.chunking import Window

    window = Window(start=100, end=200)
    assert len(shift_spans([span(90, 100)], window, length=200)) == 1


@pytest.mark.asyncio
async def test_long_text_is_split_and_spans_index_the_original() -> None:
    filler = "Das System laeuft stabil und meldet nichts. "
    text = filler * 60 + "Regula Zbinden meldet sich."
    inner = RecordingDetector(needle="Regula Zbinden")
    detector = ChunkedDetector(inner=inner, max_chars=500, overlap_chars=100)

    spans = await detector.detect(text=text, language="de", entities=None)

    assert len(inner.calls) > 1, "expected the text to be split"
    assert spans, "the name must survive the split"
    assert {text[s.start : s.end] for s in spans} == {"Regula Zbinden"}


@pytest.mark.asyncio
async def test_an_entity_on_a_window_boundary_survives() -> None:
    """The overlap exists for exactly this case."""
    needle = "Regula Zbinden"
    for offset in range(480, 520):
        text = "a" * offset + needle + "b" * 600
        spans = await ChunkedDetector(inner=RecordingDetector(needle=needle), max_chars=500, overlap_chars=100).detect(
            text=text, language="de", entities=None
        )
        assert needle in {text[s.start : s.end] for s in spans}, f"lost the entity at offset {offset}"


@pytest.mark.asyncio
async def test_short_text_bypasses_windowing_entirely() -> None:
    inner = RecordingDetector(needle="x")
    await ChunkedDetector(inner=inner, max_chars=500, overlap_chars=100).detect(
        text="a short line", language="en", entities=None
    )
    assert inner.calls == ["a short line"]


@pytest.mark.asyncio
async def test_one_failed_window_fails_the_whole_detection() -> None:
    """A partial scan must not read like a clean one."""
    result = await ChunkedDetector(inner=FailingDetector(), max_chars=100, overlap_chars=10).detect(
        text="x" * 1000, language="de", entities=None
    )
    assert isinstance(result, DetectorUnavailable)


@pytest.mark.asyncio
async def test_windows_run_concurrently() -> None:
    class SlowDetector:
        async def detect(self, text: str, language: str, entities: Sequence[str] | None):
            await asyncio.sleep(0.05)
            return ()

    text = "y" * 5000
    detector = ChunkedDetector(inner=SlowDetector(), max_chars=500, overlap_chars=50)
    loop = asyncio.get_running_loop()
    started = loop.time()
    await detector.detect(text=text, language="de", entities=None)
    elapsed = loop.time() - started
    assert elapsed < 0.2, f"windows appear to run serially ({elapsed:.2f}s)"
