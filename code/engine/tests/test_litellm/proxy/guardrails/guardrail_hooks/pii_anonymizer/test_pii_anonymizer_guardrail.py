"""Tests for the reversible PII anonymizer guardrail on the LLM path."""

import pytest

from litellm.exceptions import BlockedPiiEntityError, GuardrailRaisedException
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.types import DetectorKind, DetectorUnavailable, PiiSpan
from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import (
    PiiAnonymizerGuardrail,
    guardrail_initializer_registry,
)
from litellm.types.guardrails import PiiAction, SupportedGuardrailIntegrations


class SubstringDetector:
    """Locates spans by substring so tests state intent rather than offsets."""

    def __init__(self, mapping=None, error=None):
        self.mapping = mapping or {}
        self.error = error
        self.calls = 0

    async def detect(self, text, language, entities):
        self.calls += 1
        if self.error is not None:
            return self.error
        return tuple(
            PiiSpan(
                entity_type=entity_type,
                start=text.index(needle),
                end=text.index(needle) + len(needle),
                score=0.95,
                detector=DetectorKind.RULES,
            )
            for needle, entity_type in self.mapping.items()
            if needle in text
        )


def guardrail(mapping=None, error=None, entities_config=None, codec_id="placeholder"):
    return PiiAnonymizerGuardrail(
        guardrail_name="pii-anonymizer",
        detector=CascadingDetector(
            rules=SubstringDetector(mapping, error), ner=None, policy=NerStagePolicy.NEVER
        ),
        codec_id=codec_id,
        pii_entities_config=entities_config,
    )


async def run(guard, texts, request_data, input_type):
    result = await guard.apply_guardrail(
        inputs={"texts": list(texts)}, request_data=request_data, input_type=input_type
    )
    return result["texts"]


class TestRegistration:
    def test_registered_under_the_expected_integration_key(self):
        assert SupportedGuardrailIntegrations.PII_ANONYMIZER.value in guardrail_initializer_registry

    def test_exposes_a_ui_config_model(self):
        assert PiiAnonymizerGuardrail.get_config_model().ui_friendly_name() == "PII Anonymizer"

    def test_uses_the_unified_apply_guardrail_interface(self):
        assert guardrail().uses_apply_guardrail_interface() is True


class TestRequestEncoding:
    @pytest.mark.asyncio
    async def test_replaces_detected_pii_with_a_token(self):
        data = {}
        texts = await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], data, "request")
        assert texts == ["hello <PERSON_1>"]

    @pytest.mark.asyncio
    async def test_stores_the_mapping_in_request_metadata(self):
        data = {}
        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], data, "request")
        assert data["metadata"]["pii_tokens"] == {"<PERSON_1>": "Ada"}

    @pytest.mark.asyncio
    async def test_preserves_existing_request_metadata(self):
        data = {"metadata": {"user_api_key": "sk-1"}}
        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], data, "request")
        assert data["metadata"]["user_api_key"] == "sk-1"

    @pytest.mark.asyncio
    async def test_clean_text_is_untouched(self):
        data = {}
        assert await run(guardrail({"Ada": "PERSON"}), ["nothing here"], data, "request") == ["nothing here"]

    @pytest.mark.asyncio
    async def test_one_token_space_is_shared_across_messages(self):
        data = {}
        texts = await run(guardrail({"Ada": "PERSON"}), ["Ada wrote", "Ada signed"], data, "request")
        assert texts == ["<PERSON_1> wrote", "<PERSON_1> signed"]

    @pytest.mark.asyncio
    async def test_empty_input_short_circuits_before_calling_the_detector(self):
        detector = SubstringDetector({"Ada": "PERSON"})
        guard = PiiAnonymizerGuardrail(
            guardrail_name="g",
            detector=CascadingDetector(rules=detector, ner=None, policy=NerStagePolicy.NEVER),
        )
        await guard.apply_guardrail(inputs={"texts": []}, request_data={}, input_type="request")
        assert detector.calls == 0


class TestResponseDecoding:
    @pytest.mark.asyncio
    async def test_round_trip_restores_the_original_value(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        encoded = await run(guard, ["hello Ada"], data, "request")
        assert await run(guard, encoded, data, "response") == ["hello Ada"]

    @pytest.mark.asyncio
    async def test_model_output_referencing_the_token_is_decoded(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        await run(guard, ["hello Ada"], data, "request")
        assert await run(guard, ["I greeted <PERSON_1> for you"], data, "response") == ["I greeted Ada for you"]

    @pytest.mark.asyncio
    async def test_unknown_token_is_left_verbatim(self):
        guard = guardrail({"Ada": "PERSON"})
        assert await run(guard, ["who is <PERSON_9>"], {}, "response") == ["who is <PERSON_9>"]

    @pytest.mark.asyncio
    async def test_tokens_do_not_leak_between_requests(self):
        guard = guardrail({"Ada": "PERSON"})
        first = {}
        await run(guard, ["hello Ada"], first, "request")
        assert await run(guard, ["<PERSON_1>"], {}, "response") == ["<PERSON_1>"]


class TestEntityActions:
    @pytest.mark.asyncio
    async def test_blocked_entity_raises(self):
        guard = guardrail({"4111111111111111": "CREDIT_CARD"}, entities_config={"CREDIT_CARD": PiiAction.BLOCK})
        with pytest.raises(BlockedPiiEntityError):
            await run(guard, ["card 4111111111111111"], {}, "request")

    @pytest.mark.asyncio
    async def test_masked_entity_is_replaced_without_an_ordinal(self):
        guard = guardrail({"Ada": "PERSON"}, entities_config={"PERSON": PiiAction.MASK})
        assert await run(guard, ["hello Ada"], {}, "request") == ["hello <PERSON>"]

    @pytest.mark.asyncio
    async def test_masked_entity_is_not_stored_and_never_comes_back(self):
        guard = guardrail({"Ada": "PERSON"}, entities_config={"PERSON": PiiAction.MASK})
        data = {}
        encoded = await run(guard, ["hello Ada"], data, "request")
        assert data["metadata"]["pii_tokens"] == {}
        assert await run(guard, encoded, data, "response") == ["hello <PERSON>"]

    @pytest.mark.asyncio
    async def test_encode_and_mask_coexist_in_one_text(self):
        guard = guardrail(
            {"Ada": "PERSON", "ada@example.com": "EMAIL_ADDRESS"},
            entities_config={"PERSON": PiiAction.MASK, "EMAIL_ADDRESS": PiiAction.ENCODE},
        )
        data = {}
        encoded = await run(guard, ["Ada at ada@example.com"], data, "request")
        assert encoded == ["<PERSON> at <EMAIL_ADDRESS_1>"]
        assert await run(guard, encoded, data, "response") == ["<PERSON> at ada@example.com"]

    @pytest.mark.asyncio
    async def test_unconfigured_entity_defaults_to_reversible_encoding(self):
        guard = guardrail({"Ada": "PERSON"}, entities_config={"EMAIL_ADDRESS": PiiAction.MASK})
        data = {}
        encoded = await run(guard, ["hello Ada"], data, "request")
        assert encoded == ["hello <PERSON_1>"]
        assert await run(guard, encoded, data, "response") == ["hello Ada"]


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_detector_outage_raises_rather_than_forwarding_unscanned_text(self):
        guard = guardrail(error=DetectorUnavailable(detector=DetectorKind.RULES, reason="HTTP 503"))
        with pytest.raises(GuardrailRaisedException):
            await run(guard, ["hello Ada"], {}, "request")

    @pytest.mark.asyncio
    async def test_missing_detector_passes_through_instead_of_crashing(self):
        guard = PiiAnonymizerGuardrail(guardrail_name="g", detector=None)
        assert await run(guard, ["hello Ada"], {}, "request") == ["hello Ada"]
