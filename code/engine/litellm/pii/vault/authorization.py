from dataclasses import dataclass
from typing import Final, assert_never

from litellm.pii.types import VaultForbidden
from litellm.pii.vault.scope import VaultScope, VaultScopeType


@dataclass(frozen=True, slots=True)
class CallerIdentity:
    """The scopes a caller belongs to, and what it is permitted to do.

    A plain value object rather than the proxy's auth model, so the vault's
    authorization rules stay testable without a proxy and without a database.
    """

    key_hash: str | None = None
    user_id: str | None = None
    team_id: str | None = None
    organization_id: str | None = None
    can_decode: bool = False
    can_decode_any: bool = False


def scope_id_for(identity: CallerIdentity, scope_type: VaultScopeType) -> str | None:
    match scope_type:
        case VaultScopeType.KEY:
            return identity.key_hash
        case VaultScopeType.USER:
            return identity.user_id
        case VaultScopeType.TEAM:
            return identity.team_id
        case VaultScopeType.ORGANIZATION:
            return identity.organization_id
        case _:
            assert_never(scope_type)


def belongs_to(identity: CallerIdentity, scope: VaultScope) -> bool:
    resolved: Final = scope_id_for(identity, scope.scope_type)
    return resolved is not None and resolved == scope.scope_id


def scope_to_mint(identity: CallerIdentity, requested: VaultScopeType) -> VaultScope | VaultForbidden:
    """A caller may only mint at a scope it already belongs to.

    Otherwise a key could mint a token visible to a team it is not on, which
    would let it hand PII to that team by handing over the token.
    """
    scope_id: Final = scope_id_for(identity, requested)
    if not scope_id:
        return VaultForbidden(reason=f"caller has no {requested.value} to mint a token against")
    return VaultScope(scope_type=requested, scope_id=scope_id)


def authorize_decode(identity: CallerIdentity, scope: VaultScope) -> None | VaultForbidden:
    """Decode needs the grant and scope membership, or the break-glass grant.

    Proxy admin does not implicitly resolve everything: reading a PII vault is
    the kind of capability that should have to be turned on deliberately.
    """
    if not identity.can_decode and not identity.can_decode_any:
        return VaultForbidden(reason="key lacks the allow_pii_decode permission")
    if identity.can_decode_any or belongs_to(identity, scope):
        return None
    return VaultForbidden(reason=f"token is scoped to a {scope.scope_type.value} the caller does not belong to")


def used_break_glass(identity: CallerIdentity, scope: VaultScope) -> bool:
    """True only when the break-glass grant is what allowed the read, so the audit records real use."""
    return identity.can_decode_any and not belongs_to(identity, scope)
