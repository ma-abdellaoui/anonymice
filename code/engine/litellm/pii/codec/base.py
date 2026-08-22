import re
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from litellm.pii.types import CodecError

TOKEN_PATTERN: Final = re.compile(r"<[A-Z][A-Z0-9_]*(?:_\d+|:[A-Za-z0-9._\-]+)>")


@dataclass(frozen=True, slots=True)
class FoundToken:
    token: str
    start: int
    end: int


def find_tokens(text: str) -> tuple[FoundToken, ...]:
    return tuple(
        FoundToken(token=match.group(0), start=match.start(), end=match.end()) for match in TOKEN_PATTERN.finditer(text)
    )


@runtime_checkable
class PiiCodec(Protocol):
    """Mints a token for a detected value and, where possible, recovers it.

    ``recover`` returning ``None`` means the codec cannot reverse the token on
    its own and the caller must consult the token store. Only self-contained
    codecs, which carry their ciphertext inside the token, return a value.
    """

    codec_id: str

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError: ...

    def recover(self, token: str) -> str | CodecError | None: ...
