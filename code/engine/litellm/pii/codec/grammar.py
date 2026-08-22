import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Final, Protocol, runtime_checkable

from litellm.pii.entities import ENTITY_VOCABULARY


class TokenKind(str, Enum):
    ORDINAL = "ordinal"
    HANDLE = "handle"


@dataclass(frozen=True, slots=True)
class ParsedToken:
    entity_type: str
    kind: TokenKind
    discriminator: str


@dataclass(frozen=True, slots=True)
class FoundToken:
    """One token occurrence: ``text`` as it appeared, ``canonical`` as it was minted."""

    text: str
    canonical: str
    start: int
    end: int


@runtime_checkable
class TokenGrammar(Protocol):
    """The wire format, split out of the codecs so it lives in one place."""

    def mint(self, entity_type: str, kind: TokenKind, discriminator: str) -> str: ...

    def mint_masked(self, entity_type: str) -> str: ...

    def parse(self, token: str) -> ParsedToken | None: ...

    def find(self, text: str) -> tuple[FoundToken, ...]: ...

    def substitute(self, text: str, replacement: Callable[[FoundToken], str]) -> str: ...

    def canonical_tokens(self, texts: Sequence[str]) -> frozenset[str]: ...

    def holdback_chars(self, text: str) -> int: ...


MAX_DISCRIMINATOR_LENGTH: Final = 64
MAX_TOKEN_LENGTH: Final = len("<_>") + max(len(label) for label in ENTITY_VOCABULARY) + MAX_DISCRIMINATOR_LENGTH

_LABEL: Final = "|".join(sorted(ENTITY_VOCABULARY, key=len, reverse=True))
_SLASH: Final = r"\\?"
_HANDLE_CHARS: Final = r"[A-Za-z0-9._\-]+"

_STRICT_PATTERN: Final = re.compile(rf"\A<(?P<label>{_LABEL})(?:_(?P<ordinal>\d+)|:(?P<handle>{_HANDLE_CHARS}))>\Z")

_TOLERANT_PATTERN: Final = re.compile(
    rf"{_SLASH}<\s*(?P<label>{_LABEL})\s*"
    rf"(?:{_SLASH}_\s*(?P<ordinal>\d+)|:\s*(?P<handle>{_HANDLE_CHARS}))"
    rf"\s*{_SLASH}>",
    re.IGNORECASE,
)


def _canonical(label: str, ordinal: str | None, handle: str | None) -> str:
    """Case is normalised on the label only. A handle is data, and base64 is case-sensitive."""
    return f"<{label.upper()}_{ordinal}>" if ordinal is not None else f"<{label.upper()}:{handle}>"


def _found(matched: re.Match[str]) -> FoundToken:
    return FoundToken(
        text=matched.group(0),
        canonical=_canonical(matched.group("label"), matched.group("ordinal"), matched.group("handle")),
        start=matched.start(),
        end=matched.end(),
    )


@dataclass(frozen=True, slots=True)
class AngleBracketGrammar:
    """``<PERSON_1>`` and ``<PERSON:3f9c2e1b8d4a7f60>``, recognised tolerantly.

    Robustness lives here rather than in the token: nothing is spent on the wire,
    and distortion a model introduces (case, spacing, markdown escaping) is
    absorbed at match time. Matching is anchored to the closed entity vocabulary
    so ordinary prose containing ``<LIKE_THIS>`` is not mistaken for a token.

    A truncated token is never prefix-matched to a full one. Guessing which
    token ``<PERSON_`` was going to be emits the wrong person's name, which is a
    worse failure than showing the fragment.
    """

    def mint(self, entity_type: str, kind: TokenKind, discriminator: str) -> str:
        match kind:
            case TokenKind.ORDINAL:
                return f"<{entity_type}_{discriminator}>"
            case TokenKind.HANDLE:
                return f"<{entity_type}:{discriminator}>"

    def mint_masked(self, entity_type: str) -> str:
        """``<PERSON>``, which ``find`` deliberately does not match, so masking cannot be reversed."""
        return f"<{entity_type}>"

    def parse(self, token: str) -> ParsedToken | None:
        matched: Final = _STRICT_PATTERN.match(token)
        if matched is None:
            return None
        ordinal: Final = matched.group("ordinal")
        return ParsedToken(
            entity_type=matched.group("label"),
            kind=TokenKind.ORDINAL if ordinal is not None else TokenKind.HANDLE,
            discriminator=ordinal if ordinal is not None else matched.group("handle"),
        )

    def find(self, text: str) -> tuple[FoundToken, ...]:
        return tuple(_found(matched) for matched in _TOLERANT_PATTERN.finditer(text))

    def substitute(self, text: str, replacement: Callable[[FoundToken], str]) -> str:
        """One pass over every occurrence, so a value the callback returns is never rescanned."""
        return _TOLERANT_PATTERN.sub(lambda matched: replacement(_found(matched)), text)

    def canonical_tokens(self, texts: Sequence[str]) -> frozenset[str]:
        """Every token these texts already contain, in minted form.

        Encode treats this as the set it must not mint into; decode treats it as
        the set it must resolve. Both are the same question, so both ask it here.
        """
        return frozenset(found.canonical for text in texts for found in self.find(text))

    def holdback_chars(self, text: str) -> int:
        """Trailing characters that could still grow into a token, so streaming holds them.

        The framework cannot retract bytes it has already emitted, so a token
        split across chunk boundaries must be withheld until it closes. Anything
        before the last unclosed ``<`` is settled and safe to send.

        The cap bounds how long an ordinary ``a < b`` stalls the stream. A
        self-contained encrypted token can exceed it, which is one more reason
        that codec is not the default on the LLM path.
        """
        opening: Final = text.rfind("<")
        if opening < 0 or ">" in text[opening:]:
            return 0
        escaped: Final = opening - 1 if opening > 0 and text[opening - 1] == "\\" else opening
        pending: Final = len(text) - escaped
        return pending if pending <= MAX_TOKEN_LENGTH else 0
