from typing import Protocol, runtime_checkable

from litellm.pii.codec.grammar import TokenGrammar
from litellm.pii.types import CodecError


@runtime_checkable
class PiiCodec(Protocol):
    """Mints a token for a detected value and, where possible, recovers it.

    ``recover`` returning ``None`` means the codec cannot reverse the token on
    its own and the caller must consult the token store. Only self-contained
    codecs, which carry their ciphertext inside the token, return a value.
    """

    codec_id: str
    grammar: TokenGrammar

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError: ...

    def recover(self, token: str) -> str | CodecError | None: ...
