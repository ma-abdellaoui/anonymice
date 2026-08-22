import pytest

from litellm.pii.detection.spans import coalesce_adjacent, merge_spans, resolve_overlaps, trim_span, trim_spans
from litellm.pii.types import DetectorKind, PiiSpan


def span(entity_type, start, end, score=0.9, detector=DetectorKind.RULES):
    return PiiSpan(entity_type=entity_type, start=start, end=end, score=score, detector=detector)


class TestResolveOverlaps:
    def test_disjoint_spans_all_survive(self):
        first = span("EMAIL_ADDRESS", 0, 5)
        second = span("PHONE_NUMBER", 10, 20)
        assert resolve_overlaps([second, first]) == (first, second)

    def test_higher_score_wins_overlap(self):
        weak = span("PERSON", 0, 10, score=0.4)
        strong = span("EMAIL_ADDRESS", 5, 15, score=0.95)
        assert resolve_overlaps([weak, strong]) == (strong,)

    def test_rules_beat_ner_on_equal_score(self):
        ner = span("LOCATION", 0, 10, score=0.8, detector=DetectorKind.NER)
        rules = span("US_SSN", 0, 10, score=0.8, detector=DetectorKind.RULES)
        assert resolve_overlaps([ner, rules]) == (rules,)

    def test_longer_span_wins_when_score_and_detector_tie(self):
        short = span("PERSON", 0, 4, score=0.8)
        long = span("PERSON", 0, 12, score=0.8)
        assert resolve_overlaps([short, long]) == (long,)

    def test_nested_span_is_dropped(self):
        outer = span("CREDIT_CARD", 0, 19, score=0.9)
        inner = span("PHONE_NUMBER", 4, 12, score=0.5)
        assert resolve_overlaps([inner, outer]) == (outer,)

    def test_touching_spans_do_not_overlap(self):
        left = span("PERSON", 0, 5)
        right = span("PERSON", 5, 10)
        assert resolve_overlaps([left, right]) == (left, right)

    def test_result_is_sorted_by_start(self):
        late = span("EMAIL_ADDRESS", 50, 60)
        early = span("US_SSN", 1, 5)
        middle = span("PHONE_NUMBER", 20, 25)
        assert resolve_overlaps([late, early, middle]) == (early, middle, late)

    def test_output_is_deterministic_regardless_of_input_order(self):
        candidates = [
            span("PERSON", 0, 10, score=0.7, detector=DetectorKind.NER),
            span("EMAIL_ADDRESS", 3, 9, score=0.7, detector=DetectorKind.RULES),
            span("LOCATION", 8, 14, score=0.7, detector=DetectorKind.NER),
        ]
        assert resolve_overlaps(candidates) == resolve_overlaps(list(reversed(candidates)))


class TestCoalesceAdjacent:
    def test_joins_same_entity_separated_by_single_space(self):
        text = "Ada Lovelace wrote it"
        given = span("PERSON", 0, 3, score=0.9, detector=DetectorKind.NER)
        surname = span("PERSON", 4, 12, score=0.8, detector=DetectorKind.NER)
        assert coalesce_adjacent([given, surname], text) == (PiiSpan("PERSON", 0, 12, 0.8, DetectorKind.NER),)

    def test_does_not_join_different_entities(self):
        text = "Ada 555-1234"
        person = span("PERSON", 0, 3)
        phone = span("PHONE_NUMBER", 4, 12)
        assert coalesce_adjacent([person, phone], text) == (person, phone)

    def test_does_not_join_across_wide_gap(self):
        text = "Ada   Lovelace"
        first = span("PERSON", 0, 3)
        second = span("PERSON", 6, 14)
        assert coalesce_adjacent([first, second], text) == (first, second)

    def test_does_not_join_across_non_whitespace(self):
        text = "Ada,Lovelace"
        first = span("PERSON", 0, 3)
        second = span("PERSON", 4, 12)
        assert coalesce_adjacent([first, second], text) == (first, second)

    def test_joins_directly_touching_spans(self):
        text = "AdaLovelace"
        first = span("PERSON", 0, 3)
        second = span("PERSON", 3, 11)
        assert coalesce_adjacent([first, second], text) == (PiiSpan("PERSON", 0, 11, 0.9, DetectorKind.RULES),)

    def test_joined_span_keeps_lowest_score(self):
        text = "Ada Lovelace"
        assert coalesce_adjacent([span("PERSON", 0, 3, score=0.95), span("PERSON", 4, 12, score=0.42)], text)[
            0
        ].score == pytest.approx(0.42)

    def test_chains_three_fragments_into_one(self):
        text = "Ada King Lovelace"
        fragments = [span("PERSON", 0, 3), span("PERSON", 4, 8), span("PERSON", 9, 17)]
        assert coalesce_adjacent(fragments, text) == (PiiSpan("PERSON", 0, 17, 0.9, DetectorKind.RULES),)


class TestMergeSpans:
    def test_rule_span_suppresses_overlapping_ner_span_then_coalesces(self):
        text = "Ada Lovelace ada@example.com"
        rules = [span("EMAIL_ADDRESS", 13, 28, score=0.99)]
        ner = [
            span("PERSON", 0, 3, score=0.9, detector=DetectorKind.NER),
            span("PERSON", 4, 12, score=0.9, detector=DetectorKind.NER),
            span("LOCATION", 13, 20, score=0.5, detector=DetectorKind.NER),
        ]
        assert merge_spans(text, rules, ner) == (
            PiiSpan("PERSON", 0, 12, 0.9, DetectorKind.NER),
            PiiSpan("EMAIL_ADDRESS", 13, 28, 0.99, DetectorKind.RULES),
        )

    def test_multibyte_text_offsets_are_preserved(self):
        text = "café Ada Lovelace 🎉"
        spans = merge_spans(text, [span("PERSON", 5, 8, detector=DetectorKind.NER)])
        assert spans[0].text_from(text) == "Ada"

    def test_empty_input_yields_empty_output(self):
        assert merge_spans("anything") == ()


class TestTrimSpan:
    """Piiranha reports the whitespace preceding a word as part of the entity.

    The offsets here are the ones the real model returned for these exact inputs.
    """

    def test_a_leading_space_is_dropped(self):
        text = "Ada Lovelace lives in Paris"
        trimmed = trim_span(span("LOCATION", 21, 27, detector=DetectorKind.NER), text)
        assert (trimmed.start, trimmed.end) == (22, 27)
        assert trimmed.text_from(text) == "Paris"

    def test_a_trailing_space_is_dropped(self):
        text = "Paris is nice"
        trimmed = trim_span(span("LOCATION", 0, 6, detector=DetectorKind.NER), text)
        assert trimmed.text_from(text) == "Paris"

    def test_an_already_tight_span_is_returned_unchanged(self):
        text = "Ada Lovelace"
        original = span("PERSON", 0, 3)
        assert trim_span(original, text) is original

    def test_a_whitespace_only_span_is_dropped_entirely(self):
        assert trim_span(span("PERSON", 3, 4), "Ada Lovelace") is None

    def test_score_and_detector_survive_the_trim(self):
        text = "Ada Lovelace lives in Paris"
        trimmed = trim_span(span("LOCATION", 21, 27, score=0.982, detector=DetectorKind.NER), text)
        assert (trimmed.score, trimmed.detector, trimmed.entity_type) == (0.982, DetectorKind.NER, "LOCATION")

    def test_trim_spans_drops_the_empty_ones_and_keeps_the_rest(self):
        text = "Ada Lovelace"
        assert trim_spans([span("PERSON", 0, 3), span("PERSON", 3, 4)], text) == (span("PERSON", 0, 3),)

    def test_multibyte_offsets_survive_trimming(self):
        text = "café 🎉 Ada"
        trimmed = trim_span(span("PERSON", 6, 10, detector=DetectorKind.NER), text)
        assert trimmed.text_from(text) == "Ada"


class TestMergeTrimsPaddedSpans:
    def test_the_separating_space_is_not_swallowed_by_the_token(self):
        text = "Ada Lovelace lives in Paris"
        merged = merge_spans(text, [span("LOCATION", 21, 27, detector=DetectorKind.NER)])
        assert merged[0].text_from(text) == "Paris"
        assert text[: merged[0].start].endswith(" ")

    def test_padded_name_fragments_still_coalesce_into_one_span(self):
        text = "My name is Ada Lovelace and more"
        fragments = [
            span("PERSON", 10, 14, detector=DetectorKind.NER),
            span("PERSON", 14, 23, detector=DetectorKind.NER),
        ]
        merged = merge_spans(text, fragments)
        assert len(merged) == 1
        assert merged[0].text_from(text) == "Ada Lovelace"
