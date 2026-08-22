from pydantic import BaseModel, Field


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


class PiiEncodeResponse(BaseModel):
    texts: tuple[str, ...]
    session_id: str
    tokens: tuple[PiiIssuedTokenModel, ...]


class PiiDecodeRequest(BaseModel):
    texts: tuple[str, ...] = Field(min_length=1)
    session_id: str


class PiiDecodeResponse(BaseModel):
    texts: tuple[str, ...]
