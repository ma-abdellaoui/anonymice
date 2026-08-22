import base64
from dataclasses import dataclass, field
from typing import ClassVar, Final

from litellm.pii.codec.grammar import AngleBracketGrammar, TokenGrammar, TokenKind
from litellm.pii.store.cipher import ValueCipher
from litellm.pii.types import CodecError, DecodeFailed

ENCRYPTED_MARKER: Final = "e1."


def _strip_padding(encoded: str) -> str:
    return encoded.rstrip("=")


def _restore_padding(encoded: str) -> str:
    return encoded + "=" * (-len(encoded) % 4)


@dataclass(frozen=True, slots=True)
class EncryptedCodec:
    """Self-contained tokens: ``<PERSON:e1.{ciphertext}>``.

    The ciphertext travels inside the token, so decode needs no store at all.
    That statelessness is the whole point of this codec, and also its cost: the
    tokens are long and opaque, which is why it is not the default on either
    path. It exists as the seam for a bring-your-own encryption scheme.
    """

    cipher: ValueCipher
    grammar: TokenGrammar = field(default_factory=AngleBracketGrammar)
    codec_id: ClassVar[str] = "encrypted"

    def mint(self, entity_type: str, ordinal: int, value: str) -> str | CodecError:
        sealed: Final = self.cipher.seal(value)
        if not isinstance(sealed, str):
            return sealed
        packed: Final = _strip_padding(base64.urlsafe_b64encode(sealed.encode("utf-8")).decode("utf-8"))
        return self.grammar.mint(entity_type, TokenKind.HANDLE, f"{ENCRYPTED_MARKER}{packed}")

    def recover(self, token: str) -> str | CodecError | None:
        parsed: Final = self.grammar.parse(token)
        if parsed is None or parsed.kind is not TokenKind.HANDLE:
            return None
        if not parsed.discriminator.startswith(ENCRYPTED_MARKER):
            return None
        payload: Final = parsed.discriminator[len(ENCRYPTED_MARKER) :]
        try:
            sealed: Final = base64.urlsafe_b64decode(_restore_padding(payload)).decode("utf-8")
        except (ValueError, TypeError) as exc:
            return DecodeFailed(reason=f"malformed encrypted token ({type(exc).__name__})")
        return self.cipher.unseal(sealed)
