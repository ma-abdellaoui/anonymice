import secrets
from dataclasses import dataclass, field
from typing import ClassVar, Final

from litellm.pii.codec.grammar import AngleBracketGrammar, TokenGrammar, TokenKind
from litellm.pii.types import CodecError

HANDLE_BYTES: Final = 8


@dataclass(frozen=True, slots=True)
class HandleCodec:
    """Random opaque handles: ``<PERSON:3f9c2e1b8d4a7f60>``.

    Default on the endpoint path. The handle carries no information about the
    value, so identical inputs never produce identical tokens and nothing leaks
    by comparison. Reversal requires the token store, which makes tokens
    revocable: delete the entry and the token is permanently dead.
    """

    grammar: TokenGrammar = field(default_factory=AngleBracketGrammar)
    codec_id: ClassVar[str] = "handle"

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError:
        return self.grammar.mint(entity_type, TokenKind.HANDLE, secrets.token_hex(HANDLE_BYTES))

    def recover(self, token: str) -> str | CodecError | None:
        return None
