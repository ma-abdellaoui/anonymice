"""Standalone PII detect / encode / decode endpoints.

These are adapters, not a second implementation: every route delegates to the
same :class:`~litellm.pii.service.PiiService` the anonymizer guardrail runs on
the LLM path. A browser extension calling ``/pii/encode`` therefore gets exactly
the behaviour an in-flight completion would.
"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Annotated, Final, NoReturn, TypeAlias, assert_never

from fastapi import APIRouter, Depends, HTTPException

from litellm.pii.config import PiiSettings, build_service
from litellm.pii.service import EncodedBatch, PiiService, new_session_id
from litellm.pii.store.base import TokenScope
from litellm.pii.types import (
    AuthorizationError,
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
    VaultForbidden,
)
from litellm.pii.vault.authorization import CallerIdentity, authorize_decode, scope_to_mint, used_break_glass
from litellm.pii.vault.config import build_vault
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.service import DecodedBatch, VaultService
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.pii_endpoints.audit import default_mint_scope, identity_from, record_decode
from litellm.types.proxy.pii_endpoints import (
    PiiDecodeRequest,
    PiiDecodeResponse,
    PiiDetectRequest,
    PiiDetectResponse,
    PiiDetectResult,
    PiiEncodeRequest,
    PiiEncodeResponse,
    PiiExportedValueModel,
    PiiExportResponse,
    PiiIssuedTokenModel,
    PiiRevokeResponse,
    PiiSpanModel,
)

PII_TAGS: Final[list[str]] = ["pii anonymization"]  # mutable-ok: FastAPI copies and mutates router tags
pii_router: Final = APIRouter(prefix="/pii", tags=PII_TAGS)


def _detail(message: str) -> dict[str, str]:  # mutable-ok: FastAPI builds HTTPException.detail from a plain dict
    return {"error": message}  # mutable-ok: FastAPI builds HTTPException.detail from a plain dict


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


DecodeRecorder: TypeAlias = Callable[[UserAPIKeyAuth, VaultScope, int, bool], Awaitable[None]]


def get_decode_recorder() -> DecodeRecorder:
    """Injected so a test can observe what a vault read recorded."""
    return record_decode


def get_pii_vault(service: Annotated[PiiService, Depends(get_pii_service)]) -> VaultService | None:
    """``None`` when the vault is off or there is no database; encode and decode then use the cache store."""
    from litellm.proxy.proxy_server import prisma_client

    return build_vault(prisma_client=prisma_client, pii=service)


def require_pii_vault(vault: Annotated[VaultService | None, Depends(get_pii_vault)]) -> VaultService:
    if vault is None:
        raise HTTPException(
            status_code=501,
            detail=_detail(
                "The PII token vault is not configured. Set LITELLM_PII_VAULT_ENABLED=true and connect a database."
            ),
        )
    return vault


def _raise_public(error: DetectionError | CodecError | StoreError | AuthorizationError) -> NoReturn:
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
        case VaultForbidden(reason=reason):
            raise HTTPException(status_code=403, detail=_detail(f"Not permitted to access this PII scope: {reason}"))
        case _:
            assert_never(error)


def _scope_for(user_api_key_dict: UserAPIKeyAuth, session_id: str) -> TokenScope:
    return TokenScope.for_key(api_key=user_api_key_dict.api_key, session_id=session_id)


def _requested_scope(
    identity: CallerIdentity,
    scope_type: VaultScopeType | None,
    scope_id: str | None = None,
) -> VaultScope | VaultForbidden:
    """The caller's own scope unless one is named, which only break-glass can then read."""
    requested: Final = scope_type or default_mint_scope()
    if scope_id is not None:
        return VaultScope(scope_type=requested, scope_id=scope_id)
    return scope_to_mint(identity, requested)


def _encode_response(encoded: EncodedBatch) -> PiiEncodeResponse:
    return PiiEncodeResponse(
        texts=encoded.texts,
        session_id=encoded.session_id,
        tokens=tuple(
            PiiIssuedTokenModel(token=token.token, entity_type=token.entity_type, codec_id=token.codec_id)
            for token in encoded.tokens
        ),
    )


@pii_router.post("/detect", response_model=PiiDetectResponse)
async def detect_pii(
    request: PiiDetectRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    service: Annotated[PiiService, Depends(get_pii_service)],
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
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    service: Annotated[PiiService, Depends(get_pii_service)],
    vault: Annotated[VaultService | None, Depends(get_pii_vault)],
) -> PiiEncodeResponse:
    """Replace detected PII with tokens and persist the mapping for later decode."""
    session_id: Final = request.session_id or new_session_id()
    if vault is None:
        cached: Final = await service.encode(
            texts=request.texts,
            scope=_scope_for(user_api_key_dict, session_id),
            language=request.language,
            entities=request.entities,
        )
        if not isinstance(cached, EncodedBatch):
            _raise_public(cached)
        return _encode_response(cached)

    scope: Final = _requested_scope(identity_from(user_api_key_dict), request.scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    encoded: Final = await vault.encode(
        texts=request.texts,
        scope=scope,
        session_id=session_id,
        subject_id=request.subject_id or user_api_key_dict.end_user_id,
        created_by=user_api_key_dict.user_id,
        language=request.language,
        entities=request.entities,
    )
    if not isinstance(encoded, EncodedBatch):
        _raise_public(encoded)
    return _encode_response(encoded)


def _authorized_scope(
    identity: CallerIdentity,
    scope_type: VaultScopeType | None,
    scope_id: str | None = None,
) -> VaultScope:
    """The scope this caller may read, or a 403.

    ``allow_pii_decode`` is required either way: decode hands back real PII, so
    it is opt-in per key rather than implied by the ability to call the proxy.
    """
    scope: Final = _requested_scope(identity, scope_type, scope_id)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)
    forbidden: Final = authorize_decode(identity, scope)
    if forbidden is not None:
        _raise_public(forbidden)
    return scope


@pii_router.post("/decode", response_model=PiiDecodeResponse)
async def decode_pii(
    request: PiiDecodeRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    service: Annotated[PiiService, Depends(get_pii_service)],
    vault: Annotated[VaultService | None, Depends(get_pii_vault)],
    record: Annotated[DecodeRecorder, Depends(get_decode_recorder)],
) -> PiiDecodeResponse:
    """Restore original values for tokens this caller's scope owns."""
    identity: Final = identity_from(user_api_key_dict)
    scope: Final = _authorized_scope(identity, request.scope_type, request.scope_id)

    if vault is None:
        decoded: Final = await service.decode(
            texts=request.texts,
            scope=_scope_for(user_api_key_dict, request.session_id),
        )
        if not isinstance(decoded, tuple):
            _raise_public(decoded)
        return PiiDecodeResponse(texts=decoded)

    result: Final = await vault.decode(texts=request.texts, scope=scope)
    if not isinstance(result, DecodedBatch):
        _raise_public(result)
    await record(user_api_key_dict, scope, result.resolved, used_break_glass(identity, scope))
    return PiiDecodeResponse(texts=result.texts)


@pii_router.delete("/session/{session_id}", response_model=PiiRevokeResponse)
async def revoke_pii_session(
    session_id: str,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    vault: Annotated[VaultService, Depends(require_pii_vault)],
    scope_type: VaultScopeType | None = None,
) -> PiiRevokeResponse:
    """Erase every token one encode call minted. Membership in the scope is enough; reading it is not."""
    scope: Final = _requested_scope(identity_from(user_api_key_dict), scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    revoked: Final = await vault.revoke_session(scope, session_id)
    if revoked is not None:
        _raise_public(revoked)
    return PiiRevokeResponse(revoked=True, scope_type=scope.scope_type)


@pii_router.delete("/subject/{subject_id}", response_model=PiiRevokeResponse)
async def revoke_pii_subject(
    subject_id: str,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    vault: Annotated[VaultService, Depends(require_pii_vault)],
    scope_type: VaultScopeType | None = None,
) -> PiiRevokeResponse:
    """Erasure for one subject. Only finds what was tagged with a ``subject_id`` at encode time."""
    scope: Final = _requested_scope(identity_from(user_api_key_dict), scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    revoked: Final = await vault.revoke_subject(scope, subject_id)
    if revoked is not None:
        _raise_public(revoked)
    return PiiRevokeResponse(revoked=True, scope_type=scope.scope_type)


@pii_router.get("/subject/{subject_id}", response_model=PiiExportResponse)
async def export_pii_subject(
    subject_id: str,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    vault: Annotated[VaultService, Depends(require_pii_vault)],
    record: Annotated[DecodeRecorder, Depends(get_decode_recorder)],
    scope_type: VaultScopeType | None = None,
) -> PiiExportResponse:
    """Every value held for one subject. A bulk decode, so it needs the decode grant and is audited."""
    identity: Final = identity_from(user_api_key_dict)
    scope: Final = _authorized_scope(identity, scope_type)

    exported: Final = await vault.export_subject(scope, subject_id)
    if not isinstance(exported, Mapping):
        _raise_public(exported)

    await record(user_api_key_dict, scope, len(exported), used_break_glass(identity, scope))
    return PiiExportResponse(
        subject_id=subject_id,
        scope_type=scope.scope_type,
        values=tuple(PiiExportedValueModel(token=token, value=value) for token, value in sorted(exported.items())),
    )
