import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from litellm.pii.types import StoreError

SESSION_NAMESPACE_ANONYMOUS: Final = "anonymous"


@dataclass(frozen=True, slots=True)
class TokenScope:
    """Isolation boundary for stored tokens.

    ``namespace`` is derived from the calling API key, so possessing a valid
    ``session_id`` alone never grants access to another key's tokens.
    """

    namespace: str
    session_id: str

    @classmethod
    def for_key(cls, api_key: str | None, session_id: str) -> "TokenScope":
        namespace: Final = hashlib.sha256(api_key.encode()).hexdigest()[:32] if api_key else SESSION_NAMESPACE_ANONYMOUS
        return cls(namespace=namespace, session_id=session_id)

    def cache_key(self, token: str) -> str:
        return f"pii:{self.namespace}:{self.session_id}:{token}"


@runtime_checkable
class PiiTokenStore(Protocol):
    async def put_many(self, scope: TokenScope, entries: Mapping[str, str]) -> None | StoreError: ...

    async def get(self, scope: TokenScope, token: str) -> str | None | StoreError: ...
