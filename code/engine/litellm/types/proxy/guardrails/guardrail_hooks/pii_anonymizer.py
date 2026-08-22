from typing import Literal

from pydantic import BaseModel, Field

from .base import GuardrailConfigModel


class PiiAnonymizerConfigModelOptionalParams(BaseModel):
    pii_ner_api_base: str | None = Field(
        default=None,
        description=(
            "Base URL of the second-stage NER inference server, speaking the HuggingFace "
            "token-classification contract. Reads LITELLM_PII_NER_API_BASE if unset. "
            "Leave empty to run rule-based detection only."
        ),
    )
    pii_ner_stage_policy: Literal["never", "on_miss", "on_low_confidence", "always"] | None = Field(
        default="on_miss",
        description=(
            "When the model-based stage runs. 'on_miss' (default) only calls it when the rule "
            "stage finds nothing, so most requests pay only for the cheap deterministic pass."
        ),
    )
    pii_ner_score_threshold: float | None = Field(
        default=0.5,
        description="Minimum confidence for a model-based detection, and the 'on_low_confidence' cutoff.",
    )
    pii_codec: Literal["placeholder", "handle", "encrypted"] | None = Field(
        default="placeholder",
        description=(
            "Token format. 'placeholder' emits <PERSON_1>, which keeps model output quality high "
            "and is the right default on the LLM path. 'handle' emits an opaque random token. "
            "'encrypted' carries its own ciphertext and needs no store."
        ),
    )
    pii_fail_closed: bool | None = Field(
        default=True,
        description=(
            "When a detector is unreachable, reject the request instead of forwarding it unscanned. "
            "Turning this off can send unredacted PII to the provider during an outage."
        ),
    )


class PiiAnonymizerConfigModel(GuardrailConfigModel[PiiAnonymizerConfigModelOptionalParams]):
    presidio_analyzer_api_base: str | None = Field(
        default=None,
        description="Base URL of the Presidio analyzer used for rule-based detection. Reads PRESIDIO_ANALYZER_API_BASE if unset.",
    )

    @staticmethod
    def ui_friendly_name() -> str:
        return "PII Anonymizer"


class PiiAnonymizerLitellmParams(BaseModel):
    """Flat form of the anonymizer settings as they appear under a guardrail's litellm_params."""

    pii_ner_api_base: str | None = Field(
        default=None,
        description="Base URL of the second-stage NER inference server (HuggingFace token-classification contract).",
    )
    pii_ner_stage_policy: Literal["never", "on_miss", "on_low_confidence", "always"] | None = Field(
        default=None,
        description="When the model-based stage runs. Defaults to 'on_miss'.",
    )
    pii_ner_score_threshold: float | None = Field(
        default=None,
        description="Minimum confidence for a model-based detection.",
    )
    pii_codec: Literal["placeholder", "handle", "encrypted"] | None = Field(
        default=None,
        description="Token format for the anonymizer. Defaults to 'placeholder'.",
    )
    pii_fail_closed: bool | None = Field(
        default=None,
        description="Reject the request when a detector is unreachable, rather than forwarding it unscanned.",
    )
