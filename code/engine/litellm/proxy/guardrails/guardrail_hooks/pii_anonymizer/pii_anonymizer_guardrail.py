from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import TYPE_CHECKING, Final, Literal, Optional, assert_never

from litellm._logging import verbose_proxy_logger
from litellm.exceptions import BlockedPiiEntityError, GuardrailRaisedException
from litellm.integrations.custom_guardrail import CustomGuardrail, log_guardrail_information
from litellm.pii.codec.action_aware import ActionAwareCodec, SpanAction, blocked_entities
from litellm.pii.config import CodecId, PiiSettings, build_codec, build_detector
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import EncodedBatch, PiiService
from litellm.pii.store.base import TokenScope
from litellm.pii.store.request_scoped import RequestScopedStore
from litellm.pii.types import (
    CodecError,
    DecodeFailed,
    DetectionError,
    DetectorInvalidResponse,
    DetectorUnavailable,
    KeyUnavailable,
    StoreError,
    StoreUnavailable,
    TokenSpaceExhausted,
    UnknownToken,
)
from litellm.types.guardrails import GuardrailEventHooks, PiiAction
from litellm.types.proxy.guardrails.guardrail_hooks.pii_anonymizer import (
    PiiAnonymizerConfigModel,
)
from litellm.types.utils import GenericGuardrailAPIInputs

if TYPE_CHECKING:
    from litellm.litellm_core_utils.litellm_logging import Logging as LiteLLMLoggingObj

TOKEN_BUCKET_KEY: Final = "pii_tokens"
REQUEST_SESSION_ID: Final = "request"
SUPPORTED_EVENT_HOOKS: Final = (
    GuardrailEventHooks.pre_call,
    GuardrailEventHooks.during_call,
    GuardrailEventHooks.post_call,
)


def _to_span_action(action: PiiAction | str) -> SpanAction:
    raw: Final = action.value if isinstance(action, PiiAction) else action
    return SpanAction(raw) if raw in SpanAction.__members__ else SpanAction.ENCODE


def _public_message(error: DetectionError | CodecError | StoreError) -> str:
    """Map the internal error union onto the message the caller is allowed to see."""
    match error:
        case DetectorUnavailable(detector=detector, reason=reason):
            return f"PII {detector.value} detector unavailable: {reason}"
        case DetectorInvalidResponse(detector=detector, reason=reason):
            return f"PII {detector.value} detector returned an invalid response: {reason}"
        case StoreUnavailable(reason=reason):
            return f"PII token store unavailable: {reason}"
        case KeyUnavailable(reason=reason):
            return f"PII encryption key unavailable: {reason}"
        case DecodeFailed(reason=reason):
            return f"PII token could not be decoded: {reason}"
        case UnknownToken(token=token):
            return f"Unknown PII token: {token}"
        case TokenSpaceExhausted(entity_type=entity_type):
            return f"No free PII token remained for {entity_type}"
        case _:
            assert_never(error)


class PiiAnonymizerGuardrail(CustomGuardrail):
    """Reversible PII anonymization on the LLM path.

    Implements only ``apply_guardrail``, so every API surface the proxy already
    translates for (chat completions, Anthropic messages, Responses, MCP,
    realtime) is covered by one implementation rather than per-surface parsing.

    Tokens live in the request's own metadata and die with it: the model never
    sees real PII, and the caller never sees a token.
    """

    @classmethod
    def get_supported_event_hooks(cls) -> list[GuardrailEventHooks]:  # mutable-ok: base class wants a list
        return list(SUPPORTED_EVENT_HOOKS)  # mutable-ok: base class wants a list

    @staticmethod
    def get_config_model() -> type[PiiAnonymizerConfigModel]:
        return PiiAnonymizerConfigModel

    def __init__(
        self,
        detector: CascadingDetector | None = None,
        codec_id: CodecId = "placeholder",
        pii_entities_config: Mapping[str, PiiAction | str] | None = None,
        default_action: PiiAction | str = PiiAction.ENCODE,
        **kwargs,  # kwargs-ok: forwarded verbatim to CustomGuardrail, which owns the shared guardrail options
    ):
        kwargs.setdefault("supported_event_hooks", list(SUPPORTED_EVENT_HOOKS))  # mutable-ok: base class wants a list
        super().__init__(**kwargs)
        self.guardrail_provider = "pii_anonymizer"
        # The framework drops text rewrites on the streaming path under the default
        # "block_only", so a streamed response would reach the caller still tokenized.
        self.streaming_transform_mode = "incremental_diff"
        self.mask_response_content = True
        self.detector: Final = detector
        configured: Final = pii_entities_config.items() if pii_entities_config else ()
        actions: Final = {e: _to_span_action(a) for e, a in configured}  # mutable-ok: frozen just below
        self.actions: Final[Mapping[str, SpanAction]] = MappingProxyType(actions)
        self.codec: Final = ActionAwareCodec(
            inner=build_codec(codec_id),
            actions=self.actions,
            default_action=_to_span_action(default_action),
        )

    def _token_bucket(self, request_data: dict) -> dict:  # mutable-ok: live per-request map
        metadata: Final[dict] = request_data.setdefault("metadata", {})  # mutable-ok: live dict
        return metadata.setdefault(TOKEN_BUCKET_KEY, {})  # mutable-ok: written through by the store

    def _service(self, request_data: dict) -> PiiService | None:  # mutable-ok: framework passes a dict
        if self.detector is None:
            return None
        return PiiService(
            detector=self.detector,
            codec=self.codec,
            store=RequestScopedStore(self._token_bucket(request_data)),
        )

    def _raise_public(self, error: DetectionError | CodecError | StoreError) -> None:
        raise GuardrailRaisedException(
            guardrail_name=self.guardrail_name,
            message=_public_message(error),
            should_wrap_with_default_message=False,
        )

    async def _decode(
        self,
        service: PiiService,
        inputs: GenericGuardrailAPIInputs,
        texts: Sequence[str],
        scope: TokenScope,
    ) -> GenericGuardrailAPIInputs:
        decoded: Final = await service.decode(texts=texts, scope=scope)
        if not isinstance(decoded, tuple):
            self._raise_public(decoded)
        # Per choice, in the order the texts arrived. This is what lets a token
        # split across chunk boundaries be decoded rather than emitted in pieces.
        holdback: Final = [self.codec.grammar.holdback_chars(t) for t in decoded]  # mutable-ok: typed as list[int]
        texts_out: Final = list(decoded)  # mutable-ok: the TypedDict types texts as list[str]
        both: Final = {"texts": texts_out, "stream_holdback_chars": holdback}  # mutable-ok: TypedDict
        updated: Final[GenericGuardrailAPIInputs] = {**inputs, **both}  # mutable-ok: TypedDict
        return updated

    async def _encode(
        self,
        service: PiiService,
        inputs: GenericGuardrailAPIInputs,
        texts: Sequence[str],
        scope: TokenScope,
    ) -> GenericGuardrailAPIInputs:
        encoded: Final = await service.encode(texts=texts, scope=scope, is_reversible=self.codec.is_reversible)
        if not isinstance(encoded, EncodedBatch):
            self._raise_public(encoded)

        blocked: Final = blocked_entities(
            tuple(span for spans in encoded.spans_by_text for span in spans),
            self.actions,
        )
        if blocked:
            raise BlockedPiiEntityError(entity_type=blocked[0], guardrail_name=self.guardrail_name)

        texts_out: Final = list(encoded.texts)  # mutable-ok: the TypedDict types texts as list[str]
        updated: Final[GenericGuardrailAPIInputs] = {**inputs, "texts": texts_out}  # mutable-ok: TypedDict
        return updated

    @log_guardrail_information
    async def apply_guardrail(
        self,
        inputs: GenericGuardrailAPIInputs,
        request_data: dict,  # mutable-ok: CustomGuardrail.apply_guardrail declares request_data as a plain dict
        input_type: Literal["request", "response"],
        logging_obj: Optional["LiteLLMLoggingObj"] = None,
    ) -> GenericGuardrailAPIInputs:
        texts: Final[Sequence[str]] = inputs.get("texts") or ()
        if not texts:
            return inputs

        service: Final = self._service(request_data)
        if service is None:
            verbose_proxy_logger.warning(
                "PII anonymizer guardrail %s has no analyzer configured; passing text through unchanged.",
                self.guardrail_name,
            )
            return inputs

        scope: Final = TokenScope(namespace=REQUEST_SESSION_ID, session_id=REQUEST_SESSION_ID)
        if input_type == "response":
            return await self._decode(service, inputs, texts, scope)
        return await self._encode(service, inputs, texts, scope)


def build_guardrail_detector(
    presidio_analyzer_api_base: str | None,
    ner_api_base: str | None,
    ner_stage_policy: str | None,
    ner_score_threshold: float | None,
    fail_closed: bool | None,
) -> CascadingDetector | None:
    base_settings: Final = PiiSettings.from_env()
    settings: Final = PiiSettings(
        analyzer_api_base=presidio_analyzer_api_base or base_settings.analyzer_api_base,
        ner_api_base=ner_api_base or base_settings.ner_api_base,
        ner_stage_policy=(NerStagePolicy(ner_stage_policy) if ner_stage_policy else base_settings.ner_stage_policy),
        ner_score_threshold=(
            ner_score_threshold if ner_score_threshold is not None else base_settings.ner_score_threshold
        ),
        session_ttl_seconds=base_settings.session_ttl_seconds,
        fail_closed=base_settings.fail_closed if fail_closed is None else fail_closed,
    )
    return build_detector(settings)
