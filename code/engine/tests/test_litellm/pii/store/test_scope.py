from litellm.pii.store.base import TokenScope
from litellm.pii.store.scope import REQUEST_SESSION_ID, MappingScope, ScopeResolver


class TestRequestScope:
    def test_it_is_the_default(self):
        assert ScopeResolver().mapping_scope is MappingScope.REQUEST

    def test_every_request_shares_one_session_id_so_nothing_outlives_the_request(self):
        resolver = ScopeResolver()
        assert resolver.resolve("sk-a", "session-1").session_id == REQUEST_SESSION_ID
        assert resolver.resolve("sk-a", "session-2").session_id == REQUEST_SESSION_ID

    def test_the_session_id_is_ignored_entirely(self):
        resolver = ScopeResolver()
        assert resolver.resolve("sk-a", "session-1") == resolver.resolve("sk-a", "session-2")

    def test_two_keys_still_get_separate_namespaces(self):
        resolver = ScopeResolver()
        assert resolver.resolve("sk-a", None).namespace != resolver.resolve("sk-b", None).namespace

    def test_it_needs_no_shared_cache(self):
        assert ScopeResolver().needs_shared_cache() is False


class TestConversationScope:
    def test_the_session_id_becomes_the_scope(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        assert resolver.resolve("sk-a", "session-1").session_id == "session-1"

    def test_two_conversations_on_one_key_do_not_share_tokens(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        assert resolver.resolve("sk-a", "session-1") != resolver.resolve("sk-a", "session-2")

    def test_one_conversation_is_stable_across_turns(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        assert resolver.resolve("sk-a", "session-1") == resolver.resolve("sk-a", "session-1")

    def test_another_key_cannot_reach_the_same_conversation(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        first = resolver.resolve("sk-a", "session-1")
        second = resolver.resolve("sk-b", "session-1")
        assert first.session_id == second.session_id
        assert first.namespace != second.namespace

    def test_a_request_without_a_session_id_falls_back_to_request_scope(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        assert resolver.resolve("sk-a", None).session_id == REQUEST_SESSION_ID

    def test_an_empty_session_id_is_treated_as_absent(self):
        resolver = ScopeResolver(mapping_scope=MappingScope.CONVERSATION)
        assert resolver.resolve("sk-a", "").session_id == REQUEST_SESSION_ID

    def test_it_needs_a_shared_cache(self):
        assert ScopeResolver(mapping_scope=MappingScope.CONVERSATION).needs_shared_cache() is True


class TestNamespacing:
    def test_an_anonymous_caller_is_namespaced_separately_from_a_keyed_one(self):
        resolver = ScopeResolver()
        assert resolver.resolve(None, None) != resolver.resolve("sk-a", None)

    def test_the_raw_key_never_appears_in_the_scope(self):
        scope = ScopeResolver(mapping_scope=MappingScope.CONVERSATION).resolve("sk-super-secret", "s1")
        assert "sk-super-secret" not in scope.cache_key("<PERSON_1>")

    def test_the_resolved_scope_is_the_type_the_stores_take(self):
        assert isinstance(ScopeResolver().resolve("sk-a", None), TokenScope)
