# Handover: implementing the PII codec architecture

You are picking up an in-progress feature in a hard fork of LiteLLM. This document tells you where things
stand, what is already decided, what will break the moment you run the tooling, and where to start.

Read this first, then `PII_CODEC_ARCHITECTURE.md`, which is the actual plan you are implementing.

---

## 1. Orientation

| | |
|---|---|
| Repo | `git@github.com:ma-abdellaoui/anonymice.git` |
| Engine lives at | `code/engine/` (a hard fork of LiteLLM) |
| Branch | `main` |
| Upstream | **none.** Deliberately disconnected from `BerriAI/litellm`. No remote, no shared history |
| Feature code | `code/engine/litellm/pii/` |
| Plan you are executing | `code/engine/PII_CODEC_ARCHITECTURE.md`, Part 6 |
| Background on detection | `code/engine/PII_ANONYMIZATION_PLAN.md` |

The fork is a snapshot of LiteLLM's tracked tree with the PII work committed on top. Because it is
disconnected, upstream security fixes and new model support will not arrive on their own.

All paths below are relative to `code/engine/` unless stated otherwise.

---

## 2. Read this before running any tooling

The fork inherited four things that reference LiteLLM's upstream repository and will fail here. None are
hard to fix; all of them will waste your time if you meet them cold.

**The three lint gates are broken by the move, and `--base origin/main` alone does not fix them.**
`scripts/ruff_strict_gate.py`, `scripts/type_discipline_gate.py`, and `scripts/type_check_gate.py` all set
`DEFAULT_BASE = "origin/litellm_internal_staging"`, which does not exist here. But changing only that is not
enough, and the failure it produces is misleading rather than obvious.

Each gate measures the base by creating a git worktree at the base ref and scanning `<worktree>/litellm`,
because upstream the engine sat at the repository root. Here the engine is at `code/engine/`, so that path
does not exist in the worktree, the base measures zero violations, and every pre-existing violation in the
tree is blamed on your change. Running it today reports things like `LIT001 ... this change added 22824`,
which is the entire codebase, not your diff.

The fix is to teach the gates the subdirectory prefix. In each of the three scripts, derive it once and use
it when scanning the base worktree:

```python
GIT_ROOT = Path(_run(["git", "rev-parse", "--show-toplevel"], cwd=REPO_ROOT).strip())
ENGINE_PREFIX = REPO_ROOT.relative_to(GIT_ROOT)   # "code/engine"
# then scan (worktree / ENGINE_PREFIX / TARGET) instead of (worktree / TARGET)
```

and set `DEFAULT_BASE = "origin/main"`. Verify with a no-op change: a clean tree must report zero added
violations. Until this is done the budget gates cannot tell your regressions from inherited ones, so treat
their output as meaningless rather than as a signal.

**`make lint` and `make check` fetch that branch.** `Makefile` target `lint-fetch-base` runs
`git fetch origin litellm_internal_staging`. It will fail. Change it to `origin main`, or set
`LINT_DEP_BASE=` to skip the fetch.

**`CLAUDE.md` still describes LiteLLM's contribution process.** Its coding conventions (section 3 below) are
still authoritative and you must follow them. Its *process* rules are not: it says to base PRs on
`litellm_internal_staging`, to prefix branches `litellm_`, and to follow
`.github/pull_request_template.md`. None of that applies. Ask the maintainer what the branching and review
convention is here rather than guessing from that file.

**The git root is above you.** The engine is a subdirectory of a larger repo. `git` commands run from
`code/engine/` operate on the whole `anonymice` repo, and there is no `.git` inside the engine. Scripts that
compute `REPO_ROOT` from `__file__` still resolve correctly, but anything reasoning about "the repository"
sees anonymice.

---

## 3. Environment

No virtualenv was copied and no dependencies are installed. Set that up yourself and install whatever you
turn out to need; the list below is a starting point, not an exhaustive one.

```bash
cd code/engine
uv sync --extra proxy --group dev --group proxy-dev
```

Run tests with the same flags. The proxy extras are not optional: without them
`import litellm.proxy.proxy_server` fails on a missing `websockets`, and without `proxy-dev` the shared
`tests/test_litellm/proxy/conftest.py` fails on a missing `prisma`. Other groups exist in `pyproject.toml`
(`ci`, `e2e-dev`) and individual suites pull packages from them; when something fails on a missing module,
install it rather than treating the failure as meaningful.

```bash
# the PII suites (fast, ~2 min)
uv run --extra proxy --group dev --group proxy-dev python -m pytest \
  tests/test_litellm/pii/ \
  tests/test_litellm/proxy/pii_endpoints/ \
  tests/test_litellm/proxy/guardrails/guardrail_hooks/pii_anonymizer/ -q

# lint (ruff works as-is; the budget gates do not, see section 2)
uv run ruff check litellm/pii/ && uv run ruff format litellm/pii/
```

One known-unrelated failure: `tests/test_litellm/proxy/guardrails/test_guardrail_coverage.py::test_secret_detection_redacts_multimodal_text_parts`
fails with `ModuleNotFoundError: No module named 'detect_secrets'`. That package lives in optional groups not
installed above. It is not caused by the PII work; install the extra or ignore it.

Detection needs Presidio and, optionally, an NER server. `litellm/pii/deploy/docker-compose.pii.yml` brings
both up. Everything currently tested uses injected fakes, so you can develop without them, but see section 6.

---

## 4. What already exists

`litellm/pii/` is a provider-agnostic package with no imports from `litellm.proxy`, so it is unit-testable
without a proxy.

```
types.py                frozen dataclasses, error unions
detection/              PiiDetector protocol, Presidio rules stage, piiranha NER stage,
                        cascade policy, pure span merge
codec/                  PiiCodec protocol, placeholder / handle / encrypted codecs,
                        action-aware wrapper, the encode+decode text transform
store/                  PiiTokenStore protocol, request-scoped and DualCache stores, AES-GCM cipher
service.py              PiiService: the single detect / encode / decode implementation
config.py               settings and object graph assembly
```

Two adapters sit on top, both thin, both delegating to `PiiService`:

- `litellm/proxy/pii_endpoints/endpoints.py`: `POST /pii/detect`, `/pii/encode`, `/pii/decode`
- `litellm/proxy/guardrails/guardrail_hooks/pii_anonymizer/`: the guardrail on the LLM path

Plus a dashboard page at `ui/litellm-dashboard/src/app/(dashboard)/anonymization/`.

**State, as measured before the move to this repo** (commit `5c02151` in the original checkout, on a tree
byte-identical to what is here): 194 PII tests passed, ruff was clean, the type-discipline gate was clean
against the old base, the UI added zero new type errors, and the wider
`tests/test_litellm/proxy/guardrails/` suite passed at 2469 with the one `detect_secrets` failure above.

None of that has been re-run since the move, and the budget gates cannot be meaningfully re-run until
section 2 is fixed. Re-establishing a green baseline is your first task: install what you need, run the PII
suites, and treat whatever you see as the real starting point rather than trusting these numbers.

---

## 5. Start here: two real defects

Phase A of the plan exists because reviewing the shipped code found two bugs. Fix these before adding
anything. Both have failing-test-first repro described in the plan.

**Decode is a cascading substitution.** `litellm/pii/codec/transform.py`, `decode_text` folds `str.replace`
over the resolved mapping. If one entity's restored plaintext contains another entity's token text, the later
replace rewrites inside the already-restored value. It must be a single-pass regex substitution with a
replacement callback.

**Nothing prevents a token colliding with literal input.** If the caller's prompt already contains the string
`<PERSON_1>` and we mint `<PERSON_1>` for a real name, decode replaces both and corrupts their text. Fix by
scanning the source for token-shaped literals before minting and never minting one that is already present.

---

## 6. What is not verified

Be honest about this rather than assuming the green test count means more than it does.

**Nothing has run against real Presidio or piiranha.** Every test injects a fake detector. The wire contracts,
Presidio's `/analyze` response shape and the HuggingFace token-classification output shape, are written from
documentation, not observation. Standing up the compose stack and confirming both parsers against real
responses is high-value and cheap, and should happen early.

**No end-to-end run against a real provider.** No request has actually been encoded, sent to a model, and
decoded on the way back.

**`make check` has never been run in this repo**, for the reasons in section 2.

**Streaming is designed but not implemented.** See below.

---

## 7. Non-obvious things about this codebase

These took real digging to find. They will save you a lot of time.

**Implementing `apply_guardrail` covers every API surface.** LiteLLM has per-surface translation handlers
(`litellm/llms/*/guardrail_translation/`) that extract texts, call your guardrail, and write results back.
Implementing that one method gets chat completions, Anthropic messages, Responses, MCP, and realtime. Do not
write per-surface parsing. This is why the guardrail is as small as it is.

**Incremental streaming already exists, but is off by default.** `UnifiedLLMGuardrails`
(`litellm/proxy/guardrails/guardrail_hooks/unified_guardrail/unified_guardrail.py`) drives any guardrail
through a holdback protocol: you return the full mutated accumulated text plus `stream_holdback_chars`, and
the framework emits only the forward-extension prefix minus the holdback. **`streaming_transform_mode`
defaults to `"block_only"`, which silently discards text rewrites on the streaming path.** Your guardrail
must set it to `"incremental_diff"`. This is the mechanism for decoding tokens split across chunks, and it is
why we do not buffer whole responses the way the stock Presidio guardrail does.

**Conversation identity already exists.** `litellm/proxy/litellm_pre_call_utils.py` populates
`data["litellm_session_id"]` from the `x-litellm-session-id` header, Anthropic's `metadata.user_id`, or W3C
baggage. Read it; do not invent a session concept.

**Guardrails are auto-discovered.** `get_guardrail_initializer_from_hooks` scans
`guardrail_hooks/*/__init__.py` for `guardrail_initializer_registry` and `guardrail_class_registry`. Adding a
directory is enough; the hardcoded registry needs no edit.

**Config forms are generated from Pydantic.** `GET /guardrails/ui/provider_specific_params` reflects over
each guardrail class's `get_config_model()`, so a good config model gets you most of the settings UI free.

**There is a precedent for scoped key derivation.** `litellm/proxy/plugin_routes.py` derives per-plugin keys
as `HMAC-SHA256(LITELLM_SALT_KEY, plugin_name)`. The vault keys follow that shape, upgraded to HKDF.

**Some files are force-tracked against `.gitignore`.** 192 files, including
`ui/litellm-dashboard/package.json`, match ignore patterns but are tracked. If you ever re-add a tree, use
`git add -f` or you will silently drop them.

---

## 8. Decisions already made

Do not re-litigate these. The reasoning is in `PII_CODEC_ARCHITECTURE.md`; the conclusions are:

- **Token format stays `<PERSON_1>`.** Robustness comes from a tolerant parser, not from armouring the token.
  Random strings are rejected because they destroy model reasoning and cost more tokens.
- **Unresolvable tokens are left verbatim.** Never blanked, never guessed. Truncated-token prefix matching
  (which stock Presidio does) is explicitly rejected: a wrong guess emits the wrong person's name.
- **Decode is single-pass.** A restored value is never rescanned.
- **Ephemeral scope defaults to request**, with conversation scope opt-in and refusing to start without a
  shared cache.
- **Persistent scope defaults to `key`**, the most restrictive. Widening to team or organization is a
  deliberate per-request choice, and a caller can only mint at a scope they belong to.
- **Retention 30 days**, filtered in the read query as well as swept.
- **Vault encryption: per-scope HKDF-derived keys**, AES-256-GCM, AAD bound to
  `token_id | scope_type | scope_id | key_version`, lazy version-based rotation.
- **Admin decode is break-glass:** a separate `allow_pii_decode_any`, off by default, audited.
- **Search is filtered exhaustive scan, not a blind index.** `entity_type` is the only column added for it.
  Blind indexes and deterministic encryption are documented and rejected; do not add a plaintext column
  derived from a value without re-reading section 7.4 of the plan.

---

## 9. Coding conventions that still apply

`CLAUDE.md` in this directory is authoritative for code style even though its process rules are stale. The
ones that bite hardest here:

- No comments unless they explain genuinely complex business logic, or are tool directives, or are
  TODO/FIXME. The existing PII code follows this; match it.
- Annotate every variable `: Final` (LIT010). Never rebind or mutate parameters (LIT011). `ReadOnly[...]` on
  every TypedDict field (LIT012).
- Prefer immutable construction: comprehensions into `tuple()` / `frozenset()` / `MappingProxyType()` rather
  than seeding an empty collection and mutating (LIT001, LIT002).
- Every suppression names its rule and carries a reason: `# mutable-ok: <reason>`, `# kwargs-ok: <reason>`.
  `# type: ignore` is banned outright (LIT009).
- Model failures as values and map them to exceptions once at the boundary with an exhaustive `match` plus
  `assert_never`. `litellm/pii/types.py` and the endpoints' `_public_message` show the pattern.
- Dependency injection over monkeypatching. The endpoint tests use FastAPI `dependency_overrides`; the
  detector tests inject fakes. Do not reach for `monkeypatch.setattr` on a class attribute.
- Line length 120.
- Tests live in `tests/test_litellm/` mirroring the source path. Write tests that fail if the logic is
  mutated, not tests that only raise coverage. The existing suite was spot-checked with deliberate mutations
  and caught all of them; keep that bar.

When you fix violations gated by the budget files, run `make lint-budget-update` so the ceilings ratchet down
(subject to the base-branch fix in section 2).

---

## 10. Where to start

Work through `PII_CODEC_ARCHITECTURE.md` Part 6 in order. Phases A through C need no database.

1. Set up the environment and install whatever the suites need until they run cleanly.
2. Fix the section 2 tooling breakages so the budget gates produce a real signal.
3. Phase A: the two defects in section 5, plus `get_many` on the store protocol.
4. Stand up `docker-compose.pii.yml` and verify both detector parsers against real responses (section 6).
5. Phase B: extract `TokenGrammar` and build the tolerant matcher.
6. Continue through the plan.

Each phase leaves the tree working and is independently reviewable. Do not start the vault (Phase E) before
the ephemeral path is correct: it is on the critical path of every request, and the vault is not.

Four open questions in the plan were answered by the maintainer and are recorded in Part 8. If you hit a
genuine fork in the road that the plan does not cover, ask rather than picking silently.
