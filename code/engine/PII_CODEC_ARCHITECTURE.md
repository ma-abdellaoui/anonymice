# Encoding, Encryption, and Decryption Layer: Architecture Plan

Status: design for review. No code written yet.

Companion to `PII_ANONYMIZATION_PLAN.md`, which covers detection and the already-implemented scaffolding.
This document designs the layer that turns a detected span into a token and back again, for two use cases
with genuinely different lifetimes.

---

## Part 0: What the review of the existing code turned up

Five findings shaped this design. Three are opportunities to reuse infrastructure instead of building
parallel systems; two are defects in what is already implemented.

**The proxy already resolves a conversation identity.** `add_litellm_data_to_request` in
[litellm/proxy/litellm_pre_call_utils.py](litellm/proxy/litellm_pre_call_utils.py#L1195-L1250) populates
`data["litellm_session_id"]` from, in priority order, the `x-litellm-session-id` / trace headers, Anthropic's
`metadata.user_id`, and the W3C `baggage` header. Conversation scoping does not need a new identity concept;
it needs to read this one.

**The streaming framework already supports incremental rewrites.** `UnifiedLLMGuardrails` in
[unified_guardrail.py](litellm/proxy/guardrails/guardrail_hooks/unified_guardrail/unified_guardrail.py#L849)
drives any guardrail implementing `apply_guardrail` and, when `streaming_transform_mode` is
`"incremental_diff"`, emits the guardrail's rewritten text as synthetic deltas. The guardrail returns the full
mutated accumulated text plus `stream_holdback_chars`, and the framework emits only the forward-extension
prefix minus the holdback
([handler.py:639-691](litellm/llms/openai/chat/guardrail_translation/handler.py#L639-L691)). The default is
`"block_only"`, which silently **drops** text rewrites on the streaming path.

This matters twice over. It is the mechanism for decoding tokens split across chunks, and it means the
existing Presidio guardrail's approach of buffering the entire stream and re-emitting it (destroying
time-to-first-token) is not something we need to copy.

**There is a precedent for scoped key derivation.** `_plugin_fernet` in
[litellm/proxy/plugin_routes.py](litellm/proxy/plugin_routes.py#L127-L136) derives a per-plugin key as
`HMAC-SHA256(LITELLM_SALT_KEY, plugin_name)` specifically so that compromising one scope's key yields nothing
about another's. The same shape works for per-scope PII keys.

**Defect: decode is a cascading substitution.** `decode_text` in
[litellm/pii/codec/transform.py:138](litellm/pii/codec/transform.py#L138) folds `str.replace` over the
resolved mapping. If one entity's restored plaintext happens to contain another entity's token text, the
later replace rewrites inside the already-restored value. Decode must be a single pass.

**Defect: nothing prevents a token colliding with literal input.** If the caller's own prompt contains the
literal string `<PERSON_1>` and we then mint `<PERSON_1>` for a real name, decode replaces both occurrences
and corrupts the caller's text.

---

## Part 1: The two paths

Everything below follows from one distinction.

| | Ephemeral (LLM path) | Persistent (endpoint path) |
|---|---|---|
| Question it answers | "hide this while the model reasons over it" | "hand me back a stable handle I can resolve later" |
| Lifetime | one request, or one conversation | until explicitly expired |
| Storage | in-memory / short-TTL cache | database |
| Plaintext at rest | never | never (encrypted, AAD-bound) |
| Failure of the store | fail the request | fail the decode |
| Who may resolve | the in-flight request itself | any principal inside the token's security scope |

They share one token grammar, one codec interface, and one service. They differ only in which store and
which scope resolver they are constructed with. That is the whole modularity story: the pieces already have
interfaces, so the two paths are two object graphs, not two implementations.

---

## Part 2: The encoding format

### 2.1 Requirements in tension

The format has to satisfy several things that pull against each other. Semantic context wants a descriptive
label. Token efficiency wants brevity. Collision resistance wants entropy. LLM-resistance wants a shape
models treat as an opaque literal. Entropy is the one that loses: a random string is exactly what damages
model reasoning, and it is also the most expensive in tokens.

### 2.2 Candidates

| Format | Semantics | Tokens | LLM-stable | Risk |
|---|---|---|---|---|
| `a3f9c2e1` | none | ~4 | high | destroys reasoning, model cannot tell a name from an IBAN |
| `PERSON_1` | good | ~3 | medium | collides with ordinary prose and identifiers |
| `[PERSON_1]` | good | ~5 | medium | markdown link syntax, renderers may eat it |
| `{{PERSON_1}}` | good | ~7 | high | templating shape models rarely touch, but costly |
| `<PERSON_1>` | good | ~5 | high | reads as a tag; safe in JSON without escaping |

### 2.3 Recommendation

Keep `<PERSON_1>`, and make the decoder tolerant rather than making the token exotic.

```
<{ENTITY}_{ordinal}>          ephemeral: <PERSON_1>, <EMAIL_ADDRESS_2>
<{ENTITY}:{handle}>           persistent: <PERSON:3f9c2e1b8d4a7f60>
<{ENTITY}>                    masked, irreversible by construction
```

The reasoning:

`<` and `>` need no escaping inside JSON strings, so tool-call arguments and structured outputs pass through
unharmed. The uppercase label carries the semantic context the model needs. The ordinal disambiguates
multiple entities of one category and stays stable for repeated occurrences of the same value. The shape is
already what Presidio and most PII proxies emit, so frontier models have seen it and treat it as a literal.

The masked form deliberately carries no ordinal or handle, so the token grammar does not match it. Masking is
irreversible because the parser cannot see it, not because we remembered not to store it.

### 2.4 Robustness comes from the parser, not the token

This is the central design choice. Rather than armouring the token with checksums or delimiters that cost
tokens on every single request, spend nothing on the wire and absorb distortion at parse time.

The strict grammar mints tokens. A separate tolerant matcher recognises them on the way back:

| Distortion | Example | Handling |
|---|---|---|
| Case change | `<person_1>` | normalise case before lookup |
| Internal whitespace | `< PERSON_1 >` | tolerate and strip |
| Markdown escaping | `\<PERSON_1\>` | strip backslashes before matching |
| Emphasis wrapping | `**<PERSON_1>**` | the token still matches inside |
| Possessive / plural | `<PERSON_1>'s` | unaffected, suffix is outside the token |
| Split across chunks | `<PERS` + `ON_1>` | holdback, see 5.2 |
| Truncated by max_tokens | `...<PERSON_` | left verbatim, never guessed |
| Never-issued token | `<PERSON_9>` | left verbatim |
| Label translated | `<PERSONNE_1>` | unresolvable, left verbatim; residual risk |

Two rules make every unhandled case safe. An unresolvable token is left verbatim rather than blanked or
guessed at, so the worst outcome is a visible placeholder instead of wrong content or a lost response. And
decode is single-pass, so a restored value can never be re-scanned.

I specifically recommend **against** the truncated-token prefix matching the existing Presidio guardrail does
in `_unmask_pii_text`. It guesses that a trailing partial token was a particular full token and substitutes
the plaintext. When the guess is wrong it emits the wrong person's name, which is a worse failure than
showing `<PERSON_`.

### 2.5 Collision prevention

Before minting, scan the source for anything the tolerant matcher would recognise and add it to an avoid-set.
Never mint a token in that set. Cost is one regex pass over text we are already scanning.

This makes the two collision directions both safe. A literal `<PERSON_1>` in the caller's input is never
minted, so it stays out of the mapping and decode leaves it alone. A minted token is by construction absent
from the original text, so decode cannot hit a false positive.

### 2.6 Entity vocabulary

Labels come from a fixed, closed vocabulary (`PiiEntityType` plus the four extended labels the piiranha map
introduces). A closed vocabulary means the tolerant matcher can anchor on known labels rather than accepting
any uppercase run, which sharply reduces false positives against ordinary text containing `<LIKE_THIS>`.

---

## Part 3: Ephemeral path

### 3.1 Scope

The user's requirement is that mappings live for "the request or conversation" and no longer. Both are
wanted, and they are genuinely different.

**Request scope** stores nothing beyond the request dict. It is correct for ordinary multi-turn chat, because
the proxy decodes the response before returning it, so the client's stored history holds real values and turn
two simply re-encodes from scratch. Ordinals may differ between turns, which is harmless for correctness.

Where request scope falls down is narrower than it first appears, but real:

- **Prompt caching.** Re-encoding each turn can shift ordinals in the prefix, invalidating the provider's
  cached prefix and raising cost and latency on exactly the long conversations where caching matters most.
- **Clients that echo tokens.** Any flow where the client retains the encoded form rather than the decoded
  one sends back tokens the next request cannot resolve.
- **Cross-turn coreference.** With per-turn ordinals the model cannot know that `<PERSON_1>` in turn three is
  the same individual as `<PERSON_1>` in turn one.

**Conversation scope** keys the mapping on `litellm_session_id`, which the proxy already resolves, and holds
it in `DualCache` under a short TTL. It fixes all three at the cost of holding PII in Redis for the
conversation's lifetime.

**Recommendation: configurable, defaulting to request.** Request scope is the better privacy posture and
correct for the common case, so it should be what you get without asking. Conversation scope is a documented
opt-in for deployments that care about prompt-cache economics or run token-echoing clients.

User scope and team scope are deliberately **not** offered on this path. Long-lived token stability across
conversations is a privacy regression: an attacker who learns that `<PERSON_1>` is a particular individual in
one conversation learns it in all of them. Cross-conversation stability is what the persistent path is for,
and it gets encryption at rest and an authorization check precisely because it accepts that risk knowingly.

### 3.2 Flow

```
request
  -> detect spans (rules, then NER per policy)
  -> partition by action: BLOCK -> reject | MASK -> <ENTITY> | ENCODE -> mint
  -> build avoid-set from literal token-shaped strings already in the text
  -> single splice pass over all messages, one shared token space
  -> write reversible entries to the scope's store
  -> forward to provider

response (non-streaming)
  -> single-pass tolerant scan
  -> resolve each distinct token against the store
  -> substitute; unresolved tokens left verbatim
  -> return

request scope only:
  -> mapping dies with the request dict, nothing to clean up
conversation scope:
  -> entries expire on TTL; no explicit deletion path required
```

### 3.3 Why nothing is persisted here

Even in conversation scope the store is a cache with a TTL, not the database. If Redis is not configured the
in-memory tier still satisfies single-worker deployments, and multi-worker deployments that want conversation
scope must run Redis. That is a deployment constraint worth stating plainly rather than papering over with a
DB write, because writing conversation PII to Postgres would quietly turn an ephemeral feature into a
retention liability.

---

## Part 4: Persistent path

### 4.1 Storage model

One new table, following the shape of `LiteLLM_ManagedFileTable` and `LiteLLM_MemoryTable`.

```prisma
model LiteLLM_PiiTokenTable {
  token_id        String   @id                 // the handle inside <PERSON:{handle}>
  entity_type     String
  ciphertext      String                       // AEAD blob, never plaintext
  key_version     Int      @default(1)
  algorithm       String   @default("aes-256-gcm")

  scope_type      String                       // key | user | team | organization
  scope_id        String                       // hashed key token, user_id, team_id, or organization_id
  session_id      String?                      // groups tokens minted by one /pii/encode call

  created_at      DateTime @default(now())
  created_by      String?
  expires_at      DateTime?
  last_accessed_at DateTime?

  @@index([scope_type, scope_id])
  @@index([session_id])
  @@index([expires_at])
}
```

`token_id` is the primary key and is what the token carries, so decode is a single indexed point lookup.

Storing `scope_type` and `scope_id` as columns rather than one nullable column per LiteLLM entity keeps the
authorization check a single comparison and avoids a five-way nullable-column table. `session_id` exists so a
caller can revoke or expire everything from one encode call in one statement.

### 4.2 Encryption at rest

| Approach | Rotation | Per-scope isolation | New infrastructure | Fit |
|---|---|---|---|---|
| Reuse `encrypt_value_helper` | re-encrypt everything | none, one global key | none | weakest |
| Envelope with KMS/Vault KEK | clean | yes | KMS dependency, per-row call | strongest, heaviest |
| Per-scope derived key + version | lazy | yes | none | recommended |

**Recommendation: per-scope derived keys, with a provider interface so envelope encryption can replace it.**

```
key = HKDF-SHA256(
    ikm  = LITELLM_SALT_KEY (falling back to master_key, as the existing helpers do),
    salt = "litellm-pii-v1",
    info = f"{scope_type}:{scope_id}:{key_version}",
)
```

HKDF rather than the bare single-pass SHA-256 that `_derive_key` uses today. The existing helper documents its
own derivation as a known limitation kept for backward compatibility with already-written data; new data has
no such constraint, so it should not inherit the weakness.

Encrypt with AES-256-GCM and bind the ciphertext with **AAD = `token_id | scope_type | scope_id | key_version`**.
This is cheap and buys a real property: a row copied into another scope, or a token_id swapped between rows,
fails to decrypt rather than silently resolving. Authorization is then enforced by cryptography as well as by
the query.

Rotation is lazy. Bumping the configured version makes new writes use it; reads use whatever version the row
names. No migration window, no big-bang re-encryption. A background re-wrap job can be added later without
changing the format.

### 4.3 Key management interface

```python
class PiiKeyProvider(Protocol):
    def current_version(self) -> int: ...
    def key_for(self, scope: TokenScope, version: int) -> bytes | KeyUnavailable: ...
```

Two implementations ship: `DerivedKeyProvider` (the default above) and `SecretManagerKeyProvider`, which
fetches per-scope KEKs through LiteLLM's existing `BaseSecretManager` so AWS Secrets Manager, Vault, Google,
and CyberArk all work with no new integration code. Deployments needing HSM-backed keys implement the
protocol; nothing else in the system changes.

### 4.4 Authorization

Reuse the LiteLLM hierarchy rather than inventing one. `UserAPIKeyAuth` already carries `api_key`, `user_id`,
`team_id`, `organization_id`, and `permissions`.

Minting picks a scope, defaulting to `key`, the most restrictive:

| `scope_type` | `scope_id` | Who may decode |
|---|---|---|
| `key` | `hash_token(api_key)` | only the exact virtual key that minted it |
| `user` | `user_id` | any key belonging to that user |
| `team` | `team_id` | any key on that team |
| `organization` | `organization_id` | any key in that organization |

A caller may only mint at a scope they belong to, so a key cannot create a team-visible token for a team it is
not on.

Decode requires two things: the `allow_pii_decode` key permission (already implemented), and scope
membership. Proxy admin does **not** implicitly decode everything; a separate `allow_pii_decode_any`
break-glass permission exists and every use of it writes an audit entry. Silent admin access to a PII vault is
the kind of capability that should have to be turned on deliberately.

Every decode is auditable through the existing `LiteLLM_AuditLog` table. Recording reads, not just writes, is
the point of a vault.

### 4.5 Retention

`expires_at` is set from a configurable default TTL and enforced two ways: filtered in the read query so an
expired row can never resolve even if cleanup is behind, and swept by a periodic job registered through the
existing `LiteLLM_CronJob` machinery. A `DELETE /pii/session/{session_id}` route gives callers explicit
revocation, which is a requirement in most jurisdictions and cheap to provide given the index.

---

## Part 5: Cross-cutting concerns

### 5.1 Interfaces

The existing protocols stay. Three are added, and one existing responsibility is split out.

```
TokenGrammar        mint / parse / tolerant-match / avoid-set     (new: format, split out of the codec)
PiiCodec            span + grammar -> token, token -> value       (exists)
PiiTokenStore       put_many / get_many                           (exists; get_many is new, see 5.4)
PiiKeyProvider      scope + version -> key material               (new)
ScopeResolver       UserAPIKeyAuth + request -> TokenScope        (new)
PiiVaultRepository  the DB table, behind PrismaTableRepository    (new)
```

Splitting `TokenGrammar` out of `PiiCodec` is what makes the format replaceable on its own. Today the
placeholder and handle codecs each hard-code their own string shape; after the split they differ only in
which grammar variant they mint, and changing the wire format touches one file.

### 5.2 Streaming

Set `streaming_transform_mode = "incremental_diff"` and `mask_response_content = True` on the guardrail, and
return `stream_holdback_chars` from `apply_guardrail`.

Holdback per choice is the length of the longest suffix of the accumulated text that could still grow into a
token: scan back from the end for a `<` with no closing `>`, cap it at the maximum possible token length.
Everything before that point is safe to emit. A token split across chunk boundaries is therefore held until
complete, decoded, and emitted, with no whole-response buffering and no time-to-first-token penalty.

Note the framework's `streaming_sampling_rate` defaults to 5. Because the guardrail re-derives the full
accumulated text each round, sampling affects only emission granularity, never correctness. It is worth
lowering for this guardrail to keep the stream feeling responsive.

### 5.3 Tool calls, structured output, JSON

`GenericGuardrailAPIInputs` already carries `tool_calls` and `structured_messages` alongside `texts`; the
current guardrail only handles `texts` and must be extended. Tool-call arguments are JSON strings, and since
`<` and `>` require no JSON escaping, encoding inside them preserves validity.

One genuine limitation to state rather than hide: a request using `response_format: json_schema` with a
strict format constraint, such as a field declared as `"format": "email"`, will reject `<EMAIL_ADDRESS_1>`
because it is not a valid email. No token format solves this. The mitigation is a per-field or per-entity
opt-out, and the limitation should be documented, not engineered around.

### 5.4 Batch resolution

Decode currently resolves tokens one at a time. On the persistent path that is one indexed query per token,
so a response with twenty tokens is twenty round trips. `PiiTokenStore` needs `get_many` so decode is a single
`WHERE token_id IN (...)` filtered by scope and expiry. Worth doing before the vault ships, not after.

### 5.5 Provider compatibility

Nothing in the format is provider-specific, and mappings key on scope rather than on model or provider, so a
retry that falls back from one provider to another still decodes. The per-surface translation handlers the
proxy already owns mean chat completions, Anthropic messages, Responses, MCP, and realtime all reach the same
`apply_guardrail`.

### 5.6 Edge cases

Beyond the distortion table in 2.4:

- **Cascading substitution.** Fix `decode_text` to a single-pass regex substitution with a replacement
  function. This is a correctness bug in the code as it stands today.
- **Encode failure after a partial store write.** Write the mapping before returning the encoded text, and
  fail the whole request if the write fails. Never hand back a token that cannot be resolved.
- **Store outage during decode.** Surface it. Returning tokenized text on a store outage looks like success
  to the caller and is indistinguishable from a response that genuinely contained no PII.
- **`n > 1` choices.** Handled by the framework's per-choice accumulation, provided holdback is returned
  per choice in the same index order the texts arrived in.
- **A PII value that is itself token-shaped.** Handled by single-pass decode; a restored value is never
  rescanned.
- **Two workers, conversation scope, no Redis.** In-memory tiers diverge and turn two cannot resolve turn
  one's tokens. Validate at startup and refuse to enable conversation scope without a shared cache rather
  than failing intermittently in production.

---

## Part 5b: Known limits of the detection stages

Measured on the running stack, not inferred. Recorded here because each one is a
place where the system under-detects rather than errs, which is the failure mode
that does not announce itself.

### 5b.1 The NER model is context-sensitive

Piiranha's prediction depends on surrounding text, not just the name. The same
name in two prompts:

| Text | Result |
|---|---|
| `My name is Ada Lovelace and my email is ada@example.com` | `PERSON`, score 0.96 |
| `My name is Ada Lovelace. Reply with ONLY that name spelled backwards.` | nothing |

The stage ran in both cases. The model simply did not predict it in the second,
and that prompt reached the provider carrying the real name. A bare
`Ada Lovelace` with no sentence around it is also missed.

Presidio's spaCy recognizer detects the same name at 0.85 in every one of those
phrasings, but stage 1 deliberately excludes NER entities so a Presidio
deployment cannot silently return model results from the rules stage (see
`presidio_rules.py`). The two detectors have complementary blind spots and today
only one of them is consulted for names.

Three ways out, in rough order of cost. Run several model stages and take the
union, which needs `CascadingDetector` to hold a sequence rather than one
optional stage. Lower `LITELLM_PII_NER_SCORE_THRESHOLD`, which is cheap and
buys recall with false positives. Or accept the limit. Nothing here is decided.

### 5b.2 Swapping the model is easy; swapping its vocabulary is not

`PiiDetector` is a one-method protocol and `PiiranhaDetector` speaks the generic
HuggingFace token-classification contract, so pointing `LITELLM_PII_NER_API_BASE`
at another server of the same shape needs no code change.

The labels are the catch. `map_label` translates Piiranha's vocabulary and
returns `None` for anything it does not recognize, and the detector drops those
spans. A standard CoNLL model emitting `PER` / `LOC` / `ORG`, which is the most
likely substitute, would therefore detect everything and report nothing, with no
error anywhere. A per-model label map, and a loud unmapped label, should come
before anyone swaps the model.

Two smaller constraints alongside it: the detector is constructed in exactly one
place with no registry (`config.py`), and `CascadingDetector` holds exactly two
stages, so a third model cannot be added without changing that class.

## Part 6: Implementation plan

Six phases. Each leaves the tree working, is independently reviewable, and carries its own tests. Phases A
through C need no database and harden the path every request already takes; the vault does not exist until
phase D.

**Status.** Phases A through G are complete. Live verification against
real Presidio and real piiranha found two defects the fake-injected tests could not: streaming never decoded
at all, and piiranha's spans include the leading whitespace. Both are fixed and covered. Nothing has yet run
against a real LLM provider.

### Phase A: correctness fixes to shipped code

These are defects in code already merged, not new features, so they go first.

- [x] `decode_text`: replace the `str.replace` fold with a single-pass regex substitution using a replacement
      callback, so a restored value can never be rescanned by a later token
- [x] Regression test: entity A whose plaintext contains entity B's literal token text round-trips correctly
- [x] Collision avoid-set: scan the source for token-shaped literals before minting and never mint one
- [x] Regression test: input containing a literal `<PERSON_1>` is not corrupted when a real name is encoded
- [x] `PiiTokenStore.get_many` so decode resolves N tokens in one round trip instead of N
- [x] `DualCacheStore.get_many`, `RequestScopedStore.get_many`

### Phase B: token grammar

- [x] `litellm/pii/codec/grammar.py`: `TokenGrammar` protocol, mint / parse / tolerant-match / avoid-set
- [x] Move format strings out of `PlaceholderCodec` and `HandleCodec` so they differ only by grammar variant
- [x] Tolerant matcher covering every distortion in 2.4 (case, whitespace, backslash escaping, emphasis)
- [x] Anchor matching on the closed entity vocabulary to keep false positives off ordinary `<LIKE_THIS>` text
- [x] Table-driven tests, one case per distortion row, plus negative cases that must not match
- [x] Explicitly assert a truncated trailing token is left verbatim and never prefix-guessed

### Phase C: ephemeral path hardening

- [x] `ScopeResolver`: `UserAPIKeyAuth` plus request to `TokenScope`
- [x] Read `litellm_session_id` for conversation scope rather than inventing an identity
- [x] `pii_mapping_scope` config: `request` (default) or `conversation`
- [x] Startup validation: refuse conversation scope without a shared cache, rather than diverging per worker
- [x] Set `streaming_transform_mode = "incremental_diff"` and `mask_response_content = True`
- [x] Holdback computation: longest trailing substring that could still grow into a token
- [x] Return `stream_holdback_chars` per choice, in the index order the texts arrived in
- [x] Streaming tests: split a token at every byte offset and assert the round trip
- [x] Streaming tests: `n > 1` choices, and a token split across the final chunk boundary
- [x] Extend `apply_guardrail` past `texts` to `tool_calls`. `structured_messages` needs no work: no
      handler writes it back, and its text already arrives in `texts`, which is rewritten
- [x] Test: encoding inside tool-call JSON arguments keeps the JSON valid

### Phase D: key management

- [x] `PiiKeyProvider` protocol: `current_version`, `key_for(scope, version)`. `key_for` is async:
      `BaseSecretManager`'s read is async, and a sync protocol would force that implementation to block
- [x] `DerivedKeyProvider`: HKDF-SHA256 over `LITELLM_SALT_KEY`, info bound to scope and version
- [x] `SecretManagerKeyProvider` over the existing `BaseSecretManager`
- [x] AES-256-GCM with AAD = `token_id | scope_type | scope_id | key_version`
- [x] Test: a ciphertext moved to another scope, or another `token_id`, fails to decrypt
- [x] Test: a row written at version 1 still decrypts after the current version moves to 2
- [x] Cache the AESGCM object per `(scope, key_version)`; HKDF is the expensive part, not the cipher

### Phase E: the vault

- [x] `LiteLLM_PiiTokenTable` added to all three `schema.prisma` files, verified identical
- [x] Migration generated per `litellm-proxy-extras/migration_runbook.md`
- [x] `PiiVaultRepository` on `PrismaTableRepository`
- [x] `DatabaseTokenStore` with batched `get_many`. Deliberately not a `PiiTokenStore`: that protocol carries
      the ephemeral `TokenScope`, and these operations need the vault scope, entity type, and session id
- [x] Scope authorization: `key` / `user` / `team` / `organization`, minting restricted to scopes the caller
      belongs to
- [x] Test: a key cannot mint a `team` token for a team it is not on
- [x] Test: each scope level resolves for members and refuses for non-members
- [x] `allow_pii_decode_any` break-glass, off by default, audited on every use
- [x] Audit entries on decode via `LiteLLM_AuditLog`, on `/pii/decode` and on subject export
- [x] `expires_at` filtered in the read query, not only swept, so a late sweep never resolves a dead row
- [x] Expiry sweep registered on the proxy scheduler, single-flighted through the existing
      `PodLockManager` rather than a second locking mechanism
- [x] `subject_id` column, written by the store and defaulted from the request's `end_user_id`
- [x] `DELETE /pii/session/{session_id}`, `DELETE /pii/subject/{subject_id}`, and
      `GET /pii/subject/{subject_id}`. Erasure needs scope membership; export is a bulk decode, so it needs
      the decode grant and is audited
- [x] Fail the encode request if the mapping write fails; never return an unresolvable token

### Phase F: search

- [x] `PiiSearchIndex` protocol with `NullSearchIndex` as the default that stores nothing
- [x] `POST /pii/search`: filter on scope, `entity_type`, optional `subject_id`, then decrypt and compare
- [x] Keyset pagination in batches of roughly a thousand; never materialize the whole scope
- [x] Run decrypt-and-compare in a thread pool so bulk AES does not stall the event loop. The sync decrypt
      is split out of `VaultCipher.unseal` so one key is derived per version per page, not one per row
- [x] Configurable candidate cap that refuses the query rather than stalling
- [x] Exact, case-insensitive, accent-folded, and substring matching
- [x] `allow_pii_search` permission, separate from `allow_pii_decode`
- [x] Audit entry per query recording scope and entity type, never the query string
- [x] Test: search is confined to the caller's scope and finds nothing from another

### Phase G: UI

- [x] Scope and retention controls on the anonymization page. Scope is a live request parameter on the
      playground and on every vault action; retention and the rest of the vault configuration are documented
      on the Configuration tab, since they are environment settings with no write API
- [x] Session browser showing token metadata and never plaintext. Needed a new metadata-only
      `GET /pii/session/{session_id}`, which returns no value and no ciphertext, and so requires scope
      membership rather than the decode grant
- [x] Search panel gated on `allow_pii_search`. The server enforces the permission; the panel renders the
      refusal as an explanation of which permission is missing rather than a generic error

### Cross-cutting

- [x] `make check` clean, budget files ratcheted with `make lint-budget-update`. It was passing vacuously:
      the scope is computed from git's repo-relative paths while every pattern is engine-relative, so in this
      fork nothing matched and nothing ran. `make lint-format-check-changed` had the same fault. Both now
      rebase onto the engine root, which is what surfaced 36 unformatted files and 580 lines of stale
      dashboard API types
- [x] Live proof against real Presidio and a real LLM provider, through the guardrail, covering encode,
      decode and mid-stream holdback. Verified on a streaming ChatGPT-subscription call: asked to spell the
      input backwards, the model answered `>1_SSERDDA_LIAME<`, so it received `<EMAIL_ADDRESS_1>` and never
      the address, while the caller got the real value back. `CREDIT_CARD: BLOCK` refused its request.
      Tool-call arguments are still only covered by tests
- [ ] Deploy the piiranha NER stage. Stage 1 is deliberately restricted to Presidio's pattern and checksum
      recognizers, so `PERSON` and other NER entities are not detected until `pii_ner_api_base` is set. A
      deployment running rules only will pass names through untouched
