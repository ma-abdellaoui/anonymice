"""Standalone PII detect / encode / decode endpoints.

These are adapters, not a second implementation: every route delegates to the
same :class:`~litellm.pii.service.PiiService` the anonymizer guardrail runs on
the LLM path. A browser extension calling ``/pii/encode`` therefore gets exactly
the behaviour an in-flight completion would.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, assert_never

from fastapi import APIRouter, Depends, HTTPException

from litellm.pii.config import PiiSettings, build_service
from litellm.pii.service import EncodedBatch, PiiService, new_session_id
from litellm.pii.store.base import TokenScope
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
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.types.proxy.pii_endpoints import (
    PiiDecodeRequest,
    PiiDecodeResponse,
    PiiDetectRequest,
    PiiDetectResponse,
    PiiDetectResult,
    PiiEncodeRequest,
    PiiEncodeResponse,
    PiiIssuedTokenModel,
    PiiSpanModel,
)

PII_TAGS: Final[list[str]] = ["pii anonymization"]  # mutable-ok: FastAPI copies and mutates router tags
pii_router: Final = APIRouter(prefix="/pii", tags=PII_TAGS)


def _detail(message: str) -> dict[str, str]:  # mutable-ok: FastAPI builds HTTPException.detail from a plain dict
    return {"error": message}  # mutable-ok: FastAPI builds HTTPException.detail from a plain dict


DECODE_PERMISSION: Final = "allow_pii_decode"
EMPTY_PERMISSIONS: Final[Mapping[str, object]] = MappingProxyType({})


def get_pii_service() -> PiiService:
    """FastAPI dependency so tests inject a service instead of patching a module."""
    from litellm.proxy.proxy_server import user_api_key_cache

    service: Final = build_service(cache=user_api_key_cache, settings=PiiSettings.from_env())
    if service is None:
        raise HTTPException(
            status_code=501,
            detail=_detail(
                "PII anonymization is not configured. Set PRESIDIO_ANALYZER_API_BASE "
                "(and optionally LITELLM_PII_NER_API_BASE) to enable it."
            ),
        )
    return service


def _raise_public(error: DetectionError | CodecError | StoreError) -> None:
    """Map the internal error union onto the proxy's public HTTP contract."""
    match error:
        case DetectorUnavailable(detector=detector, reason=reason):
            raise HTTPException(
                status_code=503,
                detail=_detail(f"PII {detector.value} detector unavailable: {reason}"),
            )
        case DetectorInvalidResponse(detector=detector, reason=reason):
            raise HTTPException(
                status_code=502,
                detail=_detail(f"PII {detector.value} detector returned an invalid response: {reason}"),
            )
        case StoreUnavailable(reason=reason):
            raise HTTPException(status_code=503, detail=_detail(f"PII token store unavailable: {reason}"))
        case KeyUnavailable(reason=reason):
            raise HTTPException(status_code=500, detail=_detail(f"PII encryption key unavailable: {reason}"))
        case DecodeFailed(reason=reason):
            raise HTTPException(status_code=400, detail=_detail(f"PII token could not be decoded: {reason}"))
        case UnknownToken(token=token):
            raise HTTPException(status_code=404, detail=_detail(f"Unknown PII token: {token}"))
        case TokenSpaceExhausted(entity_type=entity_type):
            raise HTTPException(
                status_code=422,
                detail=_detail(f"No free PII token remained for {entity_type}"),
            )
        case _:
            assert_never(error)


def _scope_for(user_api_key_dict: UserAPIKeyAuth, session_id: str) -> TokenScope:
    return TokenScope.for_key(api_key=user_api_key_dict.api_key, session_id=session_id)


@pii_router.post("/detect", response_model=PiiDetectResponse)
async def detect_pii(
    request: PiiDetectRequest,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
    service: PiiService = Depends(get_pii_service),
) -> PiiDetectResponse:
    """Report what PII is present without altering the text."""
    detected: Final = await service.detect_many(
        texts=request.texts,
        language=request.language,
        entities=request.entities,
    )
    if not isinstance(detected, tuple):
        _raise_public(detected)

    return PiiDetectResponse(
        results=tuple(
            PiiDetectResult(
                spans=tuple(
                    PiiSpanModel(
                        entity_type=span.entity_type,
                        start=span.start,
                        end=span.end,
                        score=span.score,
                        detector=span.detector.value,
                    )
                    for span in result.spans
                ),
                ner_stage_ran=result.ner_stage_ran,
            )
            for result in detected
        )
    )


@pii_router.post("/encode", response_model=PiiEncodeResponse)
async def encode_pii(
    request: PiiEncodeRequest,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
    service: PiiService = Depends(get_pii_service),
) -> PiiEncodeResponse:
    """Replace detected PII with tokens and persist the mapping for later decode."""
    session_id: Final = request.session_id or new_session_id()
    encoded: Final = await service.encode(
        texts=request.texts,
        scope=_scope_for(user_api_key_dict, session_id),
        language=request.language,
        entities=request.entities,
    )
    if not isinstance(encoded, EncodedBatch):
        _raise_public(encoded)

    return PiiEncodeResponse(
        texts=encoded.texts,
        session_id=encoded.session_id,
        tokens=tuple(
            PiiIssuedTokenModel(token=token.token, entity_type=token.entity_type, codec_id=token.codec_id)
            for token in encoded.tokens
        ),
    )


@pii_router.post("/decode", response_model=PiiDecodeResponse)
async def decode_pii(
    request: PiiDecodeRequest,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
    service: PiiService = Depends(get_pii_service),
) -> PiiDecodeResponse:
    """Restore original values for tokens this key issued.

    Gated on the ``allow_pii_decode`` key permission: decode hands back real PII,
    so it is opt-in per key rather than implied by the ability to call the proxy.
    """
    permissions: Final = user_api_key_dict.permissions or EMPTY_PERMISSIONS
    if not permissions.get(DECODE_PERMISSION, False):
        raise HTTPException(
            status_code=403,
            detail=_detail(f"This key is not permitted to decode PII. Set permissions.{DECODE_PERMISSION} = true."),
        )

    decoded: Final = await service.decode(
        texts=request.texts,
        scope=_scope_for(user_api_key_dict, request.session_id),
    )
    if not isinstance(decoded, tuple):
        _raise_public(decoded)

    return PiiDecodeResponse(texts=decoded)
