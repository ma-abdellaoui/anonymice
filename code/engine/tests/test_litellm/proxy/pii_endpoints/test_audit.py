import json

from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.proxy._types import LitellmTableNames, UserAPIKeyAuth
from litellm.proxy.pii_endpoints.audit import (
    decode_audit_entry,
    default_mint_scope,
    identity_from,
    may_search,
    scope_object_id,
)

TEAM_SCOPE = VaultScope(VaultScopeType.TEAM, "team-eng")

DECODER = UserAPIKeyAuth(
    api_key="hashed-alice",
    user_id="user-alice",
    team_id="team-eng",
    org_id="org-acme",
    permissions={"allow_pii_decode": True},
)
BREAK_GLASS = UserAPIKeyAuth(
    api_key="hashed-admin",
    user_id="user-admin",
    permissions={"allow_pii_decode_any": True},
)
NO_GRANTS = UserAPIKeyAuth(api_key="hashed-bob", user_id="user-bob", permissions={})


class TestIdentityExtraction:
    def test_every_scope_field_is_carried_across(self):
        identity = identity_from(DECODER)
        assert (identity.key_hash, identity.user_id, identity.team_id, identity.organization_id) == (
            "hashed-alice",
            "user-alice",
            "team-eng",
            "org-acme",
        )

    def test_the_decode_grant_is_read_from_permissions(self):
        assert identity_from(DECODER).can_decode is True
        assert identity_from(NO_GRANTS).can_decode is False

    def test_break_glass_is_a_separate_grant_and_off_by_default(self):
        assert identity_from(DECODER).can_decode_any is False
        assert identity_from(BREAK_GLASS).can_decode_any is True

    def test_a_truthy_but_non_true_permission_value_does_not_grant(self):
        sneaky = UserAPIKeyAuth(api_key="k", permissions={"allow_pii_decode": "yes"})
        assert identity_from(sneaky).can_decode is False

    def test_a_key_with_no_permissions_set_grants_nothing(self):
        bare = identity_from(UserAPIKeyAuth(api_key="k"))
        assert (bare.can_decode, bare.can_decode_any) == (False, False)

    def test_search_is_a_permission_of_its_own(self):
        assert may_search(DECODER) is False
        assert may_search(UserAPIKeyAuth(api_key="k", permissions={"allow_pii_search": True})) is True


class TestAuditEntry:
    def test_it_records_the_scope_as_the_object(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, token_count=3, break_glass=False)
        assert entry.object_id == "team:team-eng"
        assert scope_object_id(TEAM_SCOPE) == "team:team-eng"

    def test_it_is_filed_against_the_vault_table(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, token_count=1, break_glass=False)
        assert entry.table_name == LitellmTableNames.PII_TOKEN_TABLE_NAME

    def test_a_read_is_recorded_as_accessed_not_as_a_write(self):
        assert decode_audit_entry(DECODER, TEAM_SCOPE, 1, False).action == "accessed"

    def test_it_names_who_read(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, 1, False)
        assert entry.changed_by == "user-alice"

    def test_it_records_how_many_tokens_were_resolved(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, token_count=7, break_glass=False)
        assert json.loads(entry.updated_values)["token_count"] == 7

    def test_break_glass_use_is_flagged(self):
        entry = decode_audit_entry(BREAK_GLASS, TEAM_SCOPE, token_count=1, break_glass=True)
        assert json.loads(entry.updated_values)["break_glass"] is True

    def test_an_ordinary_read_is_not_flagged_as_break_glass(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, token_count=1, break_glass=False)
        assert json.loads(entry.updated_values)["break_glass"] is False

    def test_it_never_records_a_token_or_a_value(self):
        entry = decode_audit_entry(DECODER, TEAM_SCOPE, token_count=1, break_glass=False)
        recorded = json.loads(entry.updated_values)
        assert set(recorded) == {"token_count", "break_glass", "scope_type"}


class TestDefaults:
    def test_minting_defaults_to_the_most_restrictive_scope(self):
        assert default_mint_scope() is VaultScopeType.KEY
