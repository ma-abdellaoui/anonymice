from dataclasses import dataclass
from enum import Enum
from typing import Final

from litellm.pii.store.base import TokenScope

REQUEST_SESSION_ID: Final = "request"


class MappingScope(str, Enum):
    REQUEST = "request"
    CONVERSATION = "conversation"


@dataclass(frozen=True, slots=True)
class ScopeResolver:
    """Turns a caller's identity into the boundary its tokens live inside.

    Request scope persists nothing and is the default: the proxy decodes before
    it returns, so the next turn simply re-encodes from the real values.
    Conversation scope keys on the session the proxy already resolves, buying
    prompt-cache stability and cross-turn coreference at the cost of holding the
    mapping in a shared cache for the conversation's life.

    A conversation-scoped request that carries no session id falls back to
    request scope rather than failing: an unidentified conversation is exactly
    one request as far as we can tell, and refusing it would break every client
    that does not send the header.
    """

    mapping_scope: MappingScope = MappingScope.REQUEST

    def resolve(self, api_key: str | None, session_id: str | None) -> TokenScope:
        if self.mapping_scope is MappingScope.CONVERSATION and session_id:
            return TokenScope.for_key(api_key, session_id)
        return TokenScope.for_key(api_key, REQUEST_SESSION_ID)

    def needs_shared_cache(self) -> bool:
        """Conversation scope spans requests, so two workers must read one store."""
        return self.mapping_scope is MappingScope.CONVERSATION
