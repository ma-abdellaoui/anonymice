import pytest

from litellm.pii.codec.handle import HandleCodec
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import PiiService
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.vault.config import (
    ENV_DEFAULT_SCOPE,
    ENV_KEY_VERSION,
    ENV_RETENTION_DAYS,
    ENV_VAULT_ENABLED,
    VaultSettings,
    build_vault,
    build_vault_store,
)
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.service import VaultService
from litellm.pii.vault.store import DEFAULT_RETENTION_DAYS

from .test_store import FakeTable

ENABLED = VaultSettings(enabled=True)


class FakeDb:
    def __init__(self, table):
        self.litellm_piitokentable = table


class FakePrisma:
    def __init__(self):
        self.db = FakeDb(FakeTable())


def a_service():
    return PiiService(
        detector=CascadingDetector(rules=None, ner=None, policy=NerStagePolicy.NEVER),
        codec=HandleCodec(),
        store=DualCacheStore(cache=None),
    )


class TestSettingsFromEnv:
    def test_the_vault_is_off_unless_it_is_turned_on(self, monkeypatch):
        monkeypatch.delenv(ENV_VAULT_ENABLED, raising=False)
        assert VaultSettings.from_env().enabled is False

    @pytest.mark.parametrize("raw", ["true", "TRUE", "1", "yes", "on", " true "])
    def test_the_usual_truthy_spellings_all_enable_it(self, monkeypatch, raw):
        monkeypatch.setenv(ENV_VAULT_ENABLED, raw)
        assert VaultSettings.from_env().enabled is True

    @pytest.mark.parametrize("raw", ["false", "0", "no", "maybe", ""])
    def test_anything_else_leaves_it_off(self, monkeypatch, raw):
        monkeypatch.setenv(ENV_VAULT_ENABLED, raw)
        assert VaultSettings.from_env().enabled is False

    def test_retention_is_read_from_the_environment(self, monkeypatch):
        monkeypatch.setenv(ENV_RETENTION_DAYS, "7")
        assert VaultSettings.from_env().retention_days == 7

    def test_an_unparseable_retention_falls_back_rather_than_crashing_startup(self, monkeypatch):
        monkeypatch.setenv(ENV_RETENTION_DAYS, "a fortnight")
        assert VaultSettings.from_env().retention_days == DEFAULT_RETENTION_DAYS

    def test_the_key_version_is_read_from_the_environment(self, monkeypatch):
        monkeypatch.setenv(ENV_KEY_VERSION, "3")
        assert VaultSettings.from_env().key_version == 3

    def test_minting_defaults_to_the_most_restrictive_scope(self, monkeypatch):
        monkeypatch.delenv(ENV_DEFAULT_SCOPE, raising=False)
        assert VaultSettings.from_env().default_scope is VaultScopeType.KEY

    def test_a_wider_default_scope_can_be_configured(self, monkeypatch):
        monkeypatch.setenv(ENV_DEFAULT_SCOPE, "team")
        assert VaultSettings.from_env().default_scope is VaultScopeType.TEAM

    def test_an_unknown_scope_name_falls_back_to_the_most_restrictive(self, monkeypatch):
        monkeypatch.setenv(ENV_DEFAULT_SCOPE, "everyone")
        assert VaultSettings.from_env().default_scope is VaultScopeType.KEY


class TestBuild:
    def test_no_store_without_a_database(self):
        assert build_vault_store(prisma_client=None, settings=ENABLED, secret="s") is None

    def test_no_store_while_the_vault_is_disabled(self):
        assert build_vault_store(FakePrisma(), settings=VaultSettings(enabled=False), secret="s") is None

    def test_a_configured_deployment_gets_a_store(self):
        assert build_vault_store(FakePrisma(), settings=ENABLED, secret="s") is not None

    def test_retention_reaches_the_store(self):
        store = build_vault_store(FakePrisma(), settings=VaultSettings(enabled=True, retention_days=3), secret="s")
        assert store.retention_days == 3

    @pytest.mark.asyncio
    async def test_the_configured_key_version_is_what_new_writes_use(self):
        store = build_vault_store(FakePrisma(), settings=VaultSettings(enabled=True, key_version=4), secret="s")
        sealed = await store.cipher.seal("Ada", "tok", VaultScope(VaultScopeType.KEY, "k"))
        assert sealed.key_version == 4

    def test_build_vault_carries_the_service_through(self):
        service = a_service()
        vault = build_vault(FakePrisma(), pii=service, settings=ENABLED, secret="s")
        assert isinstance(vault, VaultService)
        assert vault.pii is service

    def test_build_vault_is_none_when_the_store_is(self):
        assert build_vault(None, pii=a_service(), settings=ENABLED, secret="s") is None
