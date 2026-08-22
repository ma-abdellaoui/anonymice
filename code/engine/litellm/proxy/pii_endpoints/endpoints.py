"""Standalone PII detect / encode / decode endpoints.

These are adapters, not a second implementation: every route delegates to the
same :class:`~litellm.pii.service.PiiService` the anonymizer guardrail runs on
the LLM path. A browser extension calling ``/pii/encode`` therefore gets exactly
the behaviour an in-flight completion would.
"""

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Annotated, Final, NoReturn, Protocol, TypeAlias, assert_never

from fastapi import APIRouter, Depends, HTTPException

from litellm.pii.activity import (
    Applied,
    Failed,
    PiiDirection,
    PiiOutcome,
    PiiSurface,
    TextCapture,
    action_counts_of,
    activity_log,
    capture_enabled,
    capture_of,
    decode_tally,
    entity_counts_of,
    new_event,
)
from litellm.pii.codec.action_aware import SpanAction
from litellm.pii.config import CodecId, PiiSettings, build_codec, build_service
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
    SearchError,
    SearchRefused,
    StoreError,
    StoreUnavailable,
    TokenSpaceExhausted,
    UnknownToken,
    VaultForbidden,
)
from litellm.pii.vault.authorization import CallerIdentity, authorize_decode, scope_to_mint, used_break_glass
from litellm.pii.vault.config import build_search, build_vault
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.search import SearchResult, VaultSearch
from litellm.pii.vault.service import DecodedBatch, VaultService
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.pii_endpoints.audit import (
    default_mint_scope,
    identity_from,
    may_search,
    record_decode,
    record_search,
)
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
    PiiSearchHitModel,
    PiiSearchRequest,
    PiiSearchResponse,
    PiiSessionResponse,
    PiiSpanModel,
    PiiTokenMetadataModel,
)

MAPPING_EMPTY: Final[Mapping[str, int]] = MappingProxyType({})
PII_TAGS: Final[list[str]] = ["pii anonymization"]  # mutable-ok: FastAPI copies and mutates router tags
pii_router: Final = APIRouter(prefix="/pii", tags=PII_TAGS)


def _encode_action(entity_type: str) -> SpanAction:
    """The endpoint path has no per-entity action config: everything it touches is encoded."""
    return SpanAction.ENCODE


def _record(
    user_api_key_dict: UserAPIKeyAuth,
    direction: PiiDirection,
    outcome: PiiOutcome,
    started: float,
    entity_counts: Mapping[str, int] = MAPPING_EMPTY,
    action_counts: Mapping[str, int] = MAPPING_EMPTY,
    token_count: int = 0,
    resolved_count: int = 0,
    ner_stage_ran: bool = False,
    session_id: str | None = None,
    capture: TextCapture | None = None,
) -> None:
    activity_log().record(
        new_event(
            surface=PiiSurface.ENDPOINT,
            direction=direction,
            outcome=outcome,
            duration_ms=(time.monotonic() - started) * 1000,
            entity_counts=entity_counts,
            action_counts=action_counts,
            token_count=token_count,
            resolved_count=resolved_count,
            ner_stage_ran=ner_stage_ran,
            session_id=session_id,
            key_alias=user_api_key_dict.key_alias,
            user_id=user_api_key_dict.user_id,
            capture=capture,
        )
    )


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


class DecodeRecorder(Protocol):
    async def __call__(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        scope: VaultScope,
        token_count: int,
        break_glass: bool,
    ) -> None: ...


class SearchRecorder(Protocol):
    async def __call__(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        scope: VaultScope,
        entity_type: str | None,
        hit_count: int,
        scanned: int,
    ) -> None: ...


def get_decode_recorder() -> DecodeRecorder:
    """Injected so a test can observe what a vault read recorded."""
    return record_decode


def get_search_recorder() -> SearchRecorder:
    return record_search


def get_pii_vault(service: Annotated[PiiService, Depends(get_pii_service)]) -> VaultService | None:
    """``None`` when the vault is off or there is no database; encode and decode then use the cache store."""
    from litellm.proxy.proxy_server import prisma_client

    return build_vault(prisma_client=prisma_client, pii=service)


def get_pii_search() -> VaultSearch:
    from litellm.proxy.proxy_server import prisma_client

    searcher: Final = build_search(prisma_client=prisma_client)
    if searcher is None:
        raise HTTPException(
            status_code=501,
            detail=_detail(
                "The PII token vault is not configured. Set LITELLM_PII_VAULT_ENABLED=true and connect a database."
            ),
        )
    return searcher


def require_pii_vault(vault: Annotated[VaultService | None, Depends(get_pii_vault)]) -> VaultService:
    if vault is None:
        raise HTTPException(
            status_code=501,
            detail=_detail(
                "The PII token vault is not configured. Set LITELLM_PII_VAULT_ENABLED=true and connect a database."
            ),
        )
    return vault


PiiFailure: TypeAlias = DetectionError | CodecError | StoreError | AuthorizationError | SearchError


@dataclass(frozen=True, slots=True)
class _PublicFailure:
    status: int
    message: str


def _public_failure(error: PiiFailure) -> _PublicFailure:
    """Map the internal error union onto the proxy's public HTTP contract.

    One exhaustive match, so the status a caller sees and the reason the
    activity log records can never drift apart.
    """
    match error:
        case DetectorUnavailable(detector=detector, reason=reason):
            return _PublicFailure(503, f"PII {detector.value} detector unavailable: {reason}")
        case DetectorInvalidResponse(detector=detector, reason=reason):
            return _PublicFailure(502, f"PII {detector.value} detector returned an invalid response: {reason}")
        case StoreUnavailable(reason=reason):
            return _PublicFailure(503, f"PII token store unavailable: {reason}")
        case KeyUnavailable(reason=reason):
            return _PublicFailure(500, f"PII encryption key unavailable: {reason}")
        case DecodeFailed(reason=reason):
            return _PublicFailure(400, f"PII token could not be decoded: {reason}")
        case UnknownToken(token=token):
            return _PublicFailure(404, f"Unknown PII token: {token}")
        case TokenSpaceExhausted(entity_type=entity_type):
            return _PublicFailure(422, f"No free PII token remained for {entity_type}")
        case SearchRefused(scanned=scanned, limit=limit):
            return _PublicFailure(
                422,
                f"PII search would scan more than {limit} rows ({scanned} so far). "
                "Narrow it with entity_type or subject_id, or raise LITELLM_PII_SEARCH_CANDIDATE_CAP.",
            )
        case VaultForbidden(reason=reason):
            return _PublicFailure(403, f"Not permitted to access this PII scope: {reason}")
        case _:
            assert_never(error)


def _public_reason(error: PiiFailure) -> str:
    return _public_failure(error).message


def _raise_public(error: PiiFailure) -> NoReturn:
    failure: Final = _public_failure(error)
    raise HTTPException(status_code=failure.status, detail=_detail(failure.message))


def _with_codec(service: PiiService, codec: CodecId | None) -> PiiService:
    """The same service with a different token shape.

    The endpoint path mints handles so a token carries nothing about its value.
    A caller that asks for ``placeholder`` gets the short ordinal form the LLM
    path uses instead, which is what makes the two paths comparable side by
    side. Decode needs no counterpart: the grammar recognises both forms.
    """
    return service if codec is None else replace(service, codec=build_codec(codec))


def _record_encode(
    user_api_key_dict: UserAPIKeyAuth,
    encoded: EncodedBatch,
    texts: Sequence[str],
    started: float,
) -> None:
    _record(
        user_api_key_dict,
        PiiDirection.ENCODE,
        Applied(),
        started,
        entity_counts=entity_counts_of(encoded.spans_by_text),
        action_counts=action_counts_of(encoded.spans_by_text, _encode_action),
        token_count=len(encoded.tokens),
        ner_stage_ran=encoded.ner_stage_ran,
        session_id=encoded.session_id,
        capture=capture_of(texts, encoded.texts, encoded.placements, _encode_action),
    )


def _record_decode(
    user_api_key_dict: UserAPIKeyAuth,
    service: PiiService,
    before: Sequence[str],
    after: Sequence[str],
    session_id: str,
    started: float,
) -> None:
    tally: Final = decode_tally(service.codec.grammar, before, after)
    _record(
        user_api_key_dict,
        PiiDirection.DECODE,
        Applied(),
        started,
        entity_counts=tally.entity_counts,
        token_count=tally.token_count,
        resolved_count=tally.resolved_count,
        session_id=session_id,
        capture=TextCapture(before=tuple(before), after=tuple(after), placements=()) if capture_enabled() else None,
    )


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
    started: Final = time.monotonic()
    detected: Final = await service.detect_many(
        texts=request.texts,
        language=request.language,
        entities=request.entities,
    )
    if not isinstance(detected, tuple):
        _record(user_api_key_dict, PiiDirection.DETECT, Failed(reason=_public_reason(detected)), started)
        _raise_public(detected)

    spans_by_text: Final = tuple(result.spans for result in detected)
    _record(
        user_api_key_dict,
        PiiDirection.DETECT,
        Applied(),
        started,
        entity_counts=entity_counts_of(spans_by_text),
        ner_stage_ran=any(result.ner_stage_ran for result in detected),
    )
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
    started: Final = time.monotonic()
    session_id: Final = request.session_id or new_session_id()
    chosen: Final = _with_codec(service, request.codec)
    if vault is None:
        cached: Final = await chosen.encode(
            texts=request.texts,
            scope=_scope_for(user_api_key_dict, session_id),
            language=request.language,
            entities=request.entities,
        )
        if not isinstance(cached, EncodedBatch):
            _record(
                user_api_key_dict,
                PiiDirection.ENCODE,
                Failed(reason=_public_reason(cached)),
                started,
                session_id=session_id,
            )
            _raise_public(cached)
        _record_encode(user_api_key_dict, cached, request.texts, started)
        return _encode_response(cached)

    scope: Final = _requested_scope(identity_from(user_api_key_dict), request.scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    encoded: Final = await replace(vault, pii=chosen).encode(
        texts=request.texts,
        scope=scope,
        session_id=session_id,
        subject_id=request.subject_id or user_api_key_dict.end_user_id,
        created_by=user_api_key_dict.user_id,
        language=request.language,
        entities=request.entities,
    )
    if not isinstance(encoded, EncodedBatch):
        _record(
            user_api_key_dict,
            PiiDirection.ENCODE,
            Failed(reason=_public_reason(encoded)),
            started,
            session_id=session_id,
        )
        _raise_public(encoded)
    _record_encode(user_api_key_dict, encoded, request.texts, started)
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
    started: Final = time.monotonic()
    identity: Final = identity_from(user_api_key_dict)
    scope: Final = _authorized_scope(identity, request.scope_type, request.scope_id)

    if vault is None:
        decoded: Final = await service.decode(
            texts=request.texts,
            scope=_scope_for(user_api_key_dict, request.session_id),
        )
        if not isinstance(decoded, tuple):
            _record(
                user_api_key_dict,
                PiiDirection.DECODE,
                Failed(reason=_public_reason(decoded)),
                started,
                session_id=request.session_id,
            )
            _raise_public(decoded)
        _record_decode(user_api_key_dict, service, request.texts, decoded, request.session_id, started)
        return PiiDecodeResponse(texts=decoded)

    result: Final = await vault.decode(texts=request.texts, scope=scope)
    if not isinstance(result, DecodedBatch):
        _record(
            user_api_key_dict,
            PiiDirection.DECODE,
            Failed(reason=_public_reason(result)),
            started,
            session_id=request.session_id,
        )
        _raise_public(result)
    await record(user_api_key_dict, scope, result.resolved, used_break_glass(identity, scope))
    _record_decode(user_api_key_dict, vault.pii, request.texts, result.texts, request.session_id, started)
    return PiiDecodeResponse(texts=result.texts)


@pii_router.get("/session/{session_id}", response_model=PiiSessionResponse)
async def read_pii_session(
    session_id: str,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    vault: Annotated[VaultService, Depends(require_pii_vault)],
    scope_type: VaultScopeType | None = None,
) -> PiiSessionResponse:
    """What a session holds, without opening any of it.

    Metadata only, so this needs scope membership rather than the decode grant:
    seeing that a token exists and when it expires is a different question from
    seeing what it says.
    """
    scope: Final = _requested_scope(identity_from(user_api_key_dict), scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    rows: Final = await vault.session_tokens(scope, session_id)
    if not isinstance(rows, tuple):
        _raise_public(rows)

    return PiiSessionResponse(
        session_id=session_id,
        scope_type=scope.scope_type,
        tokens=tuple(
            PiiTokenMetadataModel(
                token=row.token_id,
                entity_type=row.entity_type,
                subject_id=row.subject_id,
                created_at=row.created_at,
                expires_at=row.expires_at,
            )
            for row in sorted(rows, key=lambda row: row.token_id)
        ),
    )


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


@pii_router.post("/search", response_model=PiiSearchResponse)
async def search_pii(
    request: PiiSearchRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
    searcher: Annotated[VaultSearch, Depends(get_pii_search)],
    record: Annotated[SearchRecorder, Depends(get_search_recorder)],
) -> PiiSearchResponse:
    """Find which tokens decode to a value.

    A strictly more powerful capability than resolving one known token, so it
    carries its own ``allow_pii_search`` permission rather than riding on
    ``allow_pii_decode``, is confined to the caller's scope, and is audited.
    """
    if not may_search(user_api_key_dict):
        raise HTTPException(
            status_code=403,
            detail=_detail("This key is not permitted to search PII. Set permissions.allow_pii_search = true."),
        )

    scope: Final = _requested_scope(identity_from(user_api_key_dict), request.scope_type)
    if isinstance(scope, VaultForbidden):
        _raise_public(scope)

    result: Final = await searcher.search(
        scope=scope,
        query=request.query,
        mode=request.mode,
        entity_type=request.entity_type,
        subject_id=request.subject_id,
    )
    if not isinstance(result, SearchResult):
        _raise_public(result)

    await record(user_api_key_dict, scope, request.entity_type, len(result.hits), result.scanned)
    return PiiSearchResponse(
        hits=tuple(
            PiiSearchHitModel(
                token=hit.token,
                entity_type=hit.entity_type,
                session_id=hit.session_id,
                subject_id=hit.subject_id,
            )
            for hit in result.hits
        ),
        scanned=result.scanned,
        scope_type=scope.scope_type,
    )
