from dataclasses import dataclass
from enum import Enum


class VaultScopeType(str, Enum):
    """Who may resolve a stored token, most restrictive first."""

    KEY = "key"
    USER = "user"
    TEAM = "team"
    ORGANIZATION = "organization"


@dataclass(frozen=True, slots=True)
class VaultScope:
    """The security boundary a persisted token belongs to.

    Distinct from the ephemeral ``TokenScope``, which is a cache partition for
    one request or conversation. This one outlives the call that minted it and
    is what authorization and key derivation are both bound to.
    """

    scope_type: VaultScopeType
    scope_id: str
