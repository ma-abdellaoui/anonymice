from collections.abc import Mapping, MutableMapping
from types import MappingProxyType
from typing import Final

from litellm.pii.store.base import TokenScope
from litellm.pii.types import StoreError


class RequestScopedStore:
    """Token map that lives and dies with one request.

    Backs the LLM path, where the mapping only needs to survive long enough to
    decode that call's response. The backing mapping is supplied by the caller
    (typically ``request_data["metadata"]["pii_tokens"]``) so the tokens travel
    with the request and are never persisted anywhere.
    """

    def __init__(self, backing: MutableMapping[str, str] | None = None) -> None:  # mutable-ok: a token store is
        # inherently mutable state, and the caller supplies the live request dict it must write through to.
        self._backing: Final[MutableMapping[str, str]] = backing if backing is not None else {}  # mutable-ok: see above

    async def put_many(self, scope: TokenScope, entries: Mapping[str, str]) -> None | StoreError:
        self._backing.update(entries)
        return None

    async def get(self, scope: TokenScope, token: str) -> str | None | StoreError:
        return self._backing.get(token)

    def snapshot(self) -> Mapping[str, str]:
        return MappingProxyType(dict(self._backing))  # mutable-ok: defensive copy before freezing
