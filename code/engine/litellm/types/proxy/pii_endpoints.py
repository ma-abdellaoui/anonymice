from datetime import datetime

from pydantic import BaseModel, Field

from litellm.pii.config import CodecId
from litellm.pii.vault.scope import VaultScopeType
from litellm.pii.vault.search import MatchMode


class PiiPermissionsResponse(BaseModel):
    """What the calling key may do with the vault. Never the values themselves."""

    can_decode: bool
    can_decode_any: bool
    can_search: bool


class PiiSpanModel(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float
    detector: str


class PiiIssuedTokenModel(BaseModel):
    token: str
    entity_type: str
    codec_id: str


class PiiDetectRequest(BaseModel):
    texts: tuple[str, ...] = Field(min_length=1)
    language: str = "en"
    entities: tuple[str, ...] | None = None


class PiiDetectResult(BaseModel):
    spans: tuple[PiiSpanModel, ...]
    ner_stage_ran: bool


class PiiDetectResponse(BaseModel):
    results: tuple[PiiDetectResult, ...]


class PiiEncodeRequest(BaseModel):
    texts: tuple[str, ...] = Field(min_length=1)
    session_id: str | None = None
    language: str = "en"
    entities: tuple[str, ...] | None = None
    scope_type: VaultScopeType | None = None
    subject_id: str | None = Field(
        default=None,
        description="Opaque subject reference for erasure and export. Never an email address or a name.",
    )
    codec: CodecId | None = Field(
        default=None,
        description="Token shape to mint. Defaults to the handle form; 'placeholder' mints the ordinal form the LLM path uses.",
    )


class PiiPlacementModel(BaseModel):
    """Where a token went, in coordinates of the text the caller sent.

    Offsets index the caller's own input, so this discloses nothing they did not
    already have, and it saves them a second detect call to find out what moved.
    """

    text_index: int
    start: int
    end: int
    entity_type: str
    detector: str
    score: float
    token: str


class PiiEncodeResponse(BaseModel):
    texts: tuple[str, ...]
    session_id: str
    tokens: tuple[PiiIssuedTokenModel, ...]
    placements: tuple[PiiPlacementModel, ...] = ()
    ner_stage_ran: bool = False


class PiiDecodeRequest(BaseModel):
    texts: tuple[str, ...] = Field(min_length=1)
    session_id: str
    scope_type: VaultScopeType | None = None
    scope_id: str | None = Field(
        default=None,
        description="Read another scope's tokens. Requires allow_pii_decode_any, and every use is audited.",
    )


class PiiDecodeResponse(BaseModel):
    texts: tuple[str, ...]


class PiiRevokeResponse(BaseModel):
    revoked: bool
    scope_type: VaultScopeType


class PiiExportedValueModel(BaseModel):
    token: str
    value: str


class PiiExportResponse(BaseModel):
    subject_id: str
    scope_type: VaultScopeType
    values: tuple[PiiExportedValueModel, ...]


class PiiSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    mode: MatchMode = MatchMode.NORMALIZED
    entity_type: str | None = None
    subject_id: str | None = None
    scope_type: VaultScopeType | None = None


class PiiSearchHitModel(BaseModel):
    token: str
    entity_type: str
    session_id: str | None
    subject_id: str | None


class PiiSearchResponse(BaseModel):
    hits: tuple[PiiSearchHitModel, ...]
    scanned: int
    scope_type: VaultScopeType


class PiiTokenMetadataModel(BaseModel):
    """Everything but the value. No ciphertext, no plaintext, ever."""

    token: str
    entity_type: str
    subject_id: str | None
    created_at: datetime | None
    expires_at: datetime | None


class PiiSessionResponse(BaseModel):
    session_id: str
    scope_type: VaultScopeType
    tokens: tuple[PiiTokenMetadataModel, ...]
