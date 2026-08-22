import pytest

from litellm.pii.types import KeyUnavailable
from litellm.pii.vault.keys import (
    KEY_BYTES,
    DerivedKeyProvider,
    SecretManagerKeyProvider,
    derive_key,
)
from litellm.pii.vault.scope import VaultScope, VaultScopeType

KEY_SCOPE = VaultScope(scope_type=VaultScopeType.KEY, scope_id="hashed-key-a")
OTHER_KEY_SCOPE = VaultScope(scope_type=VaultScopeType.KEY, scope_id="hashed-key-b")
TEAM_SCOPE = VaultScope(scope_type=VaultScopeType.TEAM, scope_id="hashed-key-a")


class FakeSecretReader:
    def __init__(self, secrets=None, error=None):
        self.secrets = secrets or {}
        self.error = error
        self.reads = []

    async def async_read_secret(self, secret_name):
        self.reads.append(secret_name)
        if self.error is not None:
            raise self.error
        return self.secrets.get(secret_name)


class TestDeriveKey:
    def test_it_produces_a_full_length_aes_256_key(self):
        assert len(derive_key("secret", "key", "a", 1)) == KEY_BYTES

    def test_it_is_deterministic(self):
        assert derive_key("secret", "key", "a", 1) == derive_key("secret", "key", "a", 1)

    def test_a_different_scope_id_yields_an_unrelated_key(self):
        assert derive_key("secret", "key", "a", 1) != derive_key("secret", "key", "b", 1)

    def test_a_different_scope_type_yields_an_unrelated_key(self):
        assert derive_key("secret", "key", "a", 1) != derive_key("secret", "team", "a", 1)

    def test_a_different_version_yields_an_unrelated_key(self):
        assert derive_key("secret", "key", "a", 1) != derive_key("secret", "key", "a", 2)

    def test_a_different_root_secret_yields_an_unrelated_key(self):
        assert derive_key("secret-a", "key", "a", 1) != derive_key("secret-b", "key", "a", 1)

    def test_the_scope_fields_cannot_be_confused_by_concatenation(self):
        assert derive_key("s", "key", "a:1", 1) != derive_key("s", "key", "a", 11)

    def test_the_derived_key_is_not_the_raw_secret(self):
        assert derive_key("secret", "key", "a", 1) != b"secret".ljust(KEY_BYTES, b"\x00")


class TestDerivedKeyProvider:
    @pytest.mark.asyncio
    async def test_it_returns_a_key_for_a_scope(self):
        assert await DerivedKeyProvider(secret="s").key_for(KEY_SCOPE, 1) == derive_key("s", "key", "hashed-key-a", 1)

    @pytest.mark.asyncio
    async def test_two_scopes_never_share_a_key(self):
        provider = DerivedKeyProvider(secret="s")
        assert await provider.key_for(KEY_SCOPE, 1) != await provider.key_for(OTHER_KEY_SCOPE, 1)

    @pytest.mark.asyncio
    async def test_the_same_id_under_a_different_scope_type_is_a_different_key(self):
        provider = DerivedKeyProvider(secret="s")
        assert await provider.key_for(KEY_SCOPE, 1) != await provider.key_for(TEAM_SCOPE, 1)

    @pytest.mark.asyncio
    async def test_an_unconfigured_secret_is_reported_rather_than_silently_weak(self):
        assert isinstance(await DerivedKeyProvider(secret="").key_for(KEY_SCOPE, 1), KeyUnavailable)

    def test_the_current_version_defaults_to_one(self):
        assert DerivedKeyProvider(secret="s").current_version() == 1

    def test_the_current_version_is_configurable_for_rotation(self):
        assert DerivedKeyProvider(secret="s", version=7).current_version() == 7

    @pytest.mark.asyncio
    async def test_an_old_version_still_derives_after_the_current_one_moves(self):
        rotated = DerivedKeyProvider(secret="s", version=2)
        assert await rotated.key_for(KEY_SCOPE, 1) == await DerivedKeyProvider(secret="s").key_for(KEY_SCOPE, 1)


class TestSecretManagerKeyProvider:
    def test_the_secret_name_carries_the_scope_and_version(self):
        provider = SecretManagerKeyProvider(reader=FakeSecretReader())
        assert provider.secret_name(KEY_SCOPE, 3) == "litellm-pii/key/hashed-key-a/v3"

    def test_the_name_prefix_is_configurable(self):
        provider = SecretManagerKeyProvider(reader=FakeSecretReader(), name_prefix="acme")
        assert provider.secret_name(KEY_SCOPE, 1).startswith("acme/")

    @pytest.mark.asyncio
    async def test_it_reads_the_scoped_secret(self):
        reader = FakeSecretReader({"litellm-pii/key/hashed-key-a/v1": "from-vault"})
        key = await SecretManagerKeyProvider(reader=reader).key_for(KEY_SCOPE, 1)
        assert key == derive_key("from-vault", "key", "hashed-key-a", 1)
        assert reader.reads == ["litellm-pii/key/hashed-key-a/v1"]

    @pytest.mark.asyncio
    async def test_the_fetched_secret_is_still_run_through_hkdf(self):
        reader = FakeSecretReader({"litellm-pii/key/hashed-key-a/v1": "short"})
        key = await SecretManagerKeyProvider(reader=reader).key_for(KEY_SCOPE, 1)
        assert len(key) == KEY_BYTES
        assert key != b"short"

    @pytest.mark.asyncio
    async def test_a_missing_secret_is_reported_rather_than_defaulted(self):
        result = await SecretManagerKeyProvider(reader=FakeSecretReader()).key_for(KEY_SCOPE, 1)
        assert isinstance(result, KeyUnavailable)

    @pytest.mark.asyncio
    async def test_a_secret_manager_outage_is_reported_not_swallowed(self):
        reader = FakeSecretReader(error=RuntimeError("vault down"))
        result = await SecretManagerKeyProvider(reader=reader).key_for(KEY_SCOPE, 1)
        assert isinstance(result, KeyUnavailable)
        assert "RuntimeError" in result.reason

    @pytest.mark.asyncio
    async def test_the_failure_reason_does_not_leak_the_secret_value(self):
        reader = FakeSecretReader({"litellm-pii/key/hashed-key-a/v1": "super-secret"})
        result = await SecretManagerKeyProvider(reader=reader).key_for(OTHER_KEY_SCOPE, 1)
        assert isinstance(result, KeyUnavailable)
        assert "super-secret" not in result.reason
