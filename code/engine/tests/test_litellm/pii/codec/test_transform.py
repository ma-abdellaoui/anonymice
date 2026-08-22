import pytest

from litellm.pii.codec.base import find_tokens
from litellm.pii.codec.encrypted import EncryptedCodec
from litellm.pii.codec.handle import HandleCodec
from litellm.pii.codec.placeholder import PlaceholderCodec
from litellm.pii.codec.transform import decode_text, encode_text
from litellm.pii.store.cipher import AesGcmCipher, NullCipher
from litellm.pii.types import DecodeFailed, KeyUnavailable, PiiSpan
from litellm.pii.types import DetectorKind


def span(entity_type, start, end, detector=DetectorKind.RULES):
    return PiiSpan(entity_type=entity_type, start=start, end=end, score=0.9, detector=detector)


ALL_CODECS = [
    PlaceholderCodec(),
    HandleCodec(),
    EncryptedCodec(cipher=AesGcmCipher.from_secret("unit-test-secret")),
]


class TestEncodeText:
    def test_replaces_span_with_token(self):
        draft = encode_text("email ada@example.com now", [span("EMAIL_ADDRESS", 6, 21)], PlaceholderCodec())
        assert draft.text == "email <EMAIL_ADDRESS_1> now"

    def test_no_spans_leaves_text_untouched(self):
        draft = encode_text("nothing here", [], PlaceholderCodec())
        assert draft.text == "nothing here"
        assert draft.tokens == ()

    def test_ordinals_are_per_entity_type_and_left_to_right(self):
        text = "Ada and Grace mailed a@b.co"
        spans = [span("PERSON", 0, 3), span("PERSON", 8, 13), span("EMAIL_ADDRESS", 21, 27)]
        draft = encode_text(text, spans, PlaceholderCodec())
        assert draft.text == "<PERSON_1> and <PERSON_2> mailed <EMAIL_ADDRESS_1>"

    def test_repeated_value_reuses_one_token(self):
        text = "Ada wrote it and Ada signed it"
        draft = encode_text(text, [span("PERSON", 0, 3), span("PERSON", 17, 20)], PlaceholderCodec())
        assert draft.text == "<PERSON_1> wrote it and <PERSON_1> signed it"
        assert len(draft.mapping) == 1

    def test_same_value_under_different_entity_types_gets_distinct_tokens(self):
        text = "root root"
        draft = encode_text(text, [span("USERNAME", 0, 4), span("PASSWORD", 5, 9)], PlaceholderCodec())
        assert draft.text == "<USERNAME_1> <PASSWORD_1>"

    def test_unsorted_spans_are_handled(self):
        text = "Ada and Grace"
        draft = encode_text(text, [span("PERSON", 8, 13), span("PERSON", 0, 3)], PlaceholderCodec())
        assert draft.text == "<PERSON_1> and <PERSON_2>"

    def test_adjacent_spans_do_not_corrupt_offsets(self):
        text = "AdaGrace"
        draft = encode_text(text, [span("PERSON", 0, 3), span("PERSON", 3, 8)], PlaceholderCodec())
        assert draft.text == "<PERSON_1><PERSON_2>"

    def test_span_at_end_of_text(self):
        draft = encode_text("call 5551234", [span("PHONE_NUMBER", 5, 12)], PlaceholderCodec())
        assert draft.text == "call <PHONE_NUMBER_1>"

    def test_multibyte_text_offsets_are_respected(self):
        text = "héllo Ada 🎉 done"
        draft = encode_text(text, [span("PERSON", 6, 9)], PlaceholderCodec())
        assert draft.text == "héllo <PERSON_1> 🎉 done"

    def test_mapping_holds_original_values(self):
        text = "email ada@example.com now"
        draft = encode_text(text, [span("EMAIL_ADDRESS", 6, 21)], PlaceholderCodec())
        assert list(draft.mapping.values()) == ["ada@example.com"]

    def test_issued_tokens_carry_entity_and_codec(self):
        draft = encode_text("Ada", [span("PERSON", 0, 3)], PlaceholderCodec())
        assert draft.tokens[0].entity_type == "PERSON"
        assert draft.tokens[0].codec_id == "placeholder"

    def test_codec_failure_propagates_instead_of_emitting_partial_text(self):
        class FailingCipher:
            def seal(self, plaintext):
                return KeyUnavailable(reason="no key configured")

            def unseal(self, sealed):
                return DecodeFailed(reason="no key")

        result = encode_text("Ada", [span("PERSON", 0, 3)], EncryptedCodec(cipher=FailingCipher()))
        assert isinstance(result, KeyUnavailable)


class TestRoundTrip:
    @pytest.mark.parametrize("codec", ALL_CODECS, ids=lambda c: c.codec_id)
    def test_store_backed_round_trip_restores_original(self, codec):
        text = "Ada Lovelace emailed ada@example.com from 10.0.0.1"
        spans = [span("PERSON", 0, 12), span("EMAIL_ADDRESS", 21, 36), span("IP_ADDRESS", 42, 50)]
        draft = encode_text(text, spans, codec)
        assert draft.text != text
        assert decode_text(draft.text, draft.mapping) == text

    @pytest.mark.parametrize("codec", ALL_CODECS, ids=lambda c: c.codec_id)
    def test_every_minted_token_is_matched_by_the_token_pattern(self, codec):
        text = "Ada Lovelace emailed ada@example.com"
        draft = encode_text(text, [span("PERSON", 0, 12), span("EMAIL_ADDRESS", 21, 36)], codec)
        found = {t.token for t in find_tokens(draft.text)}
        assert {t.token for t in draft.tokens} == found

    @pytest.mark.parametrize("codec", ALL_CODECS, ids=lambda c: c.codec_id)
    def test_multibyte_round_trip(self, codec):
        text = "café ☕ Ada Lovelace 🎉"
        draft = encode_text(text, [span("PERSON", 7, 19)], codec)
        assert decode_text(draft.text, draft.mapping) == text

    def test_encoded_text_contains_no_original_pii(self):
        text = "Ada Lovelace emailed ada@example.com"
        draft = encode_text(text, [span("PERSON", 0, 12), span("EMAIL_ADDRESS", 21, 36)], HandleCodec())
        assert "Ada Lovelace" not in draft.text
        assert "ada@example.com" not in draft.text


class TestDecodeText:
    def test_unknown_token_is_left_verbatim(self):
        assert decode_text("hello <PERSON_9> bye", {"<PERSON_1>": "Ada"}) == "hello <PERSON_9> bye"

    def test_empty_mapping_is_a_no_op(self):
        assert decode_text("hello <PERSON_1>", {}) == "hello <PERSON_1>"

    def test_repeated_token_occurrences_are_all_replaced(self):
        assert decode_text("<PERSON_1> and <PERSON_1>", {"<PERSON_1>": "Ada"}) == "Ada and Ada"


class TestTokenRandomness:
    def test_handle_codec_never_repeats_a_token_for_the_same_value(self):
        minted = {HandleCodec().mint("PERSON", 1, "Ada") for _ in range(200)}
        assert len(minted) == 200

    def test_encrypted_codec_never_repeats_ciphertext_for_the_same_value(self):
        codec = EncryptedCodec(cipher=AesGcmCipher.from_secret("secret"))
        minted = {codec.mint("PERSON", 1, "Ada") for _ in range(50)}
        assert len(minted) == 50

    def test_placeholder_ordinal_does_not_encode_the_value(self):
        assert PlaceholderCodec().mint("PERSON", 1, "Ada") == PlaceholderCodec().mint("PERSON", 1, "Grace")


class TestCodecRecover:
    def test_store_backed_codecs_defer_to_the_store(self):
        assert PlaceholderCodec().recover("<PERSON_1>") is None
        assert HandleCodec().recover("<PERSON:abc123>") is None

    def test_encrypted_codec_recovers_without_a_store(self):
        codec = EncryptedCodec(cipher=AesGcmCipher.from_secret("secret"))
        token = codec.mint("PERSON", 1, "Ada Lovelace")
        assert codec.recover(token) == "Ada Lovelace"

    def test_encrypted_codec_rejects_a_foreign_key(self):
        token = EncryptedCodec(cipher=AesGcmCipher.from_secret("key-a")).mint("PERSON", 1, "Ada")
        assert isinstance(EncryptedCodec(cipher=AesGcmCipher.from_secret("key-b")).recover(token), DecodeFailed)

    def test_encrypted_codec_rejects_a_tampered_token(self):
        codec = EncryptedCodec(cipher=AesGcmCipher.from_secret("secret"))
        token = codec.mint("PERSON", 1, "Ada Lovelace")
        tampered = token[:-5] + ("A" if token[-5] != "A" else "B") + token[-4:]
        assert not isinstance(codec.recover(tampered), str)

    def test_encrypted_codec_ignores_a_non_encrypted_token(self):
        codec = EncryptedCodec(cipher=NullCipher())
        assert codec.recover("<PERSON_1>") is None
