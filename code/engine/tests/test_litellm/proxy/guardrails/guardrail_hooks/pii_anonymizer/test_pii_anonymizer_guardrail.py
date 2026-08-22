"""Tests for the reversible PII anonymizer guardrail on the LLM path."""

import json
from typing import get_args

import pytest

from litellm.exceptions import BlockedPiiEntityError, GuardrailRaisedException
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.store.scope import MappingScope
from litellm.pii.types import (
    CodecError,
    DecodeFailed,
    DetectionError,
    DetectorInvalidResponse,
    DetectorKind,
    DetectorUnavailable,
    KeyUnavailable,
    PiiSpan,
    StoreError,
    StoreUnavailable,
    TokenSpaceExhausted,
    UnknownToken,
)
from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import (
    PiiAnonymizerGuardrail,
    guardrail_initializer_registry,
)
from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer.pii_anonymizer_guardrail import _public_message
from litellm.types.guardrails import PiiAction, SupportedGuardrailIntegrations

ERROR_SAMPLES = {
    DetectorUnavailable: DetectorUnavailable(detector=DetectorKind.RULES, reason="down"),
    DetectorInvalidResponse: DetectorInvalidResponse(detector=DetectorKind.NER, reason="not json"),
    UnknownToken: UnknownToken(token="<PERSON_9>"),
    KeyUnavailable: KeyUnavailable(reason="no key configured"),
    DecodeFailed: DecodeFailed(reason="ciphertext corrupt"),
    TokenSpaceExhausted: TokenSpaceExhausted(entity_type="PERSON"),
    StoreUnavailable: StoreUnavailable(reason="redis down"),
}


def error_variants():
    return tuple(
        variant for union in (DetectionError, CodecError, StoreError) for variant in (get_args(union) or (union,))
    )


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


class FakeSharedCache:
    """Stands in for a Redis-backed DualCache shared across workers."""

    def __init__(self):
        self.entries = {}

    async def async_set_cache(self, key, value, **kwargs):
        self.entries[key] = value

    async def async_batch_get_cache(self, keys, **kwargs):
        return [self.entries.get(key) for key in keys]


def guardrail(
    mapping=None,
    error=None,
    entities_config=None,
    codec_id="placeholder",
    mapping_scope=None,
    session_cache=None,
):
    return PiiAnonymizerGuardrail(
        guardrail_name="pii-anonymizer",
        detector=CascadingDetector(rules=SubstringDetector(mapping, error), ner=None, policy=NerStagePolicy.NEVER),
        codec_id=codec_id,
        pii_entities_config=entities_config,
        pii_mapping_scope=mapping_scope,
        session_cache=session_cache,
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
    async def test_missing_detector_refuses_rather_than_passing_through(self):
        """This used to forward the text unscanned, which sent the provider the
        very PII the guardrail exists to withhold while reporting success."""
        guard = PiiAnonymizerGuardrail(guardrail_name="g", detector=None)
        with pytest.raises(GuardrailRaisedException):
            await run(guard, ["hello Ada"], {}, "request")

    @pytest.mark.asyncio
    async def test_passing_through_unscanned_is_available_but_opt_in(self):
        guard = PiiAnonymizerGuardrail(guardrail_name="g", detector=None, fail_closed=False)
        assert await run(guard, ["hello Ada"], {}, "request") == ["hello Ada"]


def tool_call(arguments, name="lookup", call_id="call_1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


class TestToolCalls:
    """`<` and `>` need no JSON escaping, so a token can live inside an arguments string."""

    @pytest.mark.asyncio
    async def test_pii_inside_tool_call_arguments_is_encoded(self):
        guard = guardrail({"Ada": "PERSON"})
        arguments = json.dumps({"name": "Ada", "limit": 5})
        result = await guard.apply_guardrail(
            inputs={"texts": [], "tool_calls": [tool_call(arguments)]},
            request_data={},
            input_type="request",
        )
        encoded = result["tool_calls"][0]["function"]["arguments"]
        assert "Ada" not in encoded
        assert "<PERSON_1>" in encoded

    @pytest.mark.asyncio
    async def test_the_encoded_arguments_are_still_valid_json(self):
        guard = guardrail({"Ada": "PERSON"})
        arguments = json.dumps({"name": "Ada", "note": "call her", "limit": 5})
        result = await guard.apply_guardrail(
            inputs={"texts": [], "tool_calls": [tool_call(arguments)]},
            request_data={},
            input_type="request",
        )
        parsed = json.loads(result["tool_calls"][0]["function"]["arguments"])
        assert parsed == {"name": "<PERSON_1>", "note": "call her", "limit": 5}

    @pytest.mark.asyncio
    async def test_the_rest_of_the_tool_call_is_left_alone(self):
        guard = guardrail({"Ada": "PERSON"})
        result = await guard.apply_guardrail(
            inputs={"texts": [], "tool_calls": [tool_call(json.dumps({"name": "Ada"}), name="search", call_id="c9")]},
            request_data={},
            input_type="request",
        )
        call = result["tool_calls"][0]
        assert (call["id"], call["type"], call["function"]["name"]) == ("c9", "function", "search")

    @pytest.mark.asyncio
    async def test_a_message_and_a_tool_call_share_one_token_space(self):
        guard = guardrail({"Ada": "PERSON"})
        result = await guard.apply_guardrail(
            inputs={"texts": ["ask Ada about it"], "tool_calls": [tool_call(json.dumps({"name": "Ada"}))]},
            request_data={},
            input_type="request",
        )
        assert result["texts"] == ["ask <PERSON_1> about it"]
        assert json.loads(result["tool_calls"][0]["function"]["arguments"]) == {"name": "<PERSON_1>"}

    @pytest.mark.asyncio
    async def test_tool_call_arguments_round_trip_through_decode(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        arguments = json.dumps({"name": "Ada"})
        encoded = await guard.apply_guardrail(
            inputs={"texts": [], "tool_calls": [tool_call(arguments)]}, request_data=data, input_type="request"
        )
        decoded = await guard.apply_guardrail(
            inputs={"texts": [], "tool_calls": encoded["tool_calls"]}, request_data=data, input_type="response"
        )
        assert json.loads(decoded["tool_calls"][0]["function"]["arguments"]) == {"name": "Ada"}

    @pytest.mark.asyncio
    async def test_a_request_with_only_tool_calls_is_not_skipped(self):
        guard = guardrail({"Ada": "PERSON"})
        result = await guard.apply_guardrail(
            inputs={"tool_calls": [tool_call(json.dumps({"name": "Ada"}))]}, request_data={}, input_type="request"
        )
        assert "<PERSON_1>" in result["tool_calls"][0]["function"]["arguments"]

    @pytest.mark.asyncio
    async def test_a_tool_call_without_arguments_is_left_intact(self):
        guard = guardrail({"Ada": "PERSON"})
        malformed = {"id": "c1", "type": "function", "function": {"name": "ping"}}
        result = await guard.apply_guardrail(
            inputs={"texts": ["hi Ada"], "tool_calls": [malformed]}, request_data={}, input_type="request"
        )
        assert result["tool_calls"][0] == malformed
        assert result["texts"] == ["hi <PERSON_1>"]

    @pytest.mark.asyncio
    async def test_inputs_with_neither_texts_nor_tool_calls_pass_through(self):
        result = await guardrail({"Ada": "PERSON"}).apply_guardrail(
            inputs={"texts": []}, request_data={}, input_type="request"
        )
        assert result == {"texts": []}

    @pytest.mark.asyncio
    async def test_holdback_covers_texts_only_not_tool_calls(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        await guard.apply_guardrail(inputs={"texts": ["hi Ada"]}, request_data=data, input_type="request")
        result = await guard.apply_guardrail(
            inputs={"texts": ["one", "two"], "tool_calls": [tool_call(json.dumps({"n": "x"}))]},
            request_data=data,
            input_type="response",
        )
        assert len(result["stream_holdback_chars"]) == 2


class TestMappingScope:
    def test_request_scope_is_the_default(self):
        assert guardrail().scope_resolver.mapping_scope is MappingScope.REQUEST

    def test_request_scope_keeps_tokens_in_the_request_dict_rather_than_a_cache(self):
        assert guardrail().session_cache is None

    def test_an_unrecognised_scope_falls_back_to_request_rather_than_crashing(self):
        assert guardrail(mapping_scope="nonsense").scope_resolver.mapping_scope is MappingScope.REQUEST

    def test_conversation_scope_refuses_to_start_without_a_shared_cache(self):
        with pytest.raises(ValueError, match="shared cache"):
            guardrail(mapping_scope="conversation")

    @pytest.mark.asyncio
    async def test_the_scope_namespace_comes_from_the_calling_key(self):
        guard = guardrail({"Ada": "PERSON"})
        first = guard._scope({"metadata": {"user_api_key": "hashed-a"}})
        second = guard._scope({"metadata": {"user_api_key": "hashed-b"}})
        assert first.namespace != second.namespace

    @pytest.mark.asyncio
    async def test_request_scope_ignores_the_session_id_the_proxy_resolved(self):
        guard = guardrail({"Ada": "PERSON"})
        scope = guard._scope({"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"})
        assert scope.session_id == "request"

    @pytest.mark.asyncio
    async def test_request_data_without_metadata_still_resolves(self):
        assert guardrail()._scope({}).session_id == "request"

    @pytest.mark.asyncio
    async def test_a_non_string_session_id_is_ignored(self):
        assert guardrail()._scope({"litellm_session_id": 42}).session_id == "request"

    @pytest.mark.asyncio
    async def test_two_keys_cannot_read_each_others_tokens_in_one_process(self):
        guard = guardrail({"Ada": "PERSON"})
        first_data = {"metadata": {"user_api_key": "hashed-a"}}
        encoded = await run(guard, ["hello Ada"], first_data, "request")
        assert encoded == ["hello <PERSON_1>"]
        second_data = {"metadata": {"user_api_key": "hashed-b"}}
        assert await run(guard, encoded, second_data, "response") == ["hello <PERSON_1>"]


class TestConversationScope:
    def conversational(self, mapping):
        return guardrail(mapping, mapping_scope="conversation", session_cache=FakeSharedCache())

    @pytest.mark.asyncio
    async def test_a_token_minted_in_one_request_decodes_in_the_next(self):
        guard = self.conversational({"Ada": "PERSON"})
        turn_one = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"}
        encoded = await run(guard, ["hello Ada"], turn_one, "request")
        assert encoded == ["hello <PERSON_1>"]

        turn_two = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"}
        assert await run(guard, encoded, turn_two, "response") == ["hello Ada"]

    @pytest.mark.asyncio
    async def test_another_conversation_cannot_decode_the_token(self):
        guard = self.conversational({"Ada": "PERSON"})
        first = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"}
        encoded = await run(guard, ["hello Ada"], first, "request")

        other = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-2"}
        assert await run(guard, encoded, other, "response") == encoded

    @pytest.mark.asyncio
    async def test_another_key_in_the_same_conversation_cannot_decode_the_token(self):
        guard = self.conversational({"Ada": "PERSON"})
        first = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"}
        encoded = await run(guard, ["hello Ada"], first, "request")

        other = {"metadata": {"user_api_key": "hashed-b"}, "litellm_session_id": "sess-1"}
        assert await run(guard, encoded, other, "response") == encoded

    @pytest.mark.asyncio
    async def test_tokens_go_to_the_shared_cache_rather_than_the_request_dict(self):
        cache = FakeSharedCache()
        guard = guardrail({"Ada": "PERSON"}, mapping_scope="conversation", session_cache=cache)
        data = {"metadata": {"user_api_key": "hashed-a"}, "litellm_session_id": "sess-1"}
        await run(guard, ["hello Ada"], data, "request")
        assert cache.entries
        assert "pii_tokens" not in data["metadata"]

    @pytest.mark.asyncio
    async def test_a_turn_without_a_session_id_falls_back_to_request_scope(self):
        guard = self.conversational({"Ada": "PERSON"})
        data = {"metadata": {"user_api_key": "hashed-a"}}
        encoded = await run(guard, ["hello Ada"], data, "request")
        assert await run(guard, encoded, data, "response") == ["hello Ada"]


class TestStreamingContract:
    """Under the default block_only the framework drops text rewrites, so a
    streamed response would reach the caller still tokenized."""

    def test_the_guardrail_opts_into_incremental_streaming_transforms(self):
        assert guardrail().streaming_transform_mode == "incremental_diff"

    def test_it_declares_that_it_rewrites_response_content(self):
        assert guardrail().mask_response_content is True

    @pytest.mark.asyncio
    async def test_decode_returns_a_holdback_per_choice_in_text_order(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        await guard.apply_guardrail(inputs={"texts": ["hello Ada"]}, request_data=data, input_type="request")
        result = await guard.apply_guardrail(
            inputs={"texts": ["all done", "still <PERSON_"]}, request_data=data, input_type="response"
        )
        assert result["stream_holdback_chars"] == [0, len("<PERSON_")]

    @pytest.mark.asyncio
    async def test_a_complete_token_needs_no_holdback(self):
        guard = guardrail({"Ada": "PERSON"})
        data = {}
        encoded = await guard.apply_guardrail(inputs={"texts": ["hi Ada"]}, request_data=data, input_type="request")
        result = await guard.apply_guardrail(
            inputs={"texts": encoded["texts"]}, request_data=data, input_type="response"
        )
        assert result["texts"] == ["hi Ada"]
        assert result["stream_holdback_chars"] == [0]

    @pytest.mark.asyncio
    async def test_encoding_does_not_request_a_holdback(self):
        result = await guardrail({"Ada": "PERSON"}).apply_guardrail(
            inputs={"texts": ["hello Ada"]}, request_data={}, input_type="request"
        )
        assert "stream_holdback_chars" not in result


class TestPublicMessage:
    """The boundary must stay exhaustive: a new error variant has to be mapped here."""

    def test_every_error_variant_has_a_sample(self):
        assert set(error_variants()) == set(ERROR_SAMPLES)

    @pytest.mark.parametrize("variant", error_variants(), ids=lambda v: v.__name__)
    def test_every_variant_maps_to_a_message(self, variant):
        assert _public_message(ERROR_SAMPLES[variant]).strip()

    def test_the_message_does_not_leak_the_stored_value(self):
        assert "Ada" not in _public_message(UnknownToken(token="<PERSON_9>"))


class TestUnconfiguredGuardrailFailsClosed:
    """Forwarding unscanned is the one outcome a PII guardrail must never have.

    It looks like success while sending the provider exactly the data the
    guardrail exists to withhold, so it has to be opt-in and loud.
    """

    @pytest.mark.asyncio
    async def test_it_refuses_the_request_when_no_detector_is_configured(self):
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        guardrail = PiiAnonymizerGuardrail(
            guardrail_name="pii", detector=None, unmet_requirement="LITELLM_PII_NER_API_BASE is not set"
        )
        with pytest.raises(GuardrailRaisedException, match="not available"):
            await guardrail.apply_guardrail(inputs={"texts": ["Ada Lovelace"]}, request_data={}, input_type="request")

    @pytest.mark.asyncio
    async def test_the_refusal_names_the_missing_setting(self):
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        guardrail = PiiAnonymizerGuardrail(
            guardrail_name="pii", detector=None, unmet_requirement="LITELLM_PII_NER_API_BASE is not set"
        )
        with pytest.raises(GuardrailRaisedException, match="LITELLM_PII_NER_API_BASE"):
            await guardrail.apply_guardrail(inputs={"texts": ["Ada Lovelace"]}, request_data={}, input_type="request")

    @pytest.mark.asyncio
    async def test_failing_closed_is_the_default(self):
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        assert PiiAnonymizerGuardrail(guardrail_name="pii", detector=None).fail_closed is True

    @pytest.mark.asyncio
    async def test_forwarding_unscanned_requires_opting_out(self):
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        guardrail = PiiAnonymizerGuardrail(guardrail_name="pii", detector=None, fail_closed=False)
        result = await guardrail.apply_guardrail(
            inputs={"texts": ["Ada Lovelace"]}, request_data={}, input_type="request"
        )
        assert result["texts"] == ["Ada Lovelace"]

    @pytest.mark.asyncio
    async def test_a_response_is_refused_too_not_just_a_request(self):
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        guardrail = PiiAnonymizerGuardrail(guardrail_name="pii", detector=None)
        with pytest.raises(GuardrailRaisedException):
            await guardrail.apply_guardrail(inputs={"texts": ["<PERSON_1>"]}, request_data={}, input_type="response")

    @pytest.mark.asyncio
    async def test_empty_input_still_passes_without_a_detector(self):
        """Nothing to scan is not the same as failing to scan."""
        from litellm.proxy.guardrails.guardrail_hooks.pii_anonymizer import PiiAnonymizerGuardrail

        guardrail = PiiAnonymizerGuardrail(guardrail_name="pii", detector=None)
        assert await guardrail.apply_guardrail(inputs={"texts": []}, request_data={}, input_type="request") == {
            "texts": []
        }


@pytest.fixture
def recorded(monkeypatch):
    """A fresh activity ring, since the log is a process-wide singleton."""
    from litellm.pii.activity import PiiActivityLog

    fresh = PiiActivityLog(capacity=50)
    monkeypatch.setattr("litellm.pii.activity._LOG", fresh)
    return fresh


class TestActivityRecording:
    @pytest.mark.asyncio
    async def test_an_encode_is_recorded_with_what_it_found(self, recorded):
        from litellm.pii.activity import Applied, PiiDirection, PiiSurface

        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], {}, "request")
        event = recorded.recent(limit=1)[0]
        assert (event.surface, event.direction, event.outcome) == (
            PiiSurface.GUARDRAIL,
            PiiDirection.ENCODE,
            Applied(),
        )
        assert dict(event.entity_counts) == {"PERSON": 1} and event.token_count == 1

    @pytest.mark.asyncio
    async def test_records_the_action_each_entity_took(self, recorded):
        guard = guardrail({"Ada": "PERSON", "111-22-3333": "US_SSN"}, entities_config={"US_SSN": PiiAction.MASK})
        await run(guard, ["Ada 111-22-3333"], {}, "request")
        assert dict(recorded.recent(limit=1)[0].action_counts) == {"ENCODE": 1, "MASK": 1}

    @pytest.mark.asyncio
    async def test_a_blocked_entity_is_recorded_before_the_request_is_refused(self, recorded):
        from litellm.pii.activity import Blocked

        guard = guardrail({"4111 1111 1111 1111": "CREDIT_CARD"}, entities_config={"CREDIT_CARD": PiiAction.BLOCK})
        with pytest.raises(BlockedPiiEntityError):
            await run(guard, ["card 4111 1111 1111 1111"], {}, "request")
        assert recorded.recent(limit=1)[0].outcome == Blocked(entity_type="CREDIT_CARD")

    @pytest.mark.asyncio
    async def test_a_detector_outage_is_recorded_as_a_failure(self, recorded):
        from litellm.pii.activity import Failed

        guard = guardrail(error=DetectorUnavailable(detector=DetectorKind.RULES, reason="down"))
        with pytest.raises(GuardrailRaisedException):
            await run(guard, ["hello Ada"], {}, "request")
        outcome = recorded.recent(limit=1)[0].outcome
        assert isinstance(outcome, Failed) and "down" in outcome.reason

    @pytest.mark.asyncio
    async def test_a_decode_records_how_much_it_resolved(self, recorded):
        from litellm.pii.activity import PiiDirection

        guard = guardrail({"Ada": "PERSON"})
        data = {}
        await run(guard, ["hello Ada"], data, "request")
        await run(guard, ["hi <PERSON_1> and <PERSON_7>"], data, "response")
        event = recorded.recent(limit=1, direction=PiiDirection.DECODE)[0]
        assert (event.token_count, event.resolved_count) == (2, 1)

    @pytest.mark.asyncio
    async def test_nothing_detected_still_leaves_a_record(self, recorded):
        """A request that carried no PII is a fact worth showing, not an absence."""
        await run(guardrail({"Ada": "PERSON"}), ["nothing here"], {}, "request")
        event = recorded.recent(limit=1)[0]
        assert dict(event.entity_counts) == {} and event.token_count == 0

    @pytest.mark.asyncio
    async def test_no_text_is_recorded_unless_capture_is_switched_on(self, recorded, monkeypatch):
        from litellm.pii.activity import ENV_CAPTURE_TEXT

        monkeypatch.delenv(ENV_CAPTURE_TEXT, raising=False)
        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], {}, "request")
        assert recorded.recent(limit=1)[0].capture is None

    @pytest.mark.asyncio
    async def test_capture_pairs_each_value_with_its_token_when_switched_on(self, recorded, monkeypatch):
        from litellm.pii.activity import ENV_CAPTURE_TEXT

        monkeypatch.setenv(ENV_CAPTURE_TEXT, "true")
        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], {}, "request")
        capture = recorded.recent(limit=1)[0].capture
        assert capture.before == ("hello Ada",) and capture.after == ("hello <PERSON_1>",)
        assert [(p.token, p.value) for p in capture.placements] == [("<PERSON_1>", "Ada")]

    @pytest.mark.asyncio
    async def test_attributes_the_event_to_the_calling_key_and_model(self, recorded):
        data = {"model": "gpt-4o-mini", "metadata": {"user_api_key_alias": "demo-key", "user_api_key_user_id": "u1"}}
        await run(guardrail({"Ada": "PERSON"}), ["hello Ada"], data, "request")
        event = recorded.recent(limit=1)[0]
        assert (event.model, event.key_alias, event.user_id) == ("gpt-4o-mini", "demo-key", "u1")
