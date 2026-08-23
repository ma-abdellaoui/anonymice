"""Tests for the PII activity log: what it records, and what it refuses to."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath("../../.."))

from litellm.pii.activity import (
    DEFAULT_CAPACITY,
    ENV_CAPTURE_TEXT,
    Applied,
    Blocked,
    Failed,
    PiiActivityLog,
    PiiDirection,
    PiiSurface,
    action_counts_of,
    capture_enabled,
    capture_of,
    decode_tally,
    entity_counts_of,
    new_event,
    placements_of,
)
from litellm.pii.codec.action_aware import SpanAction
from litellm.pii.codec.grammar import AngleBracketGrammar
from litellm.pii.codec.placeholder import PlaceholderCodec
from litellm.pii.codec.transform import encode_batch
from litellm.pii.types import DetectorKind, PiiSpan

GRAMMAR = AngleBracketGrammar()


def span(entity_type, start, end, detector=DetectorKind.RULES, score=0.9):
    return PiiSpan(entity_type=entity_type, start=start, end=end, score=score, detector=detector)


def always_encode(entity_type: str) -> SpanAction:
    return SpanAction.ENCODE


def an_event(**overrides):
    base = dict(
        surface=PiiSurface.GUARDRAIL,
        direction=PiiDirection.ENCODE,
        outcome=Applied(),
        duration_ms=1.0,
    )
    return new_event(**{**base, **overrides})


class TestCounting:
    def test_entity_counts_aggregate_across_texts(self):
        counts = entity_counts_of(((span("PERSON", 0, 3),), (span("PERSON", 0, 3), span("IBAN_CODE", 4, 8))))
        assert dict(counts) == {"PERSON": 2, "IBAN_CODE": 1}

    def test_action_counts_use_the_configured_action(self):
        actions = {"US_SSN": SpanAction.MASK}
        counts = action_counts_of(
            ((span("PERSON", 0, 3), span("US_SSN", 4, 8)),),
            lambda entity_type: actions.get(entity_type, SpanAction.ENCODE),
        )
        assert dict(counts) == {"ENCODE": 1, "MASK": 1}

    def test_empty_detection_counts_nothing(self):
        assert dict(entity_counts_of(((),))) == {}


class TestDecodeTally:
    def test_counts_only_tokens_that_actually_resolved(self):
        before = ("hi <PERSON_1> and <PERSON_2>",)
        after = ("hi Ada and <PERSON_2>",)
        tally = decode_tally(GRAMMAR, before, after)
        assert (tally.token_count, tally.resolved_count) == (2, 1)

    def test_reports_the_entity_types_it_was_asked_for(self):
        tally = decode_tally(GRAMMAR, ("<PERSON_1> <IBAN_CODE_1>",), ("Ada CH93",))
        assert dict(tally.entity_counts) == {"PERSON": 1, "IBAN_CODE": 1}

    def test_text_without_tokens_tallies_to_nothing(self):
        tally = decode_tally(GRAMMAR, ("plain prose",), ("plain prose",))
        assert (tally.token_count, tally.resolved_count) == (0, 0)


class TestCaptureGating:
    def test_capture_is_off_unless_switched_on(self, monkeypatch):
        monkeypatch.delenv(ENV_CAPTURE_TEXT, raising=False)
        assert capture_enabled() is False
        assert capture_of(("Ada",), ("<PERSON_1>",), (), always_encode) is None

    @pytest.mark.parametrize("raw", ["true", "True", " TRUE "])
    def test_capture_switches_on_only_for_the_word_true(self, monkeypatch, raw):
        monkeypatch.setenv(ENV_CAPTURE_TEXT, raw)
        assert capture_enabled() is True

    @pytest.mark.parametrize("raw", ["false", "0", "1", "", "yes"])
    def test_anything_but_true_leaves_capture_off(self, monkeypatch, raw):
        """Unrecognised means off. A capture that switched itself on by accident is the whole risk."""
        monkeypatch.setenv(ENV_CAPTURE_TEXT, raw)
        assert capture_enabled() is False

    def test_a_capture_pairs_every_value_with_the_token_that_replaced_it(self, monkeypatch):
        monkeypatch.setenv(ENV_CAPTURE_TEXT, "true")
        texts = ("email Ada about it",)
        draft = encode_batch(texts, ((span("PERSON", 6, 9),),), PlaceholderCodec())
        capture = capture_of(texts, draft.texts, draft.placements, always_encode)
        assert capture is not None
        assert capture.before == texts
        assert capture.after == ("email <PERSON_1> about it",)
        assert [(p.token, p.value) for p in capture.placements] == [("<PERSON_1>", "Ada")]

    def test_a_repeated_value_keeps_one_token_across_both_placements(self, monkeypatch):
        monkeypatch.setenv(ENV_CAPTURE_TEXT, "true")
        texts = ("Ada wrote to Ada",)
        draft = encode_batch(texts, ((span("PERSON", 0, 3), span("PERSON", 13, 16)),), PlaceholderCodec())
        placements = placements_of(texts, draft.placements, always_encode)
        assert {p.token for p in placements} == {"<PERSON_1>"}
        assert len(placements) == 2

    def test_placements_carry_the_stage_that_found_the_span(self, monkeypatch):
        monkeypatch.setenv(ENV_CAPTURE_TEXT, "true")
        texts = ("Ada",)
        draft = encode_batch(texts, ((span("PERSON", 0, 3, detector=DetectorKind.NER),),), PlaceholderCodec())
        placements = placements_of(texts, draft.placements, always_encode)
        assert placements[0].detector is DetectorKind.NER


class TestActivityLog:
    def test_reads_back_newest_first(self):
        log = PiiActivityLog(capacity=10)
        first, second = an_event(), an_event()
        log.record(first)
        log.record(second)
        assert [event.id for event in log.recent(limit=10)] == [second.id, first.id]

    def test_drops_the_oldest_once_full(self):
        log = PiiActivityLog(capacity=2)
        kept = [an_event() for _ in range(3)]
        for event in kept:
            log.record(event)
        assert [event.id for event in log.recent(limit=10)] == [kept[2].id, kept[1].id]

    def test_filters_by_surface(self):
        log = PiiActivityLog(capacity=10)
        log.record(an_event(surface=PiiSurface.GUARDRAIL))
        extension = an_event(surface=PiiSurface.EXTENSION)
        log.record(extension)
        assert [event.id for event in log.recent(limit=10, surface=PiiSurface.EXTENSION)] == [extension.id]

    def test_filters_by_direction(self):
        log = PiiActivityLog(capacity=10)
        decode = an_event(direction=PiiDirection.DECODE)
        log.record(an_event(direction=PiiDirection.ENCODE))
        log.record(decode)
        assert [event.id for event in log.recent(limit=10, direction=PiiDirection.DECODE)] == [decode.id]

    def test_filters_by_request_id(self):
        log = PiiActivityLog(capacity=10)
        wanted = an_event(request_id="call-1")
        log.record(wanted)
        log.record(an_event(request_id="call-2"))
        log.record(an_event())
        assert [event.id for event in log.recent(limit=10, request_id="call-1")] == [wanted.id]

    def test_request_id_filter_combines_with_direction(self):
        log = PiiActivityLog(capacity=10)
        decode = an_event(request_id="call-1", direction=PiiDirection.DECODE)
        log.record(an_event(request_id="call-1", direction=PiiDirection.ENCODE))
        log.record(decode)
        log.record(an_event(request_id="call-2", direction=PiiDirection.DECODE))
        found = log.recent(limit=10, direction=PiiDirection.DECODE, request_id="call-1")
        assert [event.id for event in found] == [decode.id]

    def test_limit_bounds_what_comes_back(self):
        log = PiiActivityLog(capacity=10)
        for _ in range(5):
            log.record(an_event())
        assert len(log.recent(limit=2)) == 2

    def test_outcomes_survive_the_round_trip(self):
        log = PiiActivityLog(capacity=10)
        log.record(an_event(outcome=Blocked(entity_type="CREDIT_CARD")))
        log.record(an_event(outcome=Failed(reason="detector down")))
        outcomes = [event.outcome for event in log.recent(limit=10)]
        assert outcomes == [Failed(reason="detector down"), Blocked(entity_type="CREDIT_CARD")]


class TestSubscribers:
    @pytest.mark.asyncio
    async def test_a_subscriber_receives_what_is_recorded_while_it_watches(self):
        log = PiiActivityLog(capacity=10)
        async with log.subscribe() as queue:
            event = an_event()
            log.record(event)
            assert (await asyncio.wait_for(queue.get(), timeout=1)).id == event.id

    @pytest.mark.asyncio
    async def test_leaving_the_context_stops_delivery(self):
        log = PiiActivityLog(capacity=10)
        async with log.subscribe() as queue:
            pass
        log.record(an_event())
        assert queue.empty()

    @pytest.mark.asyncio
    async def test_a_stalled_subscriber_never_blocks_recording(self):
        """Back pressure from a watcher must not reach the request being logged."""
        log = PiiActivityLog(capacity=1000)
        async with log.subscribe() as queue:
            for _ in range(500):
                log.record(an_event())
            assert queue.full()
        assert len(log.recent(limit=1000)) == 500


class TestDefaults:
    def test_the_default_capacity_is_bounded(self):
        assert 0 < DEFAULT_CAPACITY < 100_000
