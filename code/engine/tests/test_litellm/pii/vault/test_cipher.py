import pytest

from litellm.pii.types import DecodeFailed, KeyUnavailable
from litellm.pii.vault.cipher import SealedValue, VaultCipher, aad_for
from litellm.pii.vault.keys import DerivedKeyProvider
from litellm.pii.vault.scope import VaultScope, VaultScopeType

KEY_SCOPE = VaultScope(scope_type=VaultScopeType.KEY, scope_id="hashed-key-a")
OTHER_KEY_SCOPE = VaultScope(scope_type=VaultScopeType.KEY, scope_id="hashed-key-b")
TEAM_SCOPE = VaultScope(scope_type=VaultScopeType.TEAM, scope_id="hashed-key-a")

CIPHER = VaultCipher(keys=DerivedKeyProvider(secret="root-secret"))


class TestAad:
    def test_it_binds_every_part_of_the_row_identity(self):
        aad = aad_for("tok-1", KEY_SCOPE, 1)
        for part in (b"tok-1", b"key", b"hashed-key-a", b"1"):
            assert part in aad

    def test_the_parts_cannot_be_confused_by_concatenation(self):
        assert aad_for("a", VaultScope(VaultScopeType.KEY, "b"), 1) != aad_for(
            "a\x00key", VaultScope(VaultScopeType.KEY, "b"), 1
        )

    def test_a_different_token_id_gives_different_aad(self):
        assert aad_for("tok-1", KEY_SCOPE, 1) != aad_for("tok-2", KEY_SCOPE, 1)


class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_a_sealed_value_comes_back(self):
        sealed = await CIPHER.seal("Ada Lovelace", "tok-1", KEY_SCOPE)
        assert await CIPHER.unseal(sealed, "tok-1", KEY_SCOPE) == "Ada Lovelace"

    @pytest.mark.asyncio
    async def test_the_ciphertext_never_contains_the_plaintext(self):
        sealed = await CIPHER.seal("Ada Lovelace", "tok-1", KEY_SCOPE)
        assert "Ada Lovelace" not in sealed.ciphertext

    @pytest.mark.asyncio
    async def test_the_same_value_seals_differently_every_time(self):
        first = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        second = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        assert first.ciphertext != second.ciphertext

    @pytest.mark.asyncio
    async def test_multibyte_values_round_trip(self):
        sealed = await CIPHER.seal("café ☕ Ada 🎉", "tok-1", KEY_SCOPE)
        assert await CIPHER.unseal(sealed, "tok-1", KEY_SCOPE) == "café ☕ Ada 🎉"

    @pytest.mark.asyncio
    async def test_an_empty_value_round_trips(self):
        sealed = await CIPHER.seal("", "tok-1", KEY_SCOPE)
        assert await CIPHER.unseal(sealed, "tok-1", KEY_SCOPE) == ""

    @pytest.mark.asyncio
    async def test_the_sealed_value_records_the_version_it_was_written_at(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        assert sealed.key_version == 1


class TestAadBinding:
    """A row moved between scopes or token_ids must fail rather than resolve."""

    @pytest.mark.asyncio
    async def test_a_ciphertext_moved_to_another_scope_fails_to_decrypt(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        assert isinstance(await CIPHER.unseal(sealed, "tok-1", OTHER_KEY_SCOPE), DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_ciphertext_moved_to_another_scope_type_fails_to_decrypt(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        assert isinstance(await CIPHER.unseal(sealed, "tok-1", TEAM_SCOPE), DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_token_id_swapped_between_rows_fails_to_decrypt(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        assert isinstance(await CIPHER.unseal(sealed, "tok-2", KEY_SCOPE), DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_claimed_version_that_does_not_match_fails_to_decrypt(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        relabelled = SealedValue(ciphertext=sealed.ciphertext, key_version=2)
        assert isinstance(await CIPHER.unseal(relabelled, "tok-1", KEY_SCOPE), DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_tampered_ciphertext_fails_to_decrypt(self):
        sealed = await CIPHER.seal("Ada Lovelace", "tok-1", KEY_SCOPE)
        flipped = sealed.ciphertext[:-4] + ("A" if sealed.ciphertext[-4] != "A" else "B") + sealed.ciphertext[-3:]
        result = await CIPHER.unseal(SealedValue(flipped, sealed.key_version), "tok-1", KEY_SCOPE)
        assert not isinstance(result, str)

    @pytest.mark.asyncio
    async def test_another_root_secret_cannot_read_it(self):
        sealed = await CIPHER.seal("Ada", "tok-1", KEY_SCOPE)
        foreign = VaultCipher(keys=DerivedKeyProvider(secret="different-root"))
        assert isinstance(await foreign.unseal(sealed, "tok-1", KEY_SCOPE), DecodeFailed)


class TestLazyRotation:
    @pytest.mark.asyncio
    async def test_a_row_written_at_v1_still_decrypts_after_the_current_version_moves_to_2(self):
        sealed = await CIPHER.seal("Ada Lovelace", "tok-1", KEY_SCOPE)
        assert sealed.key_version == 1

        rotated = VaultCipher(keys=DerivedKeyProvider(secret="root-secret", version=2))
        assert await rotated.unseal(sealed, "tok-1", KEY_SCOPE) == "Ada Lovelace"

    @pytest.mark.asyncio
    async def test_new_writes_use_the_new_version(self):
        rotated = VaultCipher(keys=DerivedKeyProvider(secret="root-secret", version=2))
        sealed = await rotated.seal("Ada", "tok-1", KEY_SCOPE)
        assert sealed.key_version == 2

    @pytest.mark.asyncio
    async def test_a_v2_row_is_unreadable_with_the_v1_key(self):
        rotated = VaultCipher(keys=DerivedKeyProvider(secret="root-secret", version=2))
        sealed = await rotated.seal("Ada", "tok-1", KEY_SCOPE)
        mislabelled = SealedValue(ciphertext=sealed.ciphertext, key_version=1)
        assert isinstance(await CIPHER.unseal(mislabelled, "tok-1", KEY_SCOPE), DecodeFailed)


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_a_missing_key_surfaces_on_seal(self):
        cipher = VaultCipher(keys=DerivedKeyProvider(secret=""))
        assert isinstance(await cipher.seal("Ada", "tok-1", KEY_SCOPE), KeyUnavailable)

    @pytest.mark.asyncio
    async def test_a_missing_key_surfaces_on_unseal(self):
        cipher = VaultCipher(keys=DerivedKeyProvider(secret=""))
        result = await cipher.unseal(SealedValue("p1:gcm:abc", 1), "tok-1", KEY_SCOPE)
        assert isinstance(result, KeyUnavailable)

    @pytest.mark.asyncio
    async def test_a_provider_returning_the_wrong_key_size_is_a_clear_error_not_a_crash(self):
        class ShortKeyProvider:
            def current_version(self):
                return 1

            async def key_for(self, scope, version):
                return b"too-short"

        cipher = VaultCipher(keys=ShortKeyProvider())
        result = await cipher.seal("Ada", "tok-1", KEY_SCOPE)
        assert isinstance(result, KeyUnavailable)
        assert "expected 32" in result.reason

    @pytest.mark.asyncio
    async def test_the_wrong_key_size_is_caught_on_unseal_too(self):
        class ShortKeyProvider:
            def current_version(self):
                return 1

            async def key_for(self, scope, version):
                return b"too-short"

        result = await VaultCipher(keys=ShortKeyProvider()).unseal(SealedValue("p1:gcm:abc", 1), "tok-1", KEY_SCOPE)
        assert isinstance(result, KeyUnavailable)

    @pytest.mark.asyncio
    async def test_a_malformed_base64_body_is_reported_not_raised(self):
        result = await CIPHER.unseal(SealedValue("p1:gcm:!!!not-base64!!!", 1), "tok-1", KEY_SCOPE)
        assert isinstance(result, DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_truncated_body_is_reported_not_raised(self):
        result = await CIPHER.unseal(SealedValue("p1:gcm:AAAA", 1), "tok-1", KEY_SCOPE)
        assert isinstance(result, DecodeFailed)

    @pytest.mark.asyncio
    async def test_a_blob_without_the_vault_prefix_is_rejected(self):
        result = await CIPHER.unseal(SealedValue("v1:gcm:abc", 1), "tok-1", KEY_SCOPE)
        assert isinstance(result, DecodeFailed)
        assert "prefix" in result.reason
