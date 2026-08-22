import os
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

from litellm.pii.codec.base import PiiCodec
from litellm.pii.codec.encrypted import EncryptedCodec
from litellm.pii.codec.handle import HandleCodec
from litellm.pii.codec.placeholder import PlaceholderCodec
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.detection.piiranha import PiiranhaDetector
from litellm.pii.detection.presidio_rules import PresidioRulesDetector
from litellm.pii.service import PiiService
from litellm.pii.store.base import PiiTokenStore
from litellm.pii.store.cipher import cipher_from_env
from litellm.pii.store.dual_cache import (
    DEFAULT_SESSION_TTL_SECONDS,
    AsyncKeyValueCache,
    DualCacheStore,
)
from litellm.pii.types import DEFAULT_NER_SCORE_THRESHOLD

CodecId: TypeAlias = Literal["placeholder", "handle", "encrypted"]

# The model stage runs on every request by default. Under ``on_miss`` it runs
# only when the rules stage found nothing, so one email in the text is enough to
# skip it, and every name in that same text reaches the provider in the clear.
DEFAULT_NER_STAGE_POLICY: Final = NerStagePolicy.ALWAYS

ENV_ANALYZER_API_BASE: Final = "PRESIDIO_ANALYZER_API_BASE"
ENV_NER_API_BASE: Final = "LITELLM_PII_NER_API_BASE"
ENV_NER_STAGE_POLICY: Final = "LITELLM_PII_NER_STAGE_POLICY"
ENV_SESSION_TTL: Final = "LITELLM_PII_SESSION_TTL_SECONDS"
ENV_REQUIRE_NER: Final = "LITELLM_PII_REQUIRE_NER"

FALSEY: Final = frozenset({"0", "false", "no", "off"})


def _int_from_env(name: str, fallback: int) -> int:
    raw: Final = os.getenv(name)
    if raw is None:
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def _bool_from_env(name: str, fallback: bool) -> bool:
    raw: Final = os.getenv(name)
    if raw is None:
        return fallback
    return raw.strip().lower() not in FALSEY


def _policy_from_env() -> NerStagePolicy:
    raw: Final = os.getenv(ENV_NER_STAGE_POLICY, DEFAULT_NER_STAGE_POLICY.value)
    try:
        return NerStagePolicy(raw)
    except ValueError:
        return DEFAULT_NER_STAGE_POLICY


@dataclass(frozen=True, slots=True)
class PiiSettings:
    analyzer_api_base: str | None = None
    ner_api_base: str | None = None
    ner_stage_policy: NerStagePolicy = DEFAULT_NER_STAGE_POLICY
    ner_score_threshold: float = DEFAULT_NER_SCORE_THRESHOLD
    session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS
    fail_closed: bool = True
    require_ner: bool = True

    @classmethod
    def from_env(cls) -> "PiiSettings":
        return cls(
            analyzer_api_base=os.getenv(ENV_ANALYZER_API_BASE),
            ner_api_base=os.getenv(ENV_NER_API_BASE),
            ner_stage_policy=_policy_from_env(),
            session_ttl_seconds=_int_from_env(ENV_SESSION_TTL, DEFAULT_SESSION_TTL_SECONDS),
            require_ner=_bool_from_env(ENV_REQUIRE_NER, True),
        )


def build_codec(codec_id: CodecId) -> PiiCodec:
    match codec_id:
        case "placeholder":
            return PlaceholderCodec()
        case "handle":
            return HandleCodec()
        case "encrypted":
            return EncryptedCodec(cipher=cipher_from_env())


def unmet_requirement(settings: PiiSettings) -> str | None:
    """Why detection cannot run, or ``None`` when it can.

    Returned as a message rather than a bool so the refusal can say which
    setting is missing instead of leaving an operator to guess.
    """
    if not settings.analyzer_api_base:
        return f"{ENV_ANALYZER_API_BASE} is not set, so no PII detection can run"
    if settings.require_ner and not settings.ner_api_base:
        return (
            f"{ENV_NER_API_BASE} is not set. The rules stage covers only pattern and checksum "
            "entities, so names and other model-detected entities would reach the provider in the "
            f"clear. Point it at the NER service, or set {ENV_REQUIRE_NER}=false to accept that."
        )
    return None


def build_detector(settings: PiiSettings) -> CascadingDetector | None:
    if unmet_requirement(settings) is not None:
        return None
    return CascadingDetector(
        rules=PresidioRulesDetector(analyzer_api_base=settings.analyzer_api_base),
        ner=(
            PiiranhaDetector(api_base=settings.ner_api_base, score_threshold=settings.ner_score_threshold)
            if settings.ner_api_base
            else None
        ),
        policy=settings.ner_stage_policy,
        low_confidence_threshold=settings.ner_score_threshold,
        fail_closed=settings.fail_closed,
    )


def build_session_store(cache: AsyncKeyValueCache, settings: PiiSettings) -> PiiTokenStore:
    return DualCacheStore(cache=cache, cipher=cipher_from_env(), ttl_seconds=settings.session_ttl_seconds)


def build_service(
    cache: AsyncKeyValueCache,
    settings: PiiSettings | None = None,
    codec_id: CodecId = "handle",
) -> PiiService | None:
    """Assemble the endpoint-path service, or ``None`` when detection is unconfigured.

    Defaults to the handle codec: endpoint tokens must stay resolvable long
    after the call that minted them, and a random handle keeps the token short
    while leaving the value revocable by deleting its store entry.
    """
    resolved: Final = settings or PiiSettings.from_env()
    detector: Final = build_detector(resolved)
    if detector is None:
        return None
    return PiiService(
        detector=detector,
        codec=build_codec(codec_id),
        store=build_session_store(cache, resolved),
    )
