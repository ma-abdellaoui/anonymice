from types import MappingProxyType
from typing import TYPE_CHECKING, Final

from litellm._logging import verbose_proxy_logger
from litellm.types.guardrails import SupportedGuardrailIntegrations

from .pii_anonymizer_guardrail import PiiAnonymizerGuardrail, guardrail_settings

if TYPE_CHECKING:
    from litellm.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(litellm_params: "LitellmParams", guardrail: "Guardrail") -> PiiAnonymizerGuardrail:
    import litellm

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("PII anonymizer guardrail requires a guardrail_name")

    from litellm.pii.config import build_detector, unmet_requirement

    settings: Final = guardrail_settings(
        presidio_analyzer_api_base=getattr(litellm_params, "presidio_analyzer_api_base", None),
        ner_api_base=getattr(litellm_params, "pii_ner_api_base", None),
        ner_stage_policy=getattr(litellm_params, "pii_ner_stage_policy", None),
        ner_score_threshold=getattr(litellm_params, "pii_ner_score_threshold", None),
        fail_closed=getattr(litellm_params, "pii_fail_closed", None),
        language=getattr(litellm_params, "pii_language", None),
    )
    detector: Final = build_detector(settings)
    missing: Final = unmet_requirement(settings)
    if missing is not None:
        verbose_proxy_logger.warning("PII anonymizer guardrail %s cannot detect: %s", guardrail_name, missing)

    callback: Final = PiiAnonymizerGuardrail(
        guardrail_name=guardrail_name,
        detector=detector,
        codec_id=getattr(litellm_params, "pii_codec", None) or "placeholder",
        pii_entities_config=litellm_params.pii_entities_config,
        pii_mapping_scope=getattr(litellm_params, "pii_mapping_scope", None),
        fail_closed=settings.fail_closed,
        unmet_requirement=missing,
        language=settings.language,
        event_hook=litellm_params.mode,
        default_on=litellm_params.default_on,
    )
    litellm.logging_callback_manager.add_litellm_callback(callback)
    return callback


guardrail_initializer_registry: Final = MappingProxyType(
    {SupportedGuardrailIntegrations.PII_ANONYMIZER.value: initialize_guardrail}
)

guardrail_class_registry: Final = MappingProxyType(
    {SupportedGuardrailIntegrations.PII_ANONYMIZER.value: PiiAnonymizerGuardrail}
)

__all__ = ("PiiAnonymizerGuardrail", "initialize_guardrail")
