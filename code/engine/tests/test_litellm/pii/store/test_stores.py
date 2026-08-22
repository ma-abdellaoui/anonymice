import pytest

from litellm.pii.store.base import TokenScope
from litellm.pii.store.cipher import AesGcmCipher, NullCipher, cipher_from_env
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.store.request_scoped import RequestScopedStore
from litellm.pii.types import KeyUnavailable, StoreUnavailable

SCOPE = TokenScope(namespace="ns", session_id="sess")
OTHER_SCOPE = TokenScope(namespace="other-ns", session_id="sess")


class FakeCache:
    def __init__(self):
        self.entries = {}
        self.ttls = {}
        self.fail = False

    async def async_set_cache(self, key, value, **kwargs):
        if self.fail:
            raise RuntimeError("redis down")
        self.entries[key] = value
        self.ttls[key] = kwargs.get("ttl")

    async def async_get_cache(self, key, **kwargs):
        if self.fail:
            raise RuntimeError("redis down")
        return self.entries.get(key)


class TestTokenScope:
    def test_same_key_yields_same_namespace(self):
        assert TokenScope.for_key("sk-abc", "s1").namespace == TokenScope.for_key("sk-abc", "s1").namespace

    def test_different_keys_yield_different_namespaces(self):
        assert TokenScope.for_key("sk-abc", "s1").namespace != TokenScope.for_key("sk-xyz", "s1").namespace

    def test_namespace_does_not_contain_the_raw_key(self):
        assert "sk-super-secret" not in TokenScope.for_key("sk-super-secret", "s1").namespace

    def test_missing_key_falls_back_to_anonymous(self):
        assert TokenScope.for_key(None, "s1").namespace == "anonymous"

    def test_cache_key_includes_namespace_session_and_token(self):
        assert TokenScope("ns", "sess").cache_key("<PERSON_1>") == "pii:ns:sess:<PERSON_1>"


class TestRequestScopedStore:
    @pytest.mark.asyncio
    async def test_round_trip(self):
        store = RequestScopedStore()
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert await store.get(SCOPE, "<PERSON_1>") == "Ada"

    @pytest.mark.asyncio
    async def test_missing_token_returns_none(self):
        assert await RequestScopedStore().get(SCOPE, "<PERSON_9>") is None

    @pytest.mark.asyncio
    async def test_writes_land_in_the_injected_backing_mapping(self):
        backing = {}
        await RequestScopedStore(backing).put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert backing == {"<PERSON_1>": "Ada"}

    @pytest.mark.asyncio
    async def test_preexisting_backing_entries_are_readable(self):
        store = RequestScopedStore({"<PERSON_1>": "Ada"})
        assert await store.get(SCOPE, "<PERSON_1>") == "Ada"

    @pytest.mark.asyncio
    async def test_put_many_merges_rather_than_replaces(self):
        backing = {"<PERSON_1>": "Ada"}
        await RequestScopedStore(backing).put_many(SCOPE, {"<EMAIL_ADDRESS_1>": "a@b.co"})
        assert backing == {"<PERSON_1>": "Ada", "<EMAIL_ADDRESS_1>": "a@b.co"}


class TestDualCacheStore:
    @pytest.mark.asyncio
    async def test_round_trip_through_the_cache(self):
        store = DualCacheStore(cache=FakeCache())
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert await store.get(SCOPE, "<PERSON_1>") == "Ada"

    @pytest.mark.asyncio
    async def test_another_namespace_cannot_read_the_token(self):
        cache = FakeCache()
        store = DualCacheStore(cache=cache)
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert await store.get(OTHER_SCOPE, "<PERSON_1>") is None

    @pytest.mark.asyncio
    async def test_another_session_cannot_read_the_token(self):
        cache = FakeCache()
        store = DualCacheStore(cache=cache)
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert await store.get(TokenScope("ns", "different-session"), "<PERSON_1>") is None

    @pytest.mark.asyncio
    async def test_ttl_is_applied_on_write(self):
        cache = FakeCache()
        await DualCacheStore(cache=cache, ttl_seconds=99).put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert set(cache.ttls.values()) == {99}

    @pytest.mark.asyncio
    async def test_values_are_encrypted_at_rest(self):
        cache = FakeCache()
        store = DualCacheStore(cache=cache, cipher=AesGcmCipher.from_secret("secret"))
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada Lovelace"})
        assert "Ada Lovelace" not in "".join(cache.entries.values())

    @pytest.mark.asyncio
    async def test_encrypted_values_still_round_trip(self):
        store = DualCacheStore(cache=FakeCache(), cipher=AesGcmCipher.from_secret("secret"))
        await store.put_many(SCOPE, {"<PERSON_1>": "Ada Lovelace"})
        assert await store.get(SCOPE, "<PERSON_1>") == "Ada Lovelace"

    @pytest.mark.asyncio
    async def test_reading_with_the_wrong_key_fails_rather_than_returning_garbage(self):
        cache = FakeCache()
        await DualCacheStore(cache=cache, cipher=AesGcmCipher.from_secret("key-a")).put_many(
            SCOPE, {"<PERSON_1>": "Ada"}
        )
        result = await DualCacheStore(cache=cache, cipher=AesGcmCipher.from_secret("key-b")).get(SCOPE, "<PERSON_1>")
        assert isinstance(result, StoreUnavailable)

    @pytest.mark.asyncio
    async def test_missing_token_returns_none(self):
        assert await DualCacheStore(cache=FakeCache()).get(SCOPE, "<PERSON_9>") is None

    @pytest.mark.asyncio
    async def test_cache_write_failure_is_reported_not_swallowed(self):
        cache = FakeCache()
        cache.fail = True
        result = await DualCacheStore(cache=cache).put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert isinstance(result, StoreUnavailable)

    @pytest.mark.asyncio
    async def test_cache_read_failure_is_reported_not_swallowed(self):
        cache = FakeCache()
        cache.fail = True
        result = await DualCacheStore(cache=cache).get(SCOPE, "<PERSON_1>")
        assert isinstance(result, StoreUnavailable)

    @pytest.mark.asyncio
    async def test_seal_failure_aborts_the_write(self):
        class FailingCipher:
            def seal(self, plaintext):
                return KeyUnavailable(reason="no key")

            def unseal(self, sealed):
                return sealed

        cache = FakeCache()
        result = await DualCacheStore(cache=cache, cipher=FailingCipher()).put_many(SCOPE, {"<PERSON_1>": "Ada"})
        assert isinstance(result, StoreUnavailable)
        assert cache.entries == {}


class TestCipher:
    def test_aes_gcm_round_trip(self):
        cipher = AesGcmCipher.from_secret("secret")
        assert cipher.unseal(cipher.seal("Ada Lovelace")) == "Ada Lovelace"

    def test_aes_gcm_is_randomized(self):
        cipher = AesGcmCipher.from_secret("secret")
        assert cipher.seal("Ada") != cipher.seal("Ada")

    def test_null_cipher_round_trip(self):
        assert NullCipher().unseal(NullCipher().seal("Ada")) == "Ada"

    def test_cipher_from_env_uses_aes_when_key_present(self, monkeypatch):
        monkeypatch.setenv("LITELLM_PII_ENCRYPTION_KEY", "s3cret")
        assert isinstance(cipher_from_env(), AesGcmCipher)

    def test_cipher_from_env_falls_back_to_null_without_key(self, monkeypatch):
        monkeypatch.delenv("LITELLM_PII_ENCRYPTION_KEY", raising=False)
        assert isinstance(cipher_from_env(), NullCipher)
