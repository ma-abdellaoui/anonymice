import pytest

from litellm.pii.codec.encrypted import EncryptedCodec
from litellm.pii.codec.handle import HandleCodec
from litellm.pii.codec.placeholder import PlaceholderCodec
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import EncodedBatch, PiiService
from litellm.pii.store.base import TokenScope
from litellm.pii.store.cipher import AesGcmCipher, NullCipher
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.store.request_scoped import RequestScopedStore
from litellm.pii.types import (
    DetectionResult,
    DetectorKind,
    DetectorUnavailable,
    KeyUnavailable,
    PiiSpan,
    StoreUnavailable,
)

SCOPE = TokenScope(namespace="ns", session_id="sess")


class FakeCache:
    def __init__(self):
        self.entries = {}
        self.fail = False

    async def async_set_cache(self, key, value, **kwargs):
        if self.fail:
            raise RuntimeError("down")
        self.entries[key] = value

    async def async_get_cache(self, key, **kwargs):
        if self.fail:
            raise RuntimeError("down")
        return self.entries.get(key)


class SpanDetector:
    """Returns spans located by substring, so tests state intent not offsets."""

    def __init__(self, *needles, entity_type="PERSON", detector=DetectorKind.RULES, error=None):
        self.needles = needles
        self.entity_type = entity_type
        self.detector = detector
        self.error = error

    async def detect(self, text, language, entities):
        if self.error is not None:
            return self.error
        return tuple(
            PiiSpan(
                entity_type=self.entity_type,
                start=text.index(n),
                end=text.index(n) + len(n),
                score=0.95,
                detector=self.detector,
            )
            for n in self.needles
            if n in text
        )


def service(detector_stage, codec=None, store=None):
    return PiiService(
        detector=CascadingDetector(rules=detector_stage, ner=None, policy=NerStagePolicy.NEVER),
        codec=codec or PlaceholderCodec(),
        store=store or RequestScopedStore(),
    )


class TestDetect:
    @pytest.mark.asyncio
    async def test_returns_detected_spans(self):
        result = await service(SpanDetector("Ada")).detect("hello Ada")
        assert isinstance(result, DetectionResult)
        assert result.spans[0].text_from("hello Ada") == "Ada"

    @pytest.mark.asyncio
    async def test_detector_outage_is_surfaced(self):
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503")
        assert await service(SpanDetector(error=error)).detect("hello Ada") == error

    @pytest.mark.asyncio
    async def test_detect_many_surfaces_a_single_failure(self):
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="boom")
        assert await service(SpanDetector(error=error)).detect_many(["a", "b"]) == error


class TestEncode:
    @pytest.mark.asyncio
    async def test_replaces_detected_value(self):
        result = await service(SpanDetector("Ada")).encode(["hello Ada"], SCOPE)
        assert result.texts == ("hello <PERSON_1>",)

    @pytest.mark.asyncio
    async def test_returns_the_scope_session_id(self):
        result = await service(SpanDetector("Ada")).encode(["hello Ada"], SCOPE)
        assert result.session_id == "sess"

    @pytest.mark.asyncio
    async def test_clean_text_is_returned_unchanged_with_no_tokens(self):
        result = await service(SpanDetector("Ada")).encode(["nothing here"], SCOPE)
        assert result.texts == ("nothing here",)
        assert result.tokens == ()

    @pytest.mark.asyncio
    async def test_one_token_space_is_shared_across_texts(self):
        result = await service(SpanDetector("Ada")).encode(["Ada wrote", "then Ada signed"], SCOPE)
        assert result.texts == ("<PERSON_1> wrote", "then <PERSON_1> signed")

    @pytest.mark.asyncio
    async def test_distinct_values_across_texts_get_distinct_tokens(self):
        result = await service(SpanDetector("Ada", "Grace")).encode(["Ada and Grace", "Grace again"], SCOPE)
        assert result.texts == ("<PERSON_1> and <PERSON_2>", "<PERSON_2> again")

    @pytest.mark.asyncio
    async def test_mapping_is_persisted_to_the_store(self):
        store = RequestScopedStore()
        await service(SpanDetector("Ada"), store=store).encode(["hello Ada"], SCOPE)
        assert await store.get(SCOPE, "<PERSON_1>") == "Ada"

    @pytest.mark.asyncio
    async def test_detector_outage_aborts_encoding(self):
        error = DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503")
        assert await service(SpanDetector(error=error)).encode(["hello Ada"], SCOPE) == error

    @pytest.mark.asyncio
    async def test_store_outage_aborts_encoding_rather_than_issuing_unresolvable_tokens(self):
        cache = FakeCache()
        cache.fail = True
        result = await service(SpanDetector("Ada"), store=DualCacheStore(cache=cache)).encode(["hello Ada"], SCOPE)
        assert isinstance(result, StoreUnavailable)

    @pytest.mark.asyncio
    async def test_codec_failure_aborts_encoding(self):
        class FailingCipher:
            def seal(self, plaintext):
                return KeyUnavailable(reason="no key")

            def unseal(self, sealed):
                return sealed

        result = await service(SpanDetector("Ada"), codec=EncryptedCodec(cipher=FailingCipher())).encode(
            ["hello Ada"], SCOPE
        )
        assert isinstance(result, KeyUnavailable)

    @pytest.mark.asyncio
    async def test_encode_one_returns_a_single_text(self):
        result = await service(SpanDetector("Ada")).encode_one("hello Ada", SCOPE)
        assert result.text == "hello <PERSON_1>"


class TestDecode:
    @pytest.mark.asyncio
    async def test_round_trip_restores_the_original(self):
        svc = service(SpanDetector("Ada"))
        encoded = await svc.encode(["hello Ada"], SCOPE)
        assert await svc.decode(encoded.texts, SCOPE) == ("hello Ada",)

    @pytest.mark.asyncio
    async def test_round_trip_across_separate_requests_via_shared_cache(self):
        cache = FakeCache()
        store = DualCacheStore(cache=cache, cipher=AesGcmCipher.from_secret("secret"))
        encoded = await service(SpanDetector("Ada"), store=store).encode(["hello Ada"], SCOPE)

        fresh = service(
            SpanDetector("Ada"), store=DualCacheStore(cache=cache, cipher=AesGcmCipher.from_secret("secret"))
        )
        assert await fresh.decode(encoded.texts, SCOPE) == ("hello Ada",)

    @pytest.mark.asyncio
    async def test_another_key_cannot_decode_the_token(self):
        cache = FakeCache()
        store = DualCacheStore(cache=cache)
        svc = service(SpanDetector("Ada"), store=store)
        encoded = await svc.encode(["hello Ada"], TokenScope("key-a", "sess"))
        assert await svc.decode(encoded.texts, TokenScope("key-b", "sess")) == encoded.texts

    @pytest.mark.asyncio
    async def test_unknown_token_is_left_verbatim(self):
        assert await service(SpanDetector()).decode(["hi <PERSON_7>"], SCOPE) == ("hi <PERSON_7>",)

    @pytest.mark.asyncio
    async def test_text_without_tokens_is_untouched(self):
        assert await service(SpanDetector()).decode(["plain text"], SCOPE) == ("plain text",)

    @pytest.mark.asyncio
    async def test_store_outage_surfaces_rather_than_returning_tokenized_text(self):
        cache = FakeCache()
        cache.entries["pii:ns:sess:<PERSON_1>"] = "Ada"
        store = DualCacheStore(cache=cache)
        svc = service(SpanDetector(), store=store)
        cache.fail = True
        assert isinstance(await svc.decode(["hi <PERSON_1>"], SCOPE), StoreUnavailable)

    @pytest.mark.asyncio
    async def test_encrypted_codec_decodes_with_an_empty_store(self):
        codec = EncryptedCodec(cipher=AesGcmCipher.from_secret("secret"))
        encoded = await service(SpanDetector("Ada"), codec=codec).encode(["hello Ada"], SCOPE)
        stateless = service(SpanDetector(), codec=codec, store=RequestScopedStore())
        assert await stateless.decode(encoded.texts, SCOPE) == ("hello Ada",)

    @pytest.mark.asyncio
    async def test_handle_codec_requires_the_store(self):
        cache = FakeCache()
        svc = service(SpanDetector("Ada"), codec=HandleCodec(), store=DualCacheStore(cache=cache))
        encoded = await svc.encode(["hello Ada"], SCOPE)
        detached = service(SpanDetector(), codec=HandleCodec(), store=DualCacheStore(cache=FakeCache()))
        assert await detached.decode(encoded.texts, SCOPE) == encoded.texts

    @pytest.mark.asyncio
    async def test_decode_handles_multiple_texts_and_repeated_tokens(self):
        svc = service(SpanDetector("Ada", "Grace"))
        encoded = await svc.encode(["Ada and Grace", "Grace wrote to Ada"], SCOPE)
        assert await svc.decode(encoded.texts, SCOPE) == ("Ada and Grace", "Grace wrote to Ada")

    @pytest.mark.asyncio
    async def test_decode_one_returns_a_single_text(self):
        svc = service(SpanDetector("Ada"))
        encoded = await svc.encode_one("hello Ada", SCOPE)
        assert await svc.decode_one(encoded.text, SCOPE) == "hello Ada"


class TestEndToEndShape:
    @pytest.mark.asyncio
    async def test_encoded_text_never_contains_the_original_value(self):
        for codec in (PlaceholderCodec(), HandleCodec(), EncryptedCodec(cipher=NullCipher())):
            result = await service(SpanDetector("Ada Lovelace"), codec=codec).encode(
                ["contact Ada Lovelace today"], SCOPE
            )
            assert isinstance(result, EncodedBatch)
            assert "Ada Lovelace" not in result.texts[0]
