from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import reduce
from types import MappingProxyType
from typing import Final

from litellm.pii.codec.base import PiiCodec
from litellm.pii.types import CodecError, IssuedToken, PiiSpan


@dataclass(frozen=True, slots=True)
class BatchDraft:
    texts: tuple[str, ...]
    tokens: tuple[IssuedToken, ...]
    mapping: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class EncodedDraft:
    text: str
    tokens: tuple[IssuedToken, ...]
    mapping: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class _Placement:
    text_index: int
    span: PiiSpan
    token: str


@dataclass(frozen=True, slots=True)
class _Assignment:
    by_value: Mapping[tuple[str, str], str]
    ordinals: Mapping[str, int]
    placements: tuple[_Placement, ...]
    error: CodecError | None


def _assign(
    state: _Assignment,
    located: tuple[int, PiiSpan],
    texts: Sequence[str],
    codec: PiiCodec,
) -> _Assignment:
    if state.error is not None:
        return state

    text_index, span = located
    value: Final = span.text_from(texts[text_index])
    identity: Final = (span.entity_type, value)
    existing: Final = state.by_value.get(identity)
    if existing is not None:
        return replace(state, placements=(*state.placements, _Placement(text_index, span, existing)))

    ordinal: Final = state.ordinals.get(span.entity_type, 0) + 1
    minted: Final = codec.mint(span.entity_type, ordinal, value)
    if not isinstance(minted, str):
        return replace(state, error=minted)

    return _Assignment(
        by_value=MappingProxyType({**state.by_value, identity: minted}),
        ordinals=MappingProxyType({**state.ordinals, span.entity_type: ordinal}),
        placements=(*state.placements, _Placement(text_index, span, minted)),
        error=None,
    )


def _splice(source: str, placements: Sequence[_Placement]) -> str:
    return reduce(
        lambda text, placement: text[: placement.span.start] + placement.token + text[placement.span.end :],
        sorted(placements, key=lambda placement: placement.span.start, reverse=True),
        source,
    )


def encode_batch(
    texts: Sequence[str],
    spans_by_text: Sequence[Sequence[PiiSpan]],
    codec: PiiCodec,
    is_reversible: Callable[[PiiSpan], bool] | None = None,
) -> BatchDraft | CodecError:
    """Encode several texts against one shared token space.

    All messages of a request are encoded together so the same person mentioned
    in message one and message three receives the same token. Encoding them
    separately would hand the model two placeholders for one entity and lose
    track of who is who.

    Repeated values share a token only within this call; nothing carries across
    calls, so identical inputs in two separate requests never collide.
    """
    located: Final = tuple(
        (text_index, span)
        for text_index, spans in enumerate(spans_by_text)
        for span in sorted(spans, key=lambda span: span.start)
    )
    if not located:
        return BatchDraft(texts=tuple(texts), tokens=(), mapping=MappingProxyType({}))

    assigned: Final = reduce(
        lambda state, item: _assign(state, item, texts, codec),
        located,
        _Assignment(by_value=MappingProxyType({}), ordinals=MappingProxyType({}), placements=(), error=None),
    )
    if assigned.error is not None:
        return assigned.error

    encoded: Final = tuple(
        _splice(text, tuple(p for p in assigned.placements if p.text_index == text_index))
        for text_index, text in enumerate(texts)
    )
    tokens: Final = tuple(
        IssuedToken(token=p.token, entity_type=p.span.entity_type, codec_id=codec.codec_id) for p in assigned.placements
    )
    reversible: Final = is_reversible or (lambda span: True)
    mapping: Final = MappingProxyType(
        {p.token: p.span.text_from(texts[p.text_index]) for p in assigned.placements if reversible(p.span)}
    )
    return BatchDraft(texts=encoded, tokens=tokens, mapping=mapping)


def encode_text(text: str, spans: Sequence[PiiSpan], codec: PiiCodec) -> EncodedDraft | CodecError:
    batch: Final = encode_batch((text,), (spans,), codec)
    if not isinstance(batch, BatchDraft):
        return batch
    return EncodedDraft(text=batch.texts[0], tokens=batch.tokens, mapping=batch.mapping)


def decode_text(text: str, resolved: Mapping[str, str]) -> str:
    """Substitute every token whose original value was recovered.

    Tokens absent from ``resolved`` are left verbatim rather than blanked, so a
    partial store miss degrades to showing the token instead of losing content.
    """
    if not resolved:
        return text
    return reduce(lambda acc, item: acc.replace(item[0], item[1]), resolved.items(), text)
