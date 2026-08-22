from dataclasses import dataclass, field
from typing import ClassVar

from litellm.pii.codec.grammar import AngleBracketGrammar, TokenGrammar, TokenKind
from litellm.pii.types import CodecError


@dataclass(frozen=True, slots=True)
class PlaceholderCodec:
    """Typed, sequentially numbered placeholders: ``<PERSON_1>``.

    Default on the LLM path. Short and self-describing, so the model still
    understands the sentence structure it is reading, which opaque ciphertext
    tokens destroy. Reversal always requires the token store.
    """

    grammar: TokenGrammar = field(default_factory=AngleBracketGrammar)
    codec_id: ClassVar[str] = "placeholder"

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError:
        return self.grammar.mint(entity_type, TokenKind.ORDINAL, str(ordinal))

    def recover(self, token: str) -> str | CodecError | None:
        return None
