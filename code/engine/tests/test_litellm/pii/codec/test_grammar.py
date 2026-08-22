import pytest

from litellm.pii.codec.grammar import AngleBracketGrammar, TokenKind

GRAMMAR = AngleBracketGrammar()

DISTORTIONS = [
    ("undistorted", "<PERSON_1>"),
    ("lowercased", "<person_1>"),
    ("mixed case", "<PeRsOn_1>"),
    ("internal whitespace", "< PERSON_1 >"),
    ("markdown escaped brackets", r"\<PERSON_1\>"),
    ("markdown escaped underscore", r"\<PERSON\_1\>"),
    ("bold emphasis", "**<PERSON_1>**"),
    ("italic emphasis", "_<PERSON_1>_"),
    ("possessive suffix", "<PERSON_1>'s"),
    ("plural suffix", "<PERSON_1>s"),
    ("trailing punctuation", "<PERSON_1>."),
    ("inside a sentence", "I spoke to <PERSON_1> today"),
    ("inside JSON", '{"name": "<PERSON_1>"}'),
    ("space after the separator", "<PERSON_ 1>"),
]

NON_TOKENS = [
    ("masked form carries no ordinal", "<PERSON>"),
    ("separator with no ordinal", "<PERSON_>"),
    ("truncated by max_tokens", "the reply ended with <PERSON_"),
    ("truncated mid-label", "the reply ended with <PERS"),
    ("unclosed bracket", "<PERSON_1 and more"),
    ("label outside the vocabulary", "<LIKE_THIS_1>"),
    ("translated label", "<PERSONNE_1>"),
    ("lowercase non-label", "<foo_1>"),
    ("generic xml tag", "<div_1>"),
    ("prose with a comparison", "if a_1 < b_2 then"),
    ("empty handle", "<PERSON:>"),
    ("ordinal is not a number", "<PERSON_one>"),
]


class TestTolerantMatching:
    @pytest.mark.parametrize("distortion,text", DISTORTIONS, ids=[d for d, _ in DISTORTIONS])
    def test_every_distortion_still_resolves_to_the_minted_token(self, distortion, text):
        assert [f.canonical for f in GRAMMAR.find(text)] == ["<PERSON_1>"]

    @pytest.mark.parametrize("reason,text", NON_TOKENS, ids=[r for r, _ in NON_TOKENS])
    def test_non_tokens_are_not_matched(self, reason, text):
        assert GRAMMAR.find(text) == ()

    def test_the_matched_span_covers_the_distorted_text_not_the_canonical_form(self):
        found = GRAMMAR.find("say **<person_1>** now")[0]
        assert "say **<person_1>** now"[found.start : found.end] == "<person_1>"
        assert found.canonical == "<PERSON_1>"

    def test_several_tokens_in_one_text_are_all_found(self):
        found = GRAMMAR.find("<PERSON_1> mailed <EMAIL_ADDRESS_2> about <PERSON_3>")
        assert [f.canonical for f in found] == ["<PERSON_1>", "<EMAIL_ADDRESS_2>", "<PERSON_3>"]

    def test_a_multiword_label_is_matched_whole(self):
        assert [f.canonical for f in GRAMMAR.find("<US_BANK_NUMBER_2>")] == ["<US_BANK_NUMBER_2>"]

    def test_an_extended_piiranha_label_is_in_the_vocabulary(self):
        assert [f.canonical for f in GRAMMAR.find("<ID_CARD_NUMBER_1>")] == ["<ID_CARD_NUMBER_1>"]

    def test_multi_digit_ordinals_are_matched_whole(self):
        assert [f.canonical for f in GRAMMAR.find("<PERSON_142>")] == ["<PERSON_142>"]


class TestTruncationIsNeverGuessed:
    """A wrong guess emits the wrong person's name, which is worse than showing the fragment."""

    @pytest.mark.parametrize("truncated", ["<PERSON_", "<PERSON", "<PER", "<", "<PERSON_1", "<PERSON:3f9c"])
    def test_a_truncated_trailing_token_is_left_verbatim(self, truncated):
        text = f"the answer was {truncated}"
        assert GRAMMAR.find(text) == ()
        assert GRAMMAR.substitute(text, lambda found: "SHOULD NOT HAPPEN") == text

    def test_a_truncated_token_is_not_prefix_matched_to_a_longer_one(self):
        resolved = {"<PERSON_1>": "Ada", "<PERSON_12>": "Grace"}
        assert GRAMMAR.substitute("ends with <PERSON_1", lambda f: resolved[f.canonical]) == "ends with <PERSON_1"


class TestHandleTokens:
    def test_a_handle_token_is_matched(self):
        assert [f.canonical for f in GRAMMAR.find("<PERSON:3f9c2e1b8d4a7f60>")] == ["<PERSON:3f9c2e1b8d4a7f60>"]

    def test_handle_case_is_preserved_because_base64_is_case_sensitive(self):
        assert [f.canonical for f in GRAMMAR.find("<PERSON:AbC-_.123>")] == ["<PERSON:AbC-_.123>"]

    def test_only_the_label_is_case_normalised(self):
        assert [f.canonical for f in GRAMMAR.find("<person:AbC123>")] == ["<PERSON:AbC123>"]

    def test_an_encrypted_payload_survives_matching(self):
        token = "<PERSON:e1.YWJjZGVmZ2hpamtsbW5vcA>"
        assert [f.canonical for f in GRAMMAR.find(token)] == [token]


class TestMintAndParse:
    def test_ordinal_round_trip(self):
        parsed = GRAMMAR.parse(GRAMMAR.mint("PERSON", TokenKind.ORDINAL, "1"))
        assert (parsed.entity_type, parsed.kind, parsed.discriminator) == ("PERSON", TokenKind.ORDINAL, "1")

    def test_handle_round_trip(self):
        parsed = GRAMMAR.parse(GRAMMAR.mint("EMAIL_ADDRESS", TokenKind.HANDLE, "3f9c2e1b"))
        assert (parsed.entity_type, parsed.kind, parsed.discriminator) == (
            "EMAIL_ADDRESS",
            TokenKind.HANDLE,
            "3f9c2e1b",
        )

    def test_parse_is_strict_where_find_is_tolerant(self):
        assert GRAMMAR.parse("< person_1 >") is None
        assert GRAMMAR.find("< person_1 >")[0].canonical == "<PERSON_1>"

    def test_parse_rejects_a_token_with_surrounding_text(self):
        assert GRAMMAR.parse("hello <PERSON_1>") is None

    def test_a_masked_token_is_minted_but_never_matched(self):
        masked = GRAMMAR.mint_masked("PERSON")
        assert masked == "<PERSON>"
        assert GRAMMAR.find(masked) == ()
        assert GRAMMAR.parse(masked) is None


class TestSubstitute:
    def test_a_substituted_value_is_never_rescanned(self):
        resolved = {"<PERSON_1>": "<PERSON_2>", "<PERSON_2>": "Grace"}
        assert GRAMMAR.substitute("<PERSON_1>", lambda f: resolved[f.canonical]) == "<PERSON_2>"

    def test_the_distorted_form_is_what_gets_replaced(self):
        assert GRAMMAR.substitute("say **< person_1 >** now", lambda f: "Ada") == "say **Ada** now"

    def test_text_between_tokens_is_preserved(self):
        assert (
            GRAMMAR.substitute("a <PERSON_1> b <PERSON_2> c", lambda f: f.canonical[1:-1]) == "a PERSON_1 b PERSON_2 c"
        )


class TestCanonicalTokens:
    def test_it_collects_the_minted_form_of_every_distortion(self):
        assert GRAMMAR.canonical_tokens(("< person_1 >", r"\<PERSON_2\>")) == {"<PERSON_1>", "<PERSON_2>"}

    def test_repeated_occurrences_collapse(self):
        assert GRAMMAR.canonical_tokens(("<PERSON_1> and <person_1>",)) == {"<PERSON_1>"}

    def test_text_without_tokens_yields_nothing(self):
        assert GRAMMAR.canonical_tokens(("just prose", "<PERSON>")) == frozenset()
