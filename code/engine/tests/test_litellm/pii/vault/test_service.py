import pytest

from litellm.pii.codec.handle import HandleCodec
from litellm.pii.detection.cascade import CascadingDetector, NerStagePolicy
from litellm.pii.service import PiiService
from litellm.pii.store.dual_cache import DualCacheStore
from litellm.pii.types import DetectorKind, DetectorUnavailable, PiiSpan, StoreUnavailable
from litellm.pii.vault.scope import VaultScope, VaultScopeType
from litellm.pii.vault.service import DecodedBatch, VaultService

from .test_store import FakeTable, build_store

KEY_SCOPE = VaultScope(VaultScopeType.KEY, "key-alice")
OTHER_SCOPE = VaultScope(VaultScopeType.KEY, "key-bob")


class SubstringDetector:
    def __init__(self, *needles, entity_type="PERSON", error=None):
        self.needles = needles
        self.entity_type = entity_type
        self.error = error

    async def detect(self, text, language, entities):
        if self.error is not None:
            return self.error
        return tuple(
            PiiSpan(
                entity_type=self.entity_type,
                start=text.index(needle),
                end=text.index(needle) + len(needle),
                score=0.95,
                detector=DetectorKind.RULES,
            )
            for needle in self.needles
            if needle in text
        )


def build_service(detector, store=None):
    return VaultService(
        pii=PiiService(
            detector=CascadingDetector(rules=detector, ner=None, policy=NerStagePolicy.NEVER),
            codec=HandleCodec(),
            store=DualCacheStore(cache=None),
        ),
        store=store or build_store(),
    )


class TestEncode:
    @pytest.mark.asyncio
    async def test_round_trips_through_the_vault(self):
        service = build_service(SubstringDetector("Ada"))
        encoded = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")
        assert "Ada" not in encoded.texts[0]

        decoded = await service.decode(texts=encoded.texts, scope=KEY_SCOPE)
        assert decoded.texts == ("hello Ada",)

    @pytest.mark.asyncio
    async def test_another_scope_cannot_resolve_the_token(self):
        service = build_service(SubstringDetector("Ada"))
        encoded = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")

        decoded = await service.decode(texts=encoded.texts, scope=OTHER_SCOPE)
        assert decoded.texts == encoded.texts
        assert "Ada" not in decoded.texts[0]

    @pytest.mark.asyncio
    async def test_the_row_carries_the_entity_type_and_the_subject(self):
        table = FakeTable()
        service = build_service(SubstringDetector("Ada"), store=build_store(table))
        await service.encode(
            texts=("hello Ada",),
            scope=KEY_SCOPE,
            session_id="s1",
            subject_id="end-user-7",
            created_by="user-alice",
        )
        assert (table.rows[0]["entity_type"], table.rows[0]["subject_id"]) == ("PERSON", "end-user-7")
        assert table.rows[0]["created_by"] == "user-alice"

    @pytest.mark.asyncio
    async def test_the_session_id_is_the_one_the_caller_supplied(self):
        service = build_service(SubstringDetector("Ada"))
        encoded = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")
        assert encoded.session_id == "s1"

    @pytest.mark.asyncio
    async def test_a_detection_failure_is_returned_rather_than_stored(self):
        table = FakeTable()
        outage = DetectorUnavailable(detector=DetectorKind.RULES, reason="down")
        service = build_service(SubstringDetector(error=outage), store=build_store(table))
        assert await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1") == outage
        assert table.rows == []

    @pytest.mark.asyncio
    async def test_a_write_failure_surfaces_so_no_unresolvable_token_is_returned(self):
        broken = build_store(FakeTable(error=RuntimeError("connection reset")))
        service = build_service(SubstringDetector("Ada"), store=broken)
        assert isinstance(
            await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1"), StoreUnavailable
        )

    @pytest.mark.asyncio
    async def test_clean_text_writes_nothing(self):
        table = FakeTable()
        service = build_service(SubstringDetector("Ada"), store=build_store(table))
        encoded = await service.encode(texts=("nothing here",), scope=KEY_SCOPE, session_id="s1")
        assert encoded.texts == ("nothing here",)
        assert table.rows == []

    @pytest.mark.asyncio
    async def test_one_token_space_is_shared_across_texts(self):
        service = build_service(SubstringDetector("Ada"))
        encoded = await service.encode(texts=("Ada wrote", "Ada signed"), scope=KEY_SCOPE, session_id="s1")
        assert encoded.texts[0].split()[0] == encoded.texts[1].split()[0]


class TestDecode:
    @pytest.mark.asyncio
    async def test_it_reports_how_many_tokens_it_resolved(self):
        service = build_service(SubstringDetector("Ada", "Grace"))
        encoded = await service.encode(texts=("Ada met Grace",), scope=KEY_SCOPE, session_id="s1")
        assert (await service.decode(texts=encoded.texts, scope=KEY_SCOPE)).resolved == 2

    @pytest.mark.asyncio
    async def test_an_unresolvable_token_is_not_counted(self):
        service = build_service(SubstringDetector("Ada"))
        decoded = await service.decode(texts=("hi <PERSON:deadbeef>",), scope=KEY_SCOPE)
        assert (decoded.texts, decoded.resolved) == (("hi <PERSON:deadbeef>",), 0)

    @pytest.mark.asyncio
    async def test_text_with_no_tokens_needs_no_query(self):
        table = FakeTable()
        service = build_service(SubstringDetector("Ada"), store=build_store(table))
        assert (await service.decode(texts=("plain text",), scope=KEY_SCOPE)).texts == ("plain text",)
        assert table.find_calls == 0

    @pytest.mark.asyncio
    async def test_a_read_outage_surfaces_instead_of_returning_tokenized_text(self):
        broken = build_store(FakeTable(error=RuntimeError("connection reset")))
        service = build_service(SubstringDetector("Ada"), store=broken)
        assert isinstance(await service.decode(texts=("hi <PERSON:deadbeef>",), scope=KEY_SCOPE), StoreUnavailable)


class TestErasureAndExport:
    @pytest.mark.asyncio
    async def test_revoking_a_session_makes_its_tokens_unresolvable(self):
        service = build_service(SubstringDetector("Ada"))
        encoded = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")

        assert await service.revoke_session(KEY_SCOPE, "s1") is None
        assert (await service.decode(texts=encoded.texts, scope=KEY_SCOPE)).texts == encoded.texts

    @pytest.mark.asyncio
    async def test_revoking_one_session_leaves_another_alone(self):
        service = build_service(SubstringDetector("Ada", "Grace"))
        first = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")
        second = await service.encode(texts=("hello Grace",), scope=KEY_SCOPE, session_id="s2")

        await service.revoke_session(KEY_SCOPE, "s1")
        assert (await service.decode(texts=first.texts, scope=KEY_SCOPE)).texts == first.texts
        assert (await service.decode(texts=second.texts, scope=KEY_SCOPE)).texts == ("hello Grace",)

    @pytest.mark.asyncio
    async def test_revoking_a_subject_erases_only_that_subject(self):
        service = build_service(SubstringDetector("Ada", "Grace"))
        mine = await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1", subject_id="subject-a")
        theirs = await service.encode(texts=("hello Grace",), scope=KEY_SCOPE, session_id="s2", subject_id="subject-b")

        await service.revoke_subject(KEY_SCOPE, "subject-a")
        assert (await service.decode(texts=mine.texts, scope=KEY_SCOPE)).texts == mine.texts
        assert (await service.decode(texts=theirs.texts, scope=KEY_SCOPE)).texts == ("hello Grace",)

    @pytest.mark.asyncio
    async def test_export_returns_the_plaintext_held_for_one_subject(self):
        service = build_service(SubstringDetector("Ada"))
        await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1", subject_id="subject-a")
        assert sorted((await service.export_subject(KEY_SCOPE, "subject-a")).values()) == ["Ada"]

    @pytest.mark.asyncio
    async def test_export_is_confined_to_the_callers_scope(self):
        service = build_service(SubstringDetector("Ada"))
        await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1", subject_id="subject-a")
        assert await service.export_subject(OTHER_SCOPE, "subject-a") == {}

    @pytest.mark.asyncio
    async def test_an_untagged_value_is_invisible_to_subject_export(self):
        service = build_service(SubstringDetector("Ada"))
        await service.encode(texts=("hello Ada",), scope=KEY_SCOPE, session_id="s1")
        assert await service.export_subject(KEY_SCOPE, "subject-a") == {}


class TestDecodedBatchContract:
    @pytest.mark.asyncio
    async def test_decode_returns_a_batch_not_a_bare_tuple(self):
        service = build_service(SubstringDetector("Ada"))
        assert isinstance(await service.decode(texts=("plain",), scope=KEY_SCOPE), DecodedBatch)
