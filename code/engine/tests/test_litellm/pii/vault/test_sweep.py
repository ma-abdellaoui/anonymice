import pytest

from litellm.pii.vault.sweep import PII_VAULT_SWEEP_JOB_NAME, PiiVaultSweeper

from .test_store import FakeTable, build_store


class RecordingLock:
    def __init__(self, granted=True):
        self.granted = granted
        self.acquired = []
        self.released = []

    async def acquire_lock(self, cronjob_id):
        self.acquired.append(cronjob_id)
        return self.granted

    async def release_lock(self, cronjob_id):
        self.released.append(cronjob_id)


def expired_row(table, token_id="tok-old"):
    from datetime import datetime, timedelta, timezone

    table.rows.append(
        {
            "token_id": token_id,
            "expires_at": datetime.now(timezone.utc) - timedelta(days=1),
        }
    )


class TestSweep:
    @pytest.mark.asyncio
    async def test_it_deletes_rows_past_their_expiry(self):
        table = FakeTable()
        expired_row(table)
        await PiiVaultSweeper(store=build_store(table)).sweep()
        assert table.rows == []

    @pytest.mark.asyncio
    async def test_it_leaves_a_live_row_alone(self):
        from datetime import datetime, timedelta, timezone

        table = FakeTable()
        table.rows.append({"token_id": "tok-live", "expires_at": datetime.now(timezone.utc) + timedelta(days=1)})
        await PiiVaultSweeper(store=build_store(table)).sweep()
        assert len(table.rows) == 1

    @pytest.mark.asyncio
    async def test_a_row_with_no_expiry_is_never_swept(self):
        table = FakeTable()
        table.rows.append({"token_id": "tok-forever", "expires_at": None})
        await PiiVaultSweeper(store=build_store(table)).sweep()
        assert len(table.rows) == 1

    @pytest.mark.asyncio
    async def test_only_the_pod_holding_the_lock_sweeps(self):
        table = FakeTable()
        expired_row(table)
        await PiiVaultSweeper(store=build_store(table), lock=RecordingLock(granted=False)).sweep()
        assert len(table.rows) == 1

    @pytest.mark.asyncio
    async def test_a_pod_that_did_not_win_the_lock_does_not_release_it(self):
        lock = RecordingLock(granted=False)
        await PiiVaultSweeper(store=build_store(), lock=lock).sweep()
        assert lock.released == []

    @pytest.mark.asyncio
    async def test_the_lock_is_released_after_a_successful_sweep(self):
        lock = RecordingLock()
        await PiiVaultSweeper(store=build_store(), lock=lock).sweep()
        assert lock.acquired == lock.released == [PII_VAULT_SWEEP_JOB_NAME]

    @pytest.mark.asyncio
    async def test_a_database_failure_still_releases_the_lock(self):
        lock = RecordingLock()
        broken = build_store(FakeTable(error=RuntimeError("connection reset")))
        await PiiVaultSweeper(store=broken, lock=lock).sweep()
        assert lock.released == [PII_VAULT_SWEEP_JOB_NAME]

    @pytest.mark.asyncio
    async def test_a_database_failure_does_not_propagate_out_of_a_scheduled_job(self):
        broken = build_store(FakeTable(error=RuntimeError("connection reset")))
        assert await PiiVaultSweeper(store=broken).sweep() is None
