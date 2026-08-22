import json
from typing import Final

from litellm._uuid import uuid
from litellm.pii.vault.authorization import CallerIdentity
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.proxy._types import LiteLLM_AuditLogs, LitellmTableNames, UserAPIKeyAuth

DECODE_PERMISSION: Final = "allow_pii_decode"
DECODE_ANY_PERMISSION: Final = "allow_pii_decode_any"
SEARCH_PERMISSION: Final = "allow_pii_search"


def _granted(user_api_key_dict: UserAPIKeyAuth, permission: str) -> bool:
    """Only a literal True grants: a truthy string must not read as permission."""
    return user_api_key_dict.permissions.get(permission) is True


def identity_from(user_api_key_dict: UserAPIKeyAuth) -> CallerIdentity:
    """The proxy's auth object reduced to what the vault's rules need."""
    return CallerIdentity(
        key_hash=user_api_key_dict.api_key,
        user_id=user_api_key_dict.user_id,
        team_id=user_api_key_dict.team_id,
        organization_id=user_api_key_dict.org_id,
        can_decode=_granted(user_api_key_dict, DECODE_PERMISSION),
        can_decode_any=_granted(user_api_key_dict, DECODE_ANY_PERMISSION),
    )


def may_search(user_api_key_dict: UserAPIKeyAuth) -> bool:
    """Separate from decode: listing what a scope holds is a different capability."""
    return _granted(user_api_key_dict, SEARCH_PERMISSION)


def scope_object_id(scope: VaultScope) -> str:
    return f"{scope.scope_type.value}:{scope.scope_id}"


def decode_audit_entry(
    user_api_key_dict: UserAPIKeyAuth,
    scope: VaultScope,
    token_count: int,
    break_glass: bool,
) -> LiteLLM_AuditLogs:
    """What a vault read records.

    Counts and scope only. The values are the thing being protected, and the
    tokens themselves are the index into them, so neither belongs in a log that
    is retained longer than the rows are.
    """
    from datetime import datetime, timezone

    details: Final = {  # mutable-ok: serialized straight to JSON
        "token_count": token_count,
        "break_glass": break_glass,
        "scope_type": scope.scope_type.value,
    }
    return LiteLLM_AuditLogs(
        id=str(uuid.uuid4()),
        updated_at=datetime.now(timezone.utc),
        changed_by=user_api_key_dict.user_id,
        changed_by_api_key=user_api_key_dict.api_key,
        action="accessed",
        table_name=LitellmTableNames.PII_TOKEN_TABLE_NAME,
        object_id=scope_object_id(scope),
        updated_values=json.dumps(details),
    )


async def record_decode(
    user_api_key_dict: UserAPIKeyAuth,
    scope: VaultScope,
    token_count: int,
    break_glass: bool,
) -> None:
    """Best effort: an audit write must never fail the read it is describing."""
    from litellm._logging import verbose_proxy_logger
    from litellm.proxy.management_helpers.audit_logs import create_audit_log_for_update

    try:
        await create_audit_log_for_update(decode_audit_entry(user_api_key_dict, scope, token_count, break_glass))
    except Exception as exc:
        verbose_proxy_logger.warning("PII vault audit write failed (%s)", type(exc).__name__)


def default_mint_scope() -> VaultScopeType:
    """The most restrictive scope, so widening is always a deliberate choice."""
    return VaultScopeType.KEY
