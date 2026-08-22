import pytest

from litellm.pii.types import KeyUnavailable, SearchRefused, StoreUnavailable
from litellm.pii.vault.cipher import VaultCipher
from litellm.pii.vault.keys import DerivedKeyProvider
from litellm.pii.vault.repository import PiiVaultRepository
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.search import (
    MatchMode,
    NullSearchIndex,
    SearchResult,
    VaultSearch,
    matches,
    normalize,
)
from litellm.pii.vault.store import DatabaseTokenStore, MintRequest

from .test_store import FakeTable

KEY_SCOPE = VaultScope(VaultScopeType.KEY, "key-alice")
OTHER_SCOPE = VaultScope(VaultScopeType.KEY, "key-bob")
CIPHER = VaultCipher(keys=DerivedKeyProvider(secret="root-secret"))


class OrderedFakeTable(FakeTable):
    """FakeTable plus the ordering and page limit the keyset walk relies on."""

    async def find_many(self, where, order=None, take=None):
        rows = list(await super().find_many(where))
        if order:
            for column, direction in order.items():
                rows.sort(key=lambda row: row.get(column) or "", reverse=direction == "desc")
        return rows[:take] if take else rows


def build(table=None, candidate_cap=100_000, page_size=1000):
    return VaultSearch(
        repository=PiiVaultRepository(table=table or OrderedFakeTable()),
        cipher=CIPHER,
        candidate_cap=candidate_cap,
        page_size=page_size,
    )


async def seed(table, scope, values, entity_type="PERSON", subject_id=None, session_id="s1"):
    store = DatabaseTokenStore(repository=PiiVaultRepository(table=table), cipher=CIPHER)
    await store.put_many(
        scope=scope,
        session_id=session_id,
        mints=tuple(MintRequest(token=f"tok-{i:04d}", entity_type=entity_type, value=v) for i, v in enumerate(values)),
        subject_id=subject_id,
    )


class TestNormalize:
    def test_it_folds_case(self):
        assert normalize("Ada LOVELACE") == "ada lovelace"

    def test_it_strips_accents(self):
        assert normalize("Ada Lovelacé") == "ada lovelace"

    def test_it_collapses_whitespace(self):
        assert normalize("  Ada   Lovelace \n") == "ada lovelace"

    def test_it_leaves_an_already_normal_string_alone(self):
        assert normalize("ada lovelace") == "ada lovelace"


class TestMatchModes:
    def test_exact_is_byte_equality(self):
        assert matches("Ada", "Ada", normalize("Ada"), MatchMode.EXACT) is True
        assert matches("ada", "Ada", normalize("Ada"), MatchMode.EXACT) is False

    def test_normalized_ignores_case_accents_and_spacing(self):
        assert matches("Ada  Lovelacé", "ada lovelace", "ada lovelace", MatchMode.NORMALIZED) is True

    def test_normalized_is_still_a_whole_value_comparison(self):
        assert matches("Ada Lovelace", "Ada", "ada", MatchMode.NORMALIZED) is False

    def test_substring_matches_inside_the_value(self):
        assert matches("Ada Lovelace", "love", "love", MatchMode.SUBSTRING) is True

    def test_substring_does_not_match_what_is_absent(self):
        assert matches("Ada Lovelace", "babbage", "babbage", MatchMode.SUBSTRING) is False


class TestNullSearchIndex:
    def test_it_writes_no_terms_so_no_equality_is_ever_stored(self):
        index = NullSearchIndex()
        assert index.index_terms(KEY_SCOPE, "PERSON", "Ada Lovelace") == ()

    def test_it_produces_no_query_terms_so_search_falls_back_to_the_scan(self):
        assert NullSearchIndex().query_terms(KEY_SCOPE, "PERSON", "Ada") == ()


class TestSearch:
    @pytest.mark.asyncio
    async def test_it_finds_the_token_whose_value_matches(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada Lovelace", "Grace Hopper"])
        result = await build(table).search(KEY_SCOPE, "ada lovelace")
        assert [hit.token for hit in result.hits] == ["tok-0000"]

    @pytest.mark.asyncio
    async def test_it_is_confined_to_the_callers_scope(self):
        table = OrderedFakeTable()
        await seed(table, OTHER_SCOPE, ["Ada Lovelace"])
        result = await build(table).search(KEY_SCOPE, "ada lovelace")
        assert result.hits == ()

    @pytest.mark.asyncio
    async def test_another_scope_is_not_even_scanned(self):
        table = OrderedFakeTable()
        await seed(table, OTHER_SCOPE, ["Ada Lovelace"])
        assert (await build(table).search(KEY_SCOPE, "ada")).scanned == 0

    @pytest.mark.asyncio
    async def test_substring_search_finds_a_partial_value(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada Lovelace"])
        result = await build(table).search(KEY_SCOPE, "lovel", mode=MatchMode.SUBSTRING)
        assert len(result.hits) == 1

    @pytest.mark.asyncio
    async def test_an_accented_stored_value_is_found_by_an_unaccented_query(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada Lovelacé"])
        assert len((await build(table).search(KEY_SCOPE, "ada lovelace")).hits) == 1

    @pytest.mark.asyncio
    async def test_entity_type_narrows_the_candidates(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["ada@example.com"], entity_type="EMAIL_ADDRESS", session_id="s1")
        result = await build(table).search(KEY_SCOPE, "ada@example.com", entity_type="PERSON")
        assert (result.hits, result.scanned) == ((), 0)

    @pytest.mark.asyncio
    async def test_the_hit_carries_the_metadata_needed_to_act_on_it(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada"], subject_id="subject-a", session_id="sess-9")
        hit = (await build(table).search(KEY_SCOPE, "ada")).hits[0]
        assert (hit.entity_type, hit.session_id, hit.subject_id) == ("PERSON", "sess-9", "subject-a")

    @pytest.mark.asyncio
    async def test_it_reports_how_many_rows_it_scanned(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, [f"person {i}" for i in range(25)])
        assert (await build(table).search(KEY_SCOPE, "person 3")).scanned == 25

    @pytest.mark.asyncio
    async def test_it_walks_every_page_rather_than_stopping_at_the_first(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, [f"person {i:03d}" for i in range(25)])
        result = await build(table, page_size=10).search(KEY_SCOPE, "person 024")
        assert (len(result.hits), result.scanned) == (1, 25)

    @pytest.mark.asyncio
    async def test_paging_never_repeats_a_row(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada"] * 25)
        result = await build(table, page_size=10).search(KEY_SCOPE, "ada")
        assert len({hit.token for hit in result.hits}) == len(result.hits) == 25

    @pytest.mark.asyncio
    async def test_a_scan_wider_than_the_cap_is_refused_not_truncated(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, [f"person {i:03d}" for i in range(30)])
        refused = await build(table, candidate_cap=10, page_size=10).search(KEY_SCOPE, "person 000")
        assert isinstance(refused, SearchRefused)
        assert refused.limit == 10

    @pytest.mark.asyncio
    async def test_a_scan_inside_the_cap_still_runs(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, [f"person {i:03d}" for i in range(10)])
        assert isinstance(
            await build(table, candidate_cap=10, page_size=10).search(KEY_SCOPE, "person 000"), SearchResult
        )

    @pytest.mark.asyncio
    async def test_an_empty_scope_returns_no_hits_rather_than_an_error(self):
        result = await build().search(KEY_SCOPE, "ada")
        assert (result.hits, result.scanned) == ((), 0)

    @pytest.mark.asyncio
    async def test_a_database_outage_surfaces_instead_of_reading_as_no_matches(self):
        broken = build(OrderedFakeTable(error=RuntimeError("connection reset")))
        assert isinstance(await broken.search(KEY_SCOPE, "ada"), StoreUnavailable)

    @pytest.mark.asyncio
    async def test_a_missing_key_surfaces_rather_than_silently_finding_nothing(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada"])
        keyless = VaultSearch(
            repository=PiiVaultRepository(table=table),
            cipher=VaultCipher(keys=DerivedKeyProvider(secret="")),
        )
        assert isinstance(await keyless.search(KEY_SCOPE, "ada"), KeyUnavailable)

    @pytest.mark.asyncio
    async def test_a_row_sealed_under_another_scopes_key_is_not_matched(self):
        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada"])
        foreign = VaultSearch(
            repository=PiiVaultRepository(table=table),
            cipher=VaultCipher(keys=DerivedKeyProvider(secret="a-different-root")),
        )
        assert (await foreign.search(KEY_SCOPE, "ada")).hits == ()

    @pytest.mark.asyncio
    async def test_an_expired_row_is_never_returned(self):
        from datetime import datetime, timedelta, timezone

        table = OrderedFakeTable()
        await seed(table, KEY_SCOPE, ["Ada"])
        table.rows[0]["expires_at"] = datetime.now(timezone.utc) - timedelta(days=1)
        assert (await build(table).search(KEY_SCOPE, "ada")).hits == ()
