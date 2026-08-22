import pytest

from litellm.pii.types import VaultForbidden
from litellm.pii.vault.authorization import (
    CallerIdentity,
    authorize_decode,
    belongs_to,
    scope_id_for,
    scope_to_mint,
    used_break_glass,
)
from litellm.pii.vault.scope import VaultScope, VaultScopeType

ALICE = CallerIdentity(
    key_hash="key-alice",
    user_id="user-alice",
    team_id="team-eng",
    organization_id="org-acme",
    can_decode=True,
)
BOB_SAME_TEAM = CallerIdentity(
    key_hash="key-bob",
    user_id="user-bob",
    team_id="team-eng",
    organization_id="org-acme",
    can_decode=True,
)
CAROL_OTHER_TEAM = CallerIdentity(
    key_hash="key-carol",
    user_id="user-carol",
    team_id="team-sales",
    organization_id="org-acme",
    can_decode=True,
)
DAN_OTHER_ORG = CallerIdentity(
    key_hash="key-dan",
    user_id="user-dan",
    team_id="team-ops",
    organization_id="org-other",
    can_decode=True,
)

ALL_TYPES = list(VaultScopeType)


class TestScopeIdFor:
    @pytest.mark.parametrize(
        "scope_type,expected",
        [
            (VaultScopeType.KEY, "key-alice"),
            (VaultScopeType.USER, "user-alice"),
            (VaultScopeType.TEAM, "team-eng"),
            (VaultScopeType.ORGANIZATION, "org-acme"),
        ],
        ids=lambda v: str(v),
    )
    def test_each_scope_type_reads_its_own_field(self, scope_type, expected):
        assert scope_id_for(ALICE, scope_type) == expected

    def test_a_caller_with_no_team_has_no_team_scope(self):
        assert scope_id_for(CallerIdentity(key_hash="k"), VaultScopeType.TEAM) is None


class TestMinting:
    @pytest.mark.parametrize("scope_type", ALL_TYPES, ids=lambda v: str(v))
    def test_a_caller_may_mint_at_every_scope_it_belongs_to(self, scope_type):
        minted = scope_to_mint(ALICE, scope_type)
        assert isinstance(minted, VaultScope)
        assert minted.scope_id == scope_id_for(ALICE, scope_type)

    def test_a_key_cannot_mint_a_team_token_for_a_team_it_is_not_on(self):
        teamless = CallerIdentity(key_hash="key-x", user_id="user-x", can_decode=True)
        result = scope_to_mint(teamless, VaultScopeType.TEAM)
        assert isinstance(result, VaultForbidden)
        assert "team" in result.reason

    def test_a_key_without_an_organization_cannot_mint_an_organization_token(self):
        result = scope_to_mint(CallerIdentity(key_hash="key-x"), VaultScopeType.ORGANIZATION)
        assert isinstance(result, VaultForbidden)

    def test_an_anonymous_caller_cannot_mint_at_all(self):
        for scope_type in ALL_TYPES:
            assert isinstance(scope_to_mint(CallerIdentity(), scope_type), VaultForbidden)

    def test_minting_never_invents_a_scope_id_from_another_field(self):
        keyless = CallerIdentity(user_id="user-x", team_id="team-y")
        assert isinstance(scope_to_mint(keyless, VaultScopeType.KEY), VaultForbidden)


class TestDecodeAuthorization:
    """Each scope level resolves for members and refuses for non-members."""

    def test_key_scope_resolves_only_for_the_exact_key(self):
        scope = VaultScope(VaultScopeType.KEY, "key-alice")
        assert authorize_decode(ALICE, scope) is None
        assert isinstance(authorize_decode(BOB_SAME_TEAM, scope), VaultForbidden)

    def test_user_scope_resolves_for_any_key_of_that_user(self):
        scope = VaultScope(VaultScopeType.USER, "user-alice")
        other_key_same_user = CallerIdentity(key_hash="key-alice-2", user_id="user-alice", can_decode=True)
        assert authorize_decode(other_key_same_user, scope) is None
        assert isinstance(authorize_decode(BOB_SAME_TEAM, scope), VaultForbidden)

    def test_team_scope_resolves_for_a_teammate_and_refuses_another_team(self):
        scope = VaultScope(VaultScopeType.TEAM, "team-eng")
        assert authorize_decode(BOB_SAME_TEAM, scope) is None
        assert isinstance(authorize_decode(CAROL_OTHER_TEAM, scope), VaultForbidden)

    def test_organization_scope_resolves_inside_the_org_and_refuses_outside(self):
        scope = VaultScope(VaultScopeType.ORGANIZATION, "org-acme")
        assert authorize_decode(CAROL_OTHER_TEAM, scope) is None
        assert isinstance(authorize_decode(DAN_OTHER_ORG, scope), VaultForbidden)

    def test_belonging_to_the_org_does_not_grant_a_team_scoped_token(self):
        scope = VaultScope(VaultScopeType.TEAM, "team-eng")
        assert isinstance(authorize_decode(CAROL_OTHER_TEAM, scope), VaultForbidden)

    def test_belonging_to_the_team_does_not_grant_another_members_key_token(self):
        scope = VaultScope(VaultScopeType.KEY, "key-alice")
        assert isinstance(authorize_decode(BOB_SAME_TEAM, scope), VaultForbidden)

    @pytest.mark.parametrize("scope_type", ALL_TYPES, ids=lambda v: str(v))
    def test_the_permission_is_required_even_for_a_member(self, scope_type):
        member_without_grant = CallerIdentity(
            key_hash="key-alice",
            user_id="user-alice",
            team_id="team-eng",
            organization_id="org-acme",
            can_decode=False,
        )
        scope = VaultScope(scope_type, scope_id_for(member_without_grant, scope_type))
        result = authorize_decode(member_without_grant, scope)
        assert isinstance(result, VaultForbidden)
        assert "allow_pii_decode" in result.reason

    def test_a_null_field_never_matches_a_scope_id(self):
        teamless = CallerIdentity(key_hash="k", can_decode=True)
        assert isinstance(authorize_decode(teamless, VaultScope(VaultScopeType.TEAM, "team-eng")), VaultForbidden)
        assert belongs_to(teamless, VaultScope(VaultScopeType.TEAM, "team-eng")) is False


class TestBreakGlass:
    ADMIN = CallerIdentity(key_hash="key-admin", user_id="user-admin", can_decode_any=True)

    def test_it_resolves_a_token_from_a_scope_the_caller_is_not_in(self):
        assert authorize_decode(self.ADMIN, VaultScope(VaultScopeType.TEAM, "team-eng")) is None

    def test_it_is_off_by_default(self):
        assert CallerIdentity().can_decode_any is False

    def test_an_admin_without_the_grant_is_refused_like_anyone_else(self):
        plain_admin = CallerIdentity(key_hash="key-admin", user_id="user-admin", can_decode=True)
        scope = VaultScope(VaultScopeType.TEAM, "team-eng")
        assert isinstance(authorize_decode(plain_admin, scope), VaultForbidden)

    def test_using_it_outside_your_own_scope_is_recorded_as_break_glass(self):
        assert used_break_glass(self.ADMIN, VaultScope(VaultScopeType.TEAM, "team-eng")) is True

    def test_reading_your_own_scope_is_not_recorded_as_break_glass(self):
        holder = CallerIdentity(key_hash="key-admin", team_id="team-eng", can_decode_any=True)
        assert used_break_glass(holder, VaultScope(VaultScopeType.TEAM, "team-eng")) is False

    def test_a_caller_without_the_grant_never_reads_as_break_glass(self):
        assert used_break_glass(ALICE, VaultScope(VaultScopeType.TEAM, "team-sales")) is False

    def test_the_grant_alone_satisfies_the_decode_permission(self):
        assert authorize_decode(self.ADMIN, VaultScope(VaultScopeType.KEY, "key-admin")) is None
