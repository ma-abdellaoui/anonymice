from datetime import datetime, timedelta, timezone

import pytest

from litellm.pii.types import StoreUnavailable
from litellm.pii.vault.cipher import VaultCipher
from litellm.pii.vault.keys import DerivedKeyProvider
from litellm.pii.vault.repository import PiiVaultRepository, record_to_row, row_to_record
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.store import DatabaseTokenStore, MintRequest

KEY_SCOPE = VaultScope(VaultScopeType.KEY, "key-alice")
OTHER_KEY_SCOPE = VaultScope(VaultScopeType.KEY, "key-bob")
TEAM_SCOPE = VaultScope(VaultScopeType.TEAM, "team-eng")


class FakeTable:
    """In-memory stand-in that honours the filters the repository builds."""

    def __init__(self, error=None):
        self.rows = []
        self.error = error
        self.find_calls = 0

    async def create_many(self, data, skip_duplicates):
        if self.error is not None:
            raise self.error
        existing = {row["token_id"] for row in self.rows}
        self.rows.extend(row for row in data if not (skip_duplicates and row["token_id"] in existing))

    async def find_many(self, where):
        if self.error is not None:
            raise self.error
        self.find_calls += 1
        return [row for row in self.rows if self._matches(row, where)]

    async def delete_many(self, where):
        if self.error is not None:
            raise self.error
        self.rows = [row for row in self.rows if not self._matches(row, where)]

    def _matches(self, row, where):
        for key, expected in where.items():
            if key == "OR":
                if not any(self._matches(row, clause) for clause in expected):
                    return False
            elif isinstance(expected, dict) and "in" in expected:
                if row.get(key) not in expected["in"]:
                    return False
            elif isinstance(expected, dict) and "gt" in expected:
                actual = row.get(key)
                if actual is None or actual <= expected["gt"]:
                    return False
            elif isinstance(expected, dict) and "lt" in expected:
                actual = row.get(key)
                if actual is None or actual >= expected["lt"]:
                    return False
            elif row.get(key) != expected:
                return False
        return True


def build_store(table=None, retention_days=30):
    return DatabaseTokenStore(
        repository=PiiVaultRepository(table=table or FakeTable()),
        cipher=VaultCipher(keys=DerivedKeyProvider(secret="root-secret")),
        retention_days=retention_days,
    )


def mints(*pairs):
    return [MintRequest(token=token, entity_type="PERSON", value=value) for token, value in pairs]


class TestRecordMapping:
    def test_a_row_survives_a_round_trip_through_the_column_mapping(self):
        from litellm.pii.vault.repository import VaultRow

        original = VaultRow(
            token_id="tok-1",
            entity_type="PERSON",
            ciphertext="p1:gcm:abc",
            key_version=2,
            scope=TEAM_SCOPE,
            session_id="sess-1",
            subject_id="subject-1",
            created_by="user-alice",
            expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        )
        assert record_to_row(row_to_record(original)) == original

    def test_the_record_never_carries_a_plaintext_column(self):
        from litellm.pii.vault.repository import VaultRow

        record = row_to_record(VaultRow("tok-1", "PERSON", "p1:gcm:abc", 1, KEY_SCOPE))
        assert "value" not in record and "plaintext" not in record

    def test_a_record_missing_its_ciphertext_is_skipped_not_guessed(self):
        assert record_to_row({"token_id": "tok-1", "scope_type": "key", "scope_id": "a"}) is None

    def test_a_record_with_an_unknown_scope_type_is_skipped(self):
        record = {"token_id": "t", "ciphertext": "c", "scope_type": "planet", "scope_id": "a"}
        assert record_to_row(record) is None

    def test_a_record_with_a_non_string_token_id_is_skipped(self):
        record = {"token_id": 7, "ciphertext": "c", "scope_type": "key", "scope_id": "a"}
        assert record_to_row(record) is None


class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_a_stored_token_resolves(self):
        store = build_store()
        assert await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada Lovelace"))) is None
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>"]) == {"<PERSON:a1>": "Ada Lovelace"}

    @pytest.mark.asyncio
    async def test_many_tokens_resolve_in_one_query(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(*[(f"<PERSON:{i}>", f"person-{i}") for i in range(25)]))
        resolved = await store.get_many(KEY_SCOPE, [f"<PERSON:{i}>" for i in range(25)])
        assert len(resolved) == 25
        assert table.find_calls == 1

    @pytest.mark.asyncio
    async def test_nothing_is_stored_in_plaintext(self):
        table = FakeTable()
        await build_store(table).put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada Lovelace")))
        assert "Ada Lovelace" not in str(table.rows)

    @pytest.mark.asyncio
    async def test_an_unknown_token_is_simply_absent(self):
        store = build_store()
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>", "<PERSON:zz>"]) == {"<PERSON:a1>": "Ada"}

    @pytest.mark.asyncio
    async def test_asking_for_nothing_queries_nothing(self):
        table = FakeTable()
        assert await build_store(table).get_many(KEY_SCOPE, []) == {}
        assert table.find_calls == 0

    @pytest.mark.asyncio
    async def test_writing_nothing_is_a_no_op(self):
        table = FakeTable()
        assert await build_store(table).put_many(KEY_SCOPE, "sess-1", []) is None
        assert table.rows == []


class TestScopeIsolation:
    @pytest.mark.asyncio
    async def test_another_scope_cannot_read_the_token(self):
        store = build_store()
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        assert await store.get_many(OTHER_KEY_SCOPE, ["<PERSON:a1>"]) == {}

    @pytest.mark.asyncio
    async def test_the_same_id_under_another_scope_type_cannot_read_it(self):
        store = build_store()
        await store.put_many(VaultScope(VaultScopeType.KEY, "shared-id"), "sess-1", mints(("<PERSON:a1>", "Ada")))
        assert await store.get_many(VaultScope(VaultScopeType.TEAM, "shared-id"), ["<PERSON:a1>"]) == {}

    @pytest.mark.asyncio
    async def test_a_row_relabelled_into_another_scope_still_fails_to_decrypt(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        table.rows[0]["scope_id"] = OTHER_KEY_SCOPE.scope_id
        assert await store.get_many(OTHER_KEY_SCOPE, ["<PERSON:a1>"]) == {}

    @pytest.mark.asyncio
    async def test_a_token_id_swapped_between_rows_fails_to_decrypt(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada"), ("<PERSON:b2>", "Grace")))
        table.rows[0]["token_id"], table.rows[1]["token_id"] = "<PERSON:b2>", "<PERSON:a1>"
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>", "<PERSON:b2>"]) == {}


class TestExpiry:
    @pytest.mark.asyncio
    async def test_retention_is_written_onto_the_row(self):
        table = FakeTable()
        await build_store(table, retention_days=30).put_many(KEY_SCOPE, "s", mints(("<PERSON:a1>", "Ada")))
        remaining = table.rows[0]["expires_at"] - datetime.now(timezone.utc)
        assert timedelta(days=29) < remaining <= timedelta(days=30)

    @pytest.mark.asyncio
    async def test_an_expired_row_never_resolves_even_before_the_sweep_runs(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        table.rows[0]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>"]) == {}

    @pytest.mark.asyncio
    async def test_a_row_with_no_expiry_still_resolves(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        table.rows[0]["expires_at"] = None
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>"]) == {"<PERSON:a1>": "Ada"}

    @pytest.mark.asyncio
    async def test_the_sweep_removes_expired_rows_and_keeps_live_ones(self):
        table = FakeTable()
        store = build_store(table)
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada"), ("<PERSON:b2>", "Grace")))
        table.rows[0]["expires_at"] = datetime.now(timezone.utc) - timedelta(days=1)
        assert await store.sweep_expired() is None
        assert [row["token_id"] for row in table.rows] == ["<PERSON:b2>"]


class TestRevocation:
    @pytest.mark.asyncio
    async def test_revoking_a_session_kills_every_token_it_minted(self):
        store = build_store()
        await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        await store.put_many(KEY_SCOPE, "sess-2", mints(("<PERSON:b2>", "Grace")))
        assert await store.revoke_session(KEY_SCOPE, "sess-1") is None
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>", "<PERSON:b2>"]) == {"<PERSON:b2>": "Grace"}

    @pytest.mark.asyncio
    async def test_revoking_a_session_cannot_reach_another_scope(self):
        store = build_store()
        await store.put_many(OTHER_KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        await store.revoke_session(KEY_SCOPE, "sess-1")
        assert await store.get_many(OTHER_KEY_SCOPE, ["<PERSON:a1>"]) == {"<PERSON:a1>": "Ada"}

    @pytest.mark.asyncio
    async def test_subject_erasure_removes_only_that_subject(self):
        store = build_store()
        await store.put_many(KEY_SCOPE, "s", mints(("<PERSON:a1>", "Ada")), subject_id="subject-1")
        await store.put_many(KEY_SCOPE, "s", mints(("<PERSON:b2>", "Grace")), subject_id="subject-2")
        assert await store.revoke_subject(KEY_SCOPE, "subject-1") is None
        assert await store.get_many(KEY_SCOPE, ["<PERSON:a1>", "<PERSON:b2>"]) == {"<PERSON:b2>": "Grace"}

    @pytest.mark.asyncio
    async def test_subject_export_returns_that_subjects_values(self):
        store = build_store()
        await store.put_many(KEY_SCOPE, "s", mints(("<PERSON:a1>", "Ada")), subject_id="subject-1")
        await store.put_many(KEY_SCOPE, "s", mints(("<PERSON:b2>", "Grace")), subject_id="subject-2")
        assert await store.export_subject(KEY_SCOPE, "subject-1") == {"<PERSON:a1>": "Ada"}

    @pytest.mark.asyncio
    async def test_subject_export_cannot_cross_scopes(self):
        store = build_store()
        await store.put_many(OTHER_KEY_SCOPE, "s", mints(("<PERSON:a1>", "Ada")), subject_id="subject-1")
        assert await store.export_subject(KEY_SCOPE, "subject-1") == {}


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_a_write_failure_is_reported_so_no_unresolvable_token_is_returned(self):
        store = build_store(FakeTable(error=RuntimeError("db down")))
        result = await store.put_many(KEY_SCOPE, "sess-1", mints(("<PERSON:a1>", "Ada")))
        assert isinstance(result, StoreUnavailable)
        assert "RuntimeError" in result.reason

    @pytest.mark.asyncio
    async def test_a_read_failure_is_reported_not_read_as_an_empty_result(self):
        store = build_store(FakeTable(error=RuntimeError("db down")))
        assert isinstance(await store.get_many(KEY_SCOPE, ["<PERSON:a1>"]), StoreUnavailable)

    @pytest.mark.asyncio
    async def test_a_sweep_failure_is_reported(self):
        store = build_store(FakeTable(error=RuntimeError("db down")))
        assert isinstance(await store.sweep_expired(), StoreUnavailable)

    @pytest.mark.asyncio
    async def test_a_revocation_failure_is_reported(self):
        store = build_store(FakeTable(error=RuntimeError("db down")))
        assert isinstance(await store.revoke_session(KEY_SCOPE, "sess-1"), StoreUnavailable)

    @pytest.mark.asyncio
    async def test_a_key_failure_aborts_the_write_rather_than_storing_plaintext(self):
        table = FakeTable()
        store = DatabaseTokenStore(
            repository=PiiVaultRepository(table=table),
            cipher=VaultCipher(keys=DerivedKeyProvider(secret="")),
        )
        assert isinstance(await store.put_many(KEY_SCOPE, "s", mints(("<PERSON:a1>", "Ada"))), StoreUnavailable)
        assert table.rows == []
