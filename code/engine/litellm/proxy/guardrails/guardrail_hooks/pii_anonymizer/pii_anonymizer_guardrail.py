from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import TYPE_CHECKING, Final, Literal, Optional, assert_never

from litellm._logging import verbose_proxy_logger
from litellm.caching.dual_cache import DualCache
from litellm.exceptions import BlockedPiiEntityError, GuardrailRaisedException
from litellm.integrations.custom_guardrail import CustomGuardrail, log_guardrail_information
from litellm.pii.codec.action_aware import ActionAwareCodec, SpanAction, blocked_entities
from litellm.pii.config import (
    DEFAULT_LANGUAGE,
    CodecId,
    PiiSettings,
    build_codec,
    build_detector,
)
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import EncodedBatch, PiiService
from litellm.pii.store.base import PiiTokenStore, TokenScope
from litellm.pii.store.cipher import cipher_from_env
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.store.request_scoped import RequestScopedStore
from litellm.pii.store.scope import MappingScope, ScopeResolver
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
SESSION_ID_KEY: Final = "litellm_session_id"
API_KEY_METADATA_KEY: Final = "user_api_key"
SUPPORTED_EVENT_HOOKS: Final = (
    GuardrailEventHooks.pre_call,
    GuardrailEventHooks.during_call,
    GuardrailEventHooks.post_call,
)


def _to_mapping_scope(scope: str | None) -> MappingScope:
    return MappingScope(scope) if scope in MappingScope.__members__.values() else MappingScope.REQUEST


def _shared_cache() -> DualCache | None:
    """The proxy's cross-worker cache, or None when only a per-worker one exists.

    Imported here rather than at module load, which would be a cycle.
    """
    from litellm.proxy.proxy_server import proxy_logging_obj

    cache: Final = getattr(getattr(proxy_logging_obj, "internal_usage_cache", None), "dual_cache", None)
    if not isinstance(cache, DualCache) or cache.redis_cache is None:
        return None
    return cache


def _arguments_of(tool_call: object) -> str:
    """The JSON argument string of a tool call, or empty when it has none."""
    if not isinstance(tool_call, Mapping):
        return ""
    function: Final = tool_call.get("function")
    arguments: Final = function.get("arguments") if isinstance(function, Mapping) else None
    return arguments if isinstance(arguments, str) else ""


def _with_arguments(tool_call: object, arguments: str) -> object:
    if not isinstance(tool_call, Mapping):
        return tool_call
    function: Final = tool_call.get("function")
    if not isinstance(function, Mapping) or not isinstance(function.get("arguments"), str):
        return tool_call
    rewritten: Final = {**function, "arguments": arguments}  # mutable-ok: plain tool-call dict
    return {**tool_call, "function": rewritten}  # mutable-ok: plain tool-call dict


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
        pii_mapping_scope: str | None = None,
        session_cache: DualCache | None = None,
        fail_closed: bool = True,
        unmet_requirement: str | None = None,
        language: str = DEFAULT_LANGUAGE,
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
        self.fail_closed: Final = fail_closed
        self.unmet_requirement: Final = unmet_requirement
        self.language: Final = language
        configured: Final = pii_entities_config.items() if pii_entities_config else ()
        actions: Final = {e: _to_span_action(a) for e, a in configured}  # mutable-ok: frozen just below
        self.actions: Final[Mapping[str, SpanAction]] = MappingProxyType(actions)
        self.codec: Final = ActionAwareCodec(
            inner=build_codec(codec_id),
            actions=self.actions,
            default_action=_to_span_action(default_action),
        )
        self.scope_resolver: Final = ScopeResolver(mapping_scope=_to_mapping_scope(pii_mapping_scope))
        self.session_cache: Final = (
            (session_cache or _shared_cache()) if self.scope_resolver.needs_shared_cache() else None
        )
        if self.scope_resolver.needs_shared_cache() and self.session_cache is None:
            raise ValueError(
                f"PII guardrail {self.guardrail_name}: pii_mapping_scope='conversation' needs a shared cache, "
                "since a conversation outlives one request and workers would otherwise each hold their own "
                "mapping and fail to decode each other's tokens. Configure Redis, or use the default "
                "pii_mapping_scope='request'."
            )

    def _token_bucket(self, request_data: dict) -> dict:  # mutable-ok: live per-request map
        metadata: Final[dict] = request_data.setdefault("metadata", {})  # mutable-ok: live dict
        return metadata.setdefault(TOKEN_BUCKET_KEY, {})  # mutable-ok: written through by the store

    def _store(self, request_data: dict) -> PiiTokenStore:  # mutable-ok: framework passes a dict
        if self.session_cache is None:
            return RequestScopedStore(self._token_bucket(request_data))
        return DualCacheStore(cache=self.session_cache, cipher=cipher_from_env())

    def _scope(self, request_data: dict) -> TokenScope:  # mutable-ok: framework passes a dict
        metadata: Final = request_data.get("metadata")
        api_key: Final = metadata.get(API_KEY_METADATA_KEY) if isinstance(metadata, dict) else None
        session_id: Final = request_data.get(SESSION_ID_KEY)
        return self.scope_resolver.resolve(
            api_key=api_key if isinstance(api_key, str) else None,
            session_id=session_id if isinstance(session_id, str) else None,
        )

    def _service(self, request_data: dict) -> PiiService | None:  # mutable-ok: framework passes a dict
        if self.detector is None:
            return None
        return PiiService(detector=self.detector, codec=self.codec, store=self._store(request_data))

    def _raise_public(self, error: DetectionError | CodecError | StoreError) -> None:
        raise GuardrailRaisedException(
            guardrail_name=self.guardrail_name,
            message=_public_message(error),
            should_wrap_with_default_message=False,
        )

    def _rebuild(
        self,
        inputs: GenericGuardrailAPIInputs,
        tool_calls: Sequence[object],
        processed: Sequence[str],
        text_count: int,
        with_holdback: bool,
    ) -> GenericGuardrailAPIInputs:
        """Split the shared result back into texts and tool-call arguments.

        Holdback is per text choice only, in the order the texts arrived, which
        is what lets a token split across chunk boundaries be decoded rather
        than emitted in pieces.
        """
        texts_out: Final = list(processed[:text_count])  # mutable-ok: typed as list[str]
        args_out: Final = processed[text_count:]
        calls_out: Final = [_with_arguments(c, a) for c, a in zip(tool_calls, args_out)]  # mutable-ok: list
        holds: Final = [self.codec.grammar.holdback_chars(t) for t in texts_out]  # mutable-ok: list
        optional: Final = (
            *((("tool_calls", calls_out),) if tool_calls else ()),
            *((("stream_holdback_chars", holds),) if with_holdback else ()),
        )
        updated: Final[GenericGuardrailAPIInputs] = {  # mutable-ok: TypedDict literal
            **inputs,
            "texts": texts_out,
            **dict(optional),  # mutable-ok: spread into the literal above
        }
        return updated

    async def _decode(
        self,
        service: PiiService,
        inputs: GenericGuardrailAPIInputs,
        texts: Sequence[str],
        tool_calls: Sequence[object],
        scope: TokenScope,
    ) -> GenericGuardrailAPIInputs:
        combined: Final = (*texts, *(_arguments_of(call) for call in tool_calls))
        decoded: Final = await service.decode(texts=combined, scope=scope)
        if not isinstance(decoded, tuple):
            self._raise_public(decoded)
        return self._rebuild(inputs, tool_calls, decoded, len(texts), with_holdback=True)

    async def _encode(
        self,
        service: PiiService,
        inputs: GenericGuardrailAPIInputs,
        texts: Sequence[str],
        tool_calls: Sequence[object],
        scope: TokenScope,
    ) -> GenericGuardrailAPIInputs:
        # One shared token space across messages and tool-call arguments, so the same
        # person named in both gets one token. `<` and `>` need no JSON escaping, so
        # encoding inside an arguments string leaves it valid JSON.
        combined: Final = (*texts, *(_arguments_of(call) for call in tool_calls))
        encoded: Final = await service.encode(
            texts=combined,
            scope=scope,
            language=self.language,
            is_reversible=self.codec.is_reversible,
        )
        if not isinstance(encoded, EncodedBatch):
            self._raise_public(encoded)

        blocked: Final = blocked_entities(
            tuple(span for spans in encoded.spans_by_text for span in spans),
            self.actions,
        )
        if blocked:
            raise BlockedPiiEntityError(entity_type=blocked[0], guardrail_name=self.guardrail_name)

        return self._rebuild(inputs, tool_calls, encoded.texts, len(texts), with_holdback=False)

    @log_guardrail_information
    async def apply_guardrail(
        self,
        inputs: GenericGuardrailAPIInputs,
        request_data: dict,  # mutable-ok: CustomGuardrail.apply_guardrail declares request_data as a plain dict
        input_type: Literal["request", "response"],
        logging_obj: Optional["LiteLLMLoggingObj"] = None,
    ) -> GenericGuardrailAPIInputs:
        texts: Final[Sequence[str]] = inputs.get("texts") or ()
        tool_calls: Final[Sequence[object]] = inputs.get("tool_calls") or ()
        if not texts and not tool_calls:
            return inputs

        service: Final = self._service(request_data)
        if service is None:
            # Forwarding unscanned is the one outcome a PII guardrail must never
            # have by default: it looks like success while sending the very data
            # it exists to withhold.
            reason: Final = self.unmet_requirement or "no PII detector is configured"
            if self.fail_closed:
                raise GuardrailRaisedException(
                    guardrail_name=self.guardrail_name,
                    message=f"PII anonymization is not available: {reason}",
                    should_wrap_with_default_message=False,
                )
            verbose_proxy_logger.warning(
                "PII anonymizer guardrail %s is forwarding text unscanned (%s). "
                "This sends unredacted PII to the provider.",
                self.guardrail_name,
                reason,
            )
            return inputs

        scope: Final = self._scope(request_data)
        if input_type == "response":
            return await self._decode(service, inputs, texts, tool_calls, scope)
        return await self._encode(service, inputs, texts, tool_calls, scope)


def guardrail_settings(
    presidio_analyzer_api_base: str | None,
    ner_api_base: str | None,
    ner_stage_policy: str | None,
    ner_score_threshold: float | None,
    fail_closed: bool | None,
    language: str | None = None,
) -> PiiSettings:
    """Guardrail-level overrides layered onto the process environment."""
    base_settings: Final = PiiSettings.from_env()
    return PiiSettings(
        analyzer_api_base=presidio_analyzer_api_base or base_settings.analyzer_api_base,
        ner_api_base=ner_api_base or base_settings.ner_api_base,
        ner_stage_policy=(NerStagePolicy(ner_stage_policy) if ner_stage_policy else base_settings.ner_stage_policy),
        ner_score_threshold=(
            ner_score_threshold if ner_score_threshold is not None else base_settings.ner_score_threshold
        ),
        session_ttl_seconds=base_settings.session_ttl_seconds,
        fail_closed=base_settings.fail_closed if fail_closed is None else fail_closed,
        require_ner=base_settings.require_ner,
        language=language or base_settings.language,
        ner_max_chars=base_settings.ner_max_chars,
    )


def build_guardrail_detector(
    presidio_analyzer_api_base: str | None,
    ner_api_base: str | None,
    ner_stage_policy: str | None,
    ner_score_threshold: float | None,
    fail_closed: bool | None,
    language: str | None = None,
) -> CascadingDetector | None:
    """Kept so the detector and the settings reported alongside it cannot drift apart."""
    return build_detector(
        guardrail_settings(
            presidio_analyzer_api_base=presidio_analyzer_api_base,
            ner_api_base=ner_api_base,
            ner_stage_policy=ner_stage_policy,
            ner_score_threshold=ner_score_threshold,
            fail_closed=fail_closed,
            language=language,
        )
    )
