import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Final, Protocol, runtime_checkable

from litellm.pii.store.base import TokenScope
from litellm.pii.store.cipher import NullCipher, ValueCipher
from litellm.pii.types import KeyUnavailable, StoreError, StoreUnavailable

DEFAULT_SESSION_TTL_SECONDS: Final = 60 * 60 * 24


@runtime_checkable
class AsyncKeyValueCache(Protocol):
    """Structural view of ``DualCache``, so tests inject a dict-backed fake."""

    async def async_set_cache(self, key: str, value: Any, **kwargs: Any) -> Any: ...  # kwargs-ok: mirrors DualCache

    async def async_batch_get_cache(self, keys: Sequence[str]) -> Sequence[object] | None: ...


@dataclass(frozen=True, slots=True)
class DualCacheStore:
    """Session-scoped token store for the endpoint path.

    Decode can arrive long after encode and from a different process, so the
    mapping is persisted with a TTL. Values are sealed before they are written:
    a compromised cache yields ciphertext, never PII.
    """

    cache: AsyncKeyValueCache
    cipher: ValueCipher = field(default_factory=NullCipher)
    ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS

    async def put_many(self, scope: TokenScope, entries: Mapping[str, str]) -> None | StoreError:
        sealed: Final = MappingProxyType({token: self.cipher.seal(value) for token, value in entries.items()})
        failures: Final = tuple(result for result in sealed.values() if isinstance(result, KeyUnavailable))
        if failures:
            return StoreUnavailable(reason=failures[0].reason)

        try:
            await asyncio.gather(
                *(
                    self.cache.async_set_cache(scope.cache_key(token), value, ttl=self.ttl_seconds)
                    for token, value in sealed.items()
                    if isinstance(value, str)
                )
            )
        except Exception as exc:
            return StoreUnavailable(reason=f"cache write failed ({type(exc).__name__})")
        return None

    async def get(self, scope: TokenScope, token: str) -> str | None | StoreError:
        found: Final = await self.get_many(scope, (token,))
        return found.get(token) if isinstance(found, Mapping) else found

    async def get_many(self, scope: TokenScope, tokens: Sequence[str]) -> Mapping[str, str] | StoreError:
        if not tokens:
            return MappingProxyType({})
        try:
            stored: Final = await self.cache.async_batch_get_cache(tuple(scope.cache_key(token) for token in tokens))
        except Exception as exc:
            return StoreUnavailable(reason=f"cache read failed ({type(exc).__name__})")
        if isinstance(stored, str) or not isinstance(stored, Sequence) or len(stored) != len(tokens):
            return StoreUnavailable(reason="cache returned a result that does not line up with the keys requested")

        mistyped: Final = next((value for value in stored if value is not None and not isinstance(value, str)), None)
        if mistyped is not None:
            return StoreUnavailable(reason=f"unexpected cached type {type(mistyped).__name__}")

        opened: Final = tuple(
            (token, self.cipher.unseal(value)) for token, value in zip(tokens, stored) if isinstance(value, str)
        )
        failure: Final = next((value for _, value in opened if not isinstance(value, str)), None)
        if failure is not None:
            return StoreUnavailable(reason=failure.reason)
        return MappingProxyType({token: value for token, value in opened if isinstance(value, str)})
