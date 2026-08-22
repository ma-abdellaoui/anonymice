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
        default="always",
        description=(
            "When the model-based stage runs. 'always' (default) scans every request with the "
            "model. Under 'on_miss' a single email found by the rules stage suppresses it, and "
            "every name in that same text reaches the provider in the clear."
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
    pii_language: str | None = Field(
        default="en",
        description=(
            "Language passed to the rule-based analyzer. The analyzer must have been built with "
            "this language registered; asking for one it does not know fails the request rather "
            "than falling back to English. The bundled image registers 'en' and 'de'."
        ),
    )
    pii_mapping_scope: Literal["request", "conversation"] | None = Field(
        default="request",
        description=(
            "How long a token mapping lives. 'request' (default) persists nothing: the proxy "
            "decodes before returning, so the next turn re-encodes from real values. "
            "'conversation' keys the mapping on the session id for prompt-cache stability and "
            "cross-turn coreference, holds it in the shared cache, and needs Redis."
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
        description="When the model-based stage runs. Defaults to 'always'.",
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
    pii_language: str | None = Field(
        default=None,
        description="Language passed to the rule-based analyzer. Defaults to 'en'. The bundled analyzer knows 'en' and 'de'.",
    )
    pii_mapping_scope: Literal["request", "conversation"] | None = Field(
        default=None,
        description="Token mapping lifetime: 'request' (default) or 'conversation'. Conversation scope needs Redis.",
    )
