# PII Anonymization Layer: Implementation Plan

Status: milestones 1-6 implemented. The encoding, encryption, and decryption layer is designed
separately in `PII_CODEC_ARCHITECTURE.md`, which supersedes the codec and storage decisions here
and carries the live implementation checklist.

## Goal

Add a reversible PII anonymization layer on top of LiteLLM:

1. Two-stage PII detection: Presidio rule/pattern recognizers as the primary layer, a small model-based (NER) detector as a second-stage fallback
2. A pluggable encode/decode + encryption seam, so detected PII is replaced with placeholders or encoded values on the way to the provider and restored on the way back
3. Three standalone HTTP endpoints (`detect`, `encode`, `decode`) exposing the exact same logic used internally, callable by a browser extension or any other client
4. A new Admin UI section for configuring and exercising all of the above

## Guiding principle

There is exactly one implementation of detect/encode/decode, in a provider-agnostic core package. The guardrail hook (in-band, on the chat completion path) and the REST endpoints (out-of-band, for the extension) are both thin adapters over that same service. Nothing is implemented twice.

---

## Part 1: What already exists in LiteLLM

Findings from reviewing the current codebase, so the plan builds on real seams rather than inventing new ones.

**Guardrail hook interface.** `CustomGuardrail` in [litellm/integrations/custom_guardrail.py](litellm/integrations/custom_guardrail.py) extends `CustomLogger` and exposes `async_pre_call_hook`, `async_post_call_success_hook`, `async_post_call_streaming_iterator_hook`, and a unified `apply_guardrail(inputs, request_data, input_type)`. `uses_apply_guardrail_interface()` (line 671) detects whether a subclass overrides `apply_guardrail`, and the proxy routes work through that unified path when it does.

**Existing Presidio guardrail.** [litellm/proxy/guardrails/guardrail_hooks/presidio.py](litellm/proxy/guardrails/guardrail_hooks/presidio.py) already does a simplified version of what we want: calls Presidio `/analyze` then `/anonymize`, and when `output_parse_pii=True` it builds numbered tokens (`<PERSON_1>`) plus a `pii_tokens` map, then unmasks on the way out. Critically, it handles the messy real-world parts we would otherwise have to rediscover: streaming SSE chunks, tool-call `arguments`, Anthropic-native message dicts, and Responses API `response.completed` events. We should reuse those response-walking patterns rather than write new ones.

Its main limits for our purposes:
- The token map lives in `request_data["metadata"]["pii_tokens"]`, so it is **request-scoped only**. It cannot serve a separate `/decode` HTTP call from a browser extension, and it does not survive across conversation turns.
- Detection is a single Presidio call. There is no rules-vs-model staging.
- Anonymization is delegated to Presidio's `/anonymize`; there is no seam for our own encoding or encryption.

**Guardrail auto-discovery.** `get_guardrail_initializer_from_hooks()` in [litellm/proxy/guardrails/guardrail_registry.py](litellm/proxy/guardrails/guardrail_registry.py) scans `guardrail_hooks/*/__init__.py` at startup for `guardrail_initializer_registry` and `guardrail_class_registry` dicts. [guardrail_hooks/pangea/__init__.py](litellm/proxy/guardrails/guardrail_hooks/pangea/__init__.py) is the canonical ~35-line template. Dropping a new directory registers a new guardrail with no edits to the hardcoded registry.

**Existing generic endpoint.** `POST /guardrails/apply_guardrail` ([guardrail_endpoints.py:2273](litellm/proxy/guardrails/guardrail_endpoints.py#L2273)) takes `guardrail_name` + `text` and calls that guardrail's `apply_guardrail`. It is registered in `LiteLLMRoutes.apply_guardrail_routes` ([_types.py:561](litellm/proxy/_types.py#L561)). Useful precedent for auth wiring, but its request/response shape (`{guardrail_name, text}` → `{response_text}`) is too narrow for our detect/encode/decode trio, which needs to return spans and token metadata.

**No custom-route plugin API.** All ~55 routers are hardcoded via `app.include_router(...)` at [proxy_server.py:17433-17473](litellm/proxy/proxy_server.py#L17433-L17473). Since we are building on top of LiteLLM in this repo, adding one more `include_router` line is the clean path (rather than the `LITELLM_WORKER_STARTUP_HOOKS` side-effect trick, which is only needed by out-of-tree plugins).

**UI structure.** Pages live at `ui/litellm-dashboard/src/app/(dashboard)/<page>/page.tsx` with co-located `_components/`. Nav is a static tree in [ui/litellm-dashboard/src/components/leftnav.tsx](ui/litellm-dashboard/src/components/leftnav.tsx) (guardrails entry at line 168). Provider config forms are **auto-generated** from Pydantic models: `GET /guardrails/ui/provider_specific_params` reflects over each registered guardrail class's `get_config_model()` ([guardrail_endpoints.py:1946](litellm/proxy/guardrails/guardrail_endpoints.py#L1946)) and the UI renders fields from the resulting schema. Defining a good config model gets us most of the settings UI for free.

**Existing PII vocabulary.** `PiiEntityType` (60+ entities), `PiiAction` (`BLOCK`, `MASK`), and `PII_ENTITY_CATEGORIES_MAP` already exist in [litellm/types/guardrails.py](litellm/types/guardrails.py). We extend rather than replace these.

---

## Part 2: Proposed architecture

### 2.1 Module layout

New provider-agnostic core package. No imports from `litellm.proxy`, so it is unit-testable without spinning up a proxy and reusable from anywhere:

```
litellm/pii/
├── types.py                    frozen dataclasses + error unions
├── detection/
│   ├── base.py                 PiiDetector protocol
│   ├── presidio_rules.py       stage 1: pattern recognizers
│   ├── presidio_ner.py         stage 2: model-based recognizers
│   ├── cascade.py              staging policy + span merge
│   └── spans.py                pure span-merge / overlap resolution
├── codec/
│   ├── base.py                 PiiCodec protocol
│   ├── placeholder.py          <PERSON_1> style, store-backed
│   ├── encrypted.py            AEAD token, self-contained  <-- the extension seam
│   └── registry.py
├── store/
│   ├── base.py                 PiiTokenStore protocol
│   ├── request_scoped.py       parity with today's presidio behavior
│   └── dual_cache.py           session-scoped, Redis-backed
└── service.py                  PiiService: detect / encode / decode
```

Proxy adapters (thin):

```
litellm/proxy/pii_endpoints/endpoints.py                       REST: /pii/detect, /pii/encode, /pii/decode
litellm/proxy/guardrails/guardrail_hooks/pii_anonymizer/       guardrail hook, auto-discovered
```

### 2.2 Core types

All frozen, slotted, fully typed. Failures modeled as values per the repo conventions, mapped to public exceptions once at the proxy boundary via an exhaustive `match` + `assert_never`.

```
PiiSpan            entity_type, start, end, score, detector (RULES | NER), text
DetectionResult    spans: tuple[PiiSpan, ...], stage_2_ran: bool
EncodedText        text, tokens: tuple[IssuedToken, ...], session_id
IssuedToken        token, entity_type, codec_id
DetectionError     AnalyzerUnavailable | AnalyzerInvalidResponse | ...
CodecError         UnknownToken | KeyUnavailable | DecodeFailed | ...
```

`PiiSpan` offsets always reference the **original** text. This matters: the current Presidio code has a comment at [presidio.py:439-442](litellm/proxy/guardrails/guardrail_hooks/presidio.py#L439-L442) about a past bug where anonymizer item positions (which reference the *output* text) were applied to the *input* text. We avoid that class of bug by construction, never mixing coordinate spaces.

### 2.3 Two-stage detection

**Stage 1 (rules, primary).** Presidio `/analyze` with `entities` restricted to the deterministic pattern-recognizer set: `CREDIT_CARD`, `EMAIL_ADDRESS`, `IBAN_CODE`, `IP_ADDRESS`, `PHONE_NUMBER`, `URL`, `CRYPTO`, `US_SSN`, and the country-specific ID types. High precision, no model, low latency.

**Stage 2 (model, fallback).** A **separate** Presidio analyzer deployment configured with a transformer or spaCy NLP engine, covering the entities rules cannot catch: `PERSON`, `LOCATION`, `ORGANIZATION`, `NRP`, and contextual `DATE_TIME`. Separate container rather than in-process transformers, so the proxy stays light and the NER tier scales independently.

Both stages speak the same Presidio `/analyze` HTTP contract, so `presidio_rules.py` and `presidio_ner.py` share one client and differ only in base URL and entity set.

**Staging policy** (config field `ner_stage_policy`), implemented in `cascade.py`:

| policy | behavior |
|---|---|
| `never` | rules only |
| `on_miss` (default) | run stage 2 only when stage 1 found nothing |
| `on_low_confidence` | run stage 2 when stage 1's max score is below a threshold |
| `always` | always run both, union the results |

`on_miss` is the default and matches the "fallback or backup" intent: most requests pay only the cheap rules call.

**Span merging.** When both stages fire, `spans.py` resolves overlaps as a pure, table-testable function: higher score wins; tie broken in favor of the rules detector; then the longer span. Deterministic and independently testable with no I/O.

**Failure policy.** Fail-closed by default when any entity is configured to `BLOCK` or `ENCODE`, mirroring the existing `_fail_on_invalid_response` logic at [presidio.py:311](litellm/proxy/guardrails/guardrail_hooks/presidio.py#L311). A detector being down must never silently pass PII through.

### 2.4 Codec seam (the encoding/encryption placeholder)

```python
class PiiCodec(Protocol):
    codec_id: str
    def encode(self, span: PiiSpan, ctx: EncodeContext) -> IssuedToken | CodecError: ...
    def decode(self, token: str, ctx: DecodeContext) -> str | CodecError: ...
```

Two implementations ship:

**`PlaceholderCodec`** — emits `<PERSON_1>`, `<EMAIL_ADDRESS_2>`. Requires a store to hold token → original. Behavioral parity with today's `output_parse_pii=True` path, so it is the safe default and makes milestone 1 shippable on its own.

**`EncryptedCodec`** — the extension point for your own scheme. Token carries its own ciphertext: `<PERSON:v1:base64url(nonce||ciphertext||tag)>`. Decode is **stateless** (no store lookup), which is what makes a browser extension able to call `/decode` in a completely separate request with no server-side session. Ships with a working AES-GCM reference implementation using `cryptography`, key resolved from `LITELLM_PII_ENCRYPTION_KEY` via the existing secret-manager path. Key management (rotation, per-tenant keys, KMS/HSM backing) is left as an explicit stub with a documented interface, since that is the part you said you want to design yourself.

**Tradeoff you should decide on (see Open Questions).** Long base64 tokens consume context window and measurably degrade model output quality, since the model sees opaque blobs instead of typed placeholders. My recommendation: `PlaceholderCodec` on the LLM-facing guardrail path, `EncryptedCodec` on the endpoint path where statelessness matters. The codec is per-call configurable, so both can coexist.

### 2.5 Token store

```python
class PiiTokenStore(Protocol):
    async def put(self, session_id: str, token: str, value: str) -> None | StoreError: ...
    async def get(self, session_id: str, token: str) -> str | StoreError: ...
```

- `RequestScopedStore` — writes to `request_data["metadata"]["pii_tokens"]`. Parity with today, zero infrastructure, single request only.
- `DualCacheStore` — keyed `pii:{session_id}:{token}` with a TTL, backed by the `DualCache` already injected into every guardrail hook. Redis-backed when configured, so it survives across requests and across proxy workers. **Required for the `/encode` → `/decode` endpoint pair to work.**

Security constraint to state plainly: the store holds **plaintext PII**. It must be TTL-bounded and, if Redis-backed, encrypted at rest. This is precisely the argument for `EncryptedCodec` on the extension path, where no plaintext ever leaves the proxy process.

### 2.6 PiiService: the single entry point

```python
class PiiService:
    def __init__(self, detector: PiiDetector, codec: PiiCodec, store: PiiTokenStore) -> None: ...
    async def detect(self, req: DetectRequest) -> DetectionResult | DetectionError: ...
    async def encode(self, req: EncodeRequest) -> EncodedText | DetectionError | CodecError: ...
    async def decode(self, req: DecodeRequest) -> str | CodecError: ...
```

Everything is constructor-injected, so unit tests pass fakes rather than monkeypatching (per repo conventions). Both adapters below call this and nothing else.

### 2.7 Adapter A: the guardrail hook

`litellm/proxy/guardrails/guardrail_hooks/pii_anonymizer/` following the pangea template. `PiiAnonymizerGuardrail(CustomGuardrail)`:

- `async_pre_call_hook` → `service.encode` over message content
- `async_post_call_success_hook` → `service.decode` over the response
- `async_post_call_streaming_iterator_hook` → `service.decode` over streaming chunks
- `apply_guardrail` → the unified interface, which also makes it work with the existing `/guardrails/apply_guardrail` endpoint and the UI test playground for free

Response-walking logic (tool calls, Anthropic dicts, SSE, Responses API events) is lifted from the existing Presidio guardrail. Per repo conventions on API fragmentation, this is extracted into a shared helper rather than duplicated, so both guardrails use one implementation.

Auto-discovery means no edit to `guardrail_registry.py`.

### 2.8 Adapter B: the REST endpoints

New `APIRouter` in `litellm/proxy/pii_endpoints/endpoints.py`:

```
POST /pii/detect   {text, language?, entities?}          -> {spans: [...], stage_2_ran: bool}
POST /pii/encode   {text, session_id?, codec?}           -> {encoded_text, tokens: [...], session_id}
POST /pii/decode   {text, session_id?}                   -> {decoded_text}
```

- Auth: `Depends(user_api_key_auth)`, same as every other management route
- Register a `pii_routes` list in [litellm/proxy/_types.py](litellm/proxy/_types.py) next to `apply_guardrail_routes` (line 561) and fold it into `llm_api_routes` so virtual keys can call it
- One line added at [proxy_server.py:17473](litellm/proxy/proxy_server.py#L17473): `app.include_router(pii_router)`
- CORS: the browser extension calls cross-origin. Existing `CORSMiddleware` at [proxy_server.py:2064](litellm/proxy/proxy_server.py#L2064) uses a configurable `origins` list, so this is a deployment config item, not new code. Worth verifying with a real extension origin before declaring done.

`/detect` and `/encode` are batch-capable (accept a list of texts) so the extension can do a page in one round trip instead of N.

### 2.9 UI

New page `ui/litellm-dashboard/src/app/(dashboard)/anonymization/` plus a nav entry in [leftnav.tsx](ui/litellm-dashboard/src/components/leftnav.tsx) alongside Guardrails (line 168), admin-gated.

Tabs:

1. **Detection** — rules analyzer URL, NER analyzer URL, staging policy, per-entity action and score threshold. Largely auto-rendered from the Pydantic config model; reuses the existing [pii_components.tsx](ui/litellm-dashboard/src/app/(dashboard)/guardrails/_components/pii_components.tsx) and [pii_configuration.tsx](ui/litellm-dashboard/src/app/(dashboard)/guardrails/_components/pii_configuration.tsx) entity pickers.
2. **Codec & Keys** — codec selection, key id, rotation status. Read-only against the stub until the real key management lands.
3. **Playground** — paste text, watch detect → encode → decode round-trip live against the three endpoints, with spans highlighted and each span labeled by which stage caught it. Modeled on [GuardrailTestPlayground.tsx](ui/litellm-dashboard/src/app/(dashboard)/guardrails/_components/GuardrailTestPlayground.tsx). This is the highest-value tab for tuning the staging policy.
4. **Sessions** (later) — inspect active token maps and TTLs. Admin-only, and it must **not** render plaintext PII by default.

Config persistence reuses the existing guardrail CRUD (`/guardrails/register`, `PATCH /guardrails/{id}`) since the anonymizer is registered as a guardrail. A `PiiAnonymizerConfigModel` in [litellm/types/guardrails.py](litellm/types/guardrails.py) drives the auto-generated form fields.

---

## Part 3: Changes to existing files

Deliberately small. Everything else is new files.

| File | Change |
|---|---|
| [litellm/types/guardrails.py](litellm/types/guardrails.py) | Add `PiiAnonymizerConfigModel`; add `ENCODE` to `PiiAction`; add `PII_ANONYMIZER` to `SupportedGuardrailIntegrations` |
| [litellm/proxy/_types.py](litellm/proxy/_types.py) | Add `pii_routes`; include in `llm_api_routes` |
| [litellm/proxy/proxy_server.py](litellm/proxy/proxy_server.py) | One `app.include_router(pii_router)` line |
| [litellm/proxy/guardrails/guardrail_hooks/presidio.py](litellm/proxy/guardrails/guardrail_hooks/presidio.py) | Extract response-walking helpers to a shared module; no behavior change |
| [ui/.../leftnav.tsx](ui/litellm-dashboard/src/components/leftnav.tsx) | One nav entry |
| [ui/.../networking.tsx](ui/litellm-dashboard/src/components/networking.tsx) | Three API client functions |

Note the guardrail registry is **not** in this list, thanks to auto-discovery.

---

## Part 4: Testing

Mirrored under `tests/test_litellm/pii/` and `tests/test_litellm/proxy/pii_endpoints/`, per `tests/test_litellm/readme.md`. Targeting a high mutation kill rate, so every test must fail if the logic it covers is broken:

- **Span merge** — table-driven over overlapping, nested, adjacent, and identical spans from both stages. Pure function, no I/O, exhaustive.
- **Staging policy** — inject fake stage-1/stage-2 detectors and assert stage 2 is *not* invoked under `on_miss` when stage 1 hits, and *is* invoked when it misses. Constructor injection, no monkeypatching.
- **Codec round-trip** — `decode(encode(text)) == text` for each codec, including multi-byte/emoji text (offset correctness), multiple entities of the same type, and adjacent spans.
- **Fail-closed** — analyzer returns 500 / non-JSON / malformed while a `BLOCK` entity is configured: assert the request is rejected, never passed through.
- **Endpoints** — auth rejection for an unauthorized key; `/encode` then `/decode` as two separate requests sharing a `session_id`; unknown token returns a typed error rather than leaking or crashing.
- **Guardrail integration** — pre_call encodes, post_call decodes, streaming decodes, tool-call arguments decoded.

Proof of fix will be curl commands against a live proxy on `localhost:4000` hitting real Presidio containers and a real provider, not pytest output.

---

## Part 5: Milestones

Each milestone is independently reviewable and leaves the tree working.

1. **Core detection** — `litellm/pii/types.py`, `detection/`, span merge, cascade policy. No proxy wiring. Fully unit tested.
2. **Codec + store** — both codecs, both stores, round-trip tests. Still no proxy wiring.
3. **PiiService + REST endpoints** — service, three endpoints, auth, route registration. First point where the browser extension can integrate.
4. **Guardrail hook** — auto-discovered guardrail directory, config model, shared response-walking helper extracted from the existing Presidio guardrail.
5. **UI** — page, nav, three tabs (Sessions deferred).
6. **Deployment** — docker-compose for the two Presidio analyzer tiers (rules + NER), documented env vars.

---

## Part 6: Open questions for you

These change the design materially, so I would rather ask than guess:

1. **Encryption scheme: deterministic or randomized?** Deterministic (same input always yields the same token) lets you correlate and cache across requests, but leaks equality: an attacker seeing two identical tokens learns the underlying values match. Randomized AEAD is safer but makes correlation impossible. Which do you need?
Answer: it should be randomized for external llm requistes and only for that perticial llm call, decrypt after we recice the repsons and thats it. 
the second case where we use the encoe/decode endpoints, we should keep a key value store of which what means what because decption hcna happen much later. 

2. **Token format on the LLM path.** Short typed placeholders (`<PERSON_1>`) keep model quality high; self-contained ciphertext tokens are stateless but long and opaque. My recommendation is the hybrid in 2.4, but confirm that split works for you.
answer: ok, sounds good. 

3. **Session identity for the extension.** How do `/encode` and `/decode` correlate across two separate HTTP calls? Client-supplied `session_id`, derived from the virtual key, or stateless via `EncryptedCodec` (my preference, since it sidesteps the plaintext store entirely)?
answer: do as you recoomend and based on my answers so far. 

4. **Which NER model?** Affects container size, latency, and language coverage. Options range from spaCy `en_core_web_lg` (fast, weaker) to a deidentification-tuned transformer (slower, stronger). Also: English-only or multilingual?
answer: maybe this one: https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information


5. **New `ENCODE` action.** `PiiAction` today is `BLOCK | MASK`. I propose adding `ENCODE` for reversible encoding, keeping `MASK` as today's irreversible redaction. Confirm that distinction is what you want.
answer: ok, do as reocmmended. 

6. **Scope of decode.** Should decode apply only to a response for a request the proxy itself encoded, or should any caller holding a valid token be able to decode it via `/pii/decode`? The second is what a browser extension needs, and it is a meaningfully larger exposure surface. It warrants its own key permission, which I would add as `allow_pii_decode`.
answer: do as recoomeded. not major changes, we will have another iteration after we finish this plan. 

---

## Part 7: Resolved decisions

Locked in from the answers above. Where an answer changed the original design, the change is called out.

**Two lifetimes, one service.** The answers split the system cleanly by lifetime, and that split drives everything else:

| | LLM path (guardrail) | Endpoint path (extension) |
|---|---|---|
| Lifetime | one LLM call, discarded after response | persists, decode can happen much later |
| Store | `RequestScopedStore` (request metadata) | `DualCacheStore` (Redis-backed, TTL) |
| Token form | `<PERSON_1>` typed placeholder | `<PERSON:{random_handle}>` |
| Correlation across calls | none by design | `session_id` |

**Encryption: randomized, never deterministic.** Both paths use randomized tokens, so identical inputs never produce identical tokens and no equality leak exists. On the LLM path the mapping dies with the request. On the endpoint path the mapping is persisted, with values **AEAD-encrypted at rest** so plaintext PII never sits readable in Redis.

*Change from the draft:* the draft proposed a stateless self-contained ciphertext token for the endpoint path. Answer 1 asks for a key-value store there instead, which is the better call: a short random handle keeps tokens small, the mapping stays revocable (delete the key and the token is dead), and key rotation does not strand old tokens. `EncryptedCodec` still ships as the self-contained seam for a future scheme, but it is not the default on either path.

**Session identity.** `session_id` is optional on `/pii/encode`; when omitted the server generates one and returns it. Store keys are namespaced by the hashed virtual key, so one key can never read another key's tokens even given a valid `session_id`.

**NER model: `iiiorg/piiranha-v1-detect-personal-information`.** This changes the stage-2 contract. Piiranha is a DeBERTa token-classification model, not a Presidio deployment, and it emits its own label vocabulary (`GIVENNAME`, `SURNAME`, `TELEPHONENUM`, `SOCIALNUM`, `IDCARDNUM`, `CITY`, `ZIPCODE`, ...) which does not match Presidio's `PiiEntityType`.

Two consequences:
- Stage 2 speaks the standard HuggingFace **token-classification pipeline** JSON contract (`{"inputs": text}` → `[{entity_group, score, word, start, end}]`) rather than Presidio's `/analyze`. That contract is served by HF Inference Endpoints, TorchServe, and a thin `transformers` wrapper alike, so we are not inventing a protocol.
- A frozen `PIIRANHA_LABEL_MAP` translates Piiranha labels into `PiiEntityType` (`GIVENNAME`/`SURNAME` → `PERSON`, `TELEPHONENUM` → `PHONE_NUMBER`, `SOCIALNUM` → `US_SSN`, `CITY`/`STREET`/`ZIPCODE` → `LOCATION`, and so on). Unmapped labels are dropped rather than passed through, so a model upgrade can never inject an unknown entity type.

The `PiiDetector` protocol absorbs this difference: both stages return `tuple[PiiSpan, ...]` regardless of wire format.

**`PiiAction.ENCODE`** added alongside `BLOCK` and `MASK`. `MASK` stays irreversible redaction; `ENCODE` is the new reversible path.

**Decode authorization.** Any caller holding a valid token may decode, gated by a new `allow_pii_decode` key permission and scoped to the calling key's namespace.

---

## Part 8: Implementation TODO

### Milestone 1: core detection
- [x] `litellm/pii/types.py` — `PiiSpan`, `DetectorKind`, `DetectionResult`, `DetectionError` union
- [x] `litellm/pii/detection/base.py` — `PiiDetector` protocol
- [x] `litellm/pii/detection/spans.py` — pure overlap resolution / merge
- [x] `litellm/pii/detection/presidio_rules.py` — stage 1 over Presidio `/analyze`
- [x] `litellm/pii/detection/ner_labels.py` — frozen label map, one per supported model
- [x] `litellm/pii/detection/piiranha.py` — stage 2 over HF token-classification
- [x] `litellm/pii/detection/cascade.py` — `NerStagePolicy` + `CascadingDetector`
- [x] tests: span merge table, staging policy with injected fakes, label mapping, fail-closed

### Milestone 2: codec + store
- [x] `litellm/pii/store/base.py`, `request_scoped.py`, `dual_cache.py` (AEAD at rest)
- [x] `litellm/pii/codec/base.py` — `PiiCodec` protocol
- [x] `litellm/pii/codec/placeholder.py` — `<PERSON_1>`
- [x] `litellm/pii/codec/handle.py` — `<PERSON:{handle}>`
- [x] `litellm/pii/codec/encrypted.py` — self-contained AEAD seam
- [x] tests: round-trip per codec incl. multibyte/adjacent/repeated spans, store isolation across keys

### Milestone 3: service + REST endpoints
- [x] `litellm/pii/service.py` — `PiiService.detect/encode/decode`
- [x] `litellm/proxy/pii_endpoints/endpoints.py` — the three routes
- [x] `_types.py` route registration + `allow_pii_decode` permission
- [x] `proxy_server.py` `include_router`
- [x] tests: auth rejection, cross-request encode→decode, cross-key isolation, unknown token

### Milestone 4: guardrail hook
- [x] ~~extract shared response-walking helpers out of `presidio.py`~~ not needed: implementing only
      `apply_guardrail` means the proxy's existing per-surface `guardrail_translation` handlers already
      extract and write back texts for chat completions, Anthropic messages, Responses, MCP, and realtime
- [x] `guardrail_hooks/pii_anonymizer/` (auto-discovered)
- [x] `PiiAnonymizerConfigModel` + `PiiAction.ENCODE` + `SupportedGuardrailIntegrations`
- [x] tests: pre_call encodes, post_call decodes, streaming, tool-call arguments

### Milestone 5: UI
- [x] `app/(dashboard)/anonymization/` page + nav entry
- [x] Detection / Codec / Playground tabs
- [x] `networking.tsx` client functions

### Milestone 6: deployment
- [x] docker-compose: Presidio rules tier + Piiranha inference tier
- [x] documented env vars (`litellm/pii/README.md`)
- [ ] `make check` clean, budget files updated

Superseded by `PII_CODEC_ARCHITECTURE.md`: the codec, token format, token store, and encryption
decisions in Parts 2.4 and 2.5 above. That document also records two defects found in the shipped
code (cascading decode substitution, and no collision avoid-set) which are Phase A there.
