from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Final

from litellm.pii.codec.base import PiiCodec
from litellm.pii.codec.grammar import TokenGrammar
from litellm.pii.types import CodecError, PiiSpan


class SpanAction(str, Enum):
    BLOCK = "BLOCK"
    MASK = "MASK"
    ENCODE = "ENCODE"


@dataclass(frozen=True, slots=True)
class ActionAwareCodec:
    """Routes each entity to its configured action within a single splice pass.

    Masked entities get a bare ``<PERSON>`` with no ordinal or handle, which the
    token pattern deliberately does not match. That makes masking irreversible
    by construction rather than by remembering not to store the mapping.
    """

    inner: PiiCodec
    actions: Mapping[str, SpanAction]
    default_action: SpanAction = SpanAction.ENCODE

    @property
    def codec_id(self) -> str:
        return self.inner.codec_id

    @property
    def grammar(self) -> TokenGrammar:
        return self.inner.grammar

    def action_for(self, entity_type: str) -> SpanAction:
        return self.actions.get(entity_type, self.default_action)

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError:
        if self.action_for(entity_type) is SpanAction.MASK:
            return self.grammar.mint_masked(entity_type)
        return self.inner.mint(entity_type, ordinal, value)

    def recover(self, token: str) -> str | CodecError | None:
        return self.inner.recover(token)

    def is_reversible(self, span: PiiSpan) -> bool:
        return self.action_for(span.entity_type) is not SpanAction.MASK


def blocked_entities(spans: tuple[PiiSpan, ...], actions: Mapping[str, SpanAction]) -> tuple[str, ...]:
    blocked: Final = tuple(span.entity_type for span in spans if actions.get(span.entity_type) is SpanAction.BLOCK)
    return tuple(dict.fromkeys(blocked))
