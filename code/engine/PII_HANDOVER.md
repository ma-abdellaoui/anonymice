# Handover: implementing the PII codec architecture

Second handover. The first one described a tree where nothing had been re-verified after the move into this
repo; this one describes a tree where Phases A through D of the plan are done, Phase E is done through the
storage layer, and the tooling that was broken by the move has been fixed.

Read this, then `PII_CODEC_ARCHITECTURE.md`. Part 6 of that document is the checklist and it is now marked
up: `[x]` done, `[~]` partly done with a note saying exactly what is missing, `[ ]` not started.

---

## 1. Orientation

| | |
|---|---|
| Repo | `git@github.com:ma-abdellaoui/anonymice.git` |
| Engine lives at | `code/engine/` (a hard fork of LiteLLM) |
| Branch | `pii-codec-implementation`, branched from and merged with `main` |
| Upstream | **none.** Deliberately disconnected from `BerriAI/litellm` |
| Feature code | `code/engine/litellm/pii/` |
| Plan you are executing | `code/engine/PII_CODEC_ARCHITECTURE.md`, Part 6 |

All paths below are relative to `code/engine/` unless stated otherwise.

**`main` moves constantly.** Several PRs landed on it during the last session. Merge it in regularly; the
browser-extension work and the engine work touch disjoint files, so conflicts have not happened yet.

---

## 2. Run the tests with `-n 8`

This is the single most useful thing in this document.

```bash
uv run --extra proxy --group dev --group proxy-dev python -m pytest \
  tests/test_litellm/pii/ \
  tests/test_litellm/proxy/pii_endpoints/ \
  tests/test_litellm/proxy/guardrails/ -q -n 8
```

That is **8 seconds**. The same command without `-n 8` is **326 seconds**, for the same result.

`tests/test_litellm/conftest.py` has a module-scoped autouse fixture that calls `importlib.reload(litellm)`
and `importlib.reload(litellm.proxy.proxy_server)` once per test module. Those reloads are multi-second each,
and the fixture skips them entirely when `PYTEST_XDIST_WORKER` is set. xdist therefore both parallelises and
removes the reload, and the reload is most of the cost. Do not go back to serial runs for routine work.

Two failures are expected and unrelated: `test_guardrail_coverage.py::test_secret_detection_*` fail on
`ModuleNotFoundError: No module named 'detect_secrets'`, which lives in an optional group.

---

## 3. Tooling that was broken and is now fixed

The previous handover's section 2 is resolved. Do not redo this work.

**The four budget gates measured the base at zero.** Each scans a git worktree at the base ref, and upstream
the engine sat at the repository root. Here it is a subdirectory, so the scan found nothing, the base
measured zero, and every inherited violation was blamed on your change. `scripts/engine_layout.py` now
derives the `code/engine` prefix once and every gate scans `<worktree>/code/engine`. `DEFAULT_BASE` is
`origin/main`. Verified on a clean tree: ruff base 19447 = head 19447, type-discipline 78757 = 78757,
test-quality 6297 = 6297.

**`budget_ratchet_check.py` and `type_discipline_gate.py` read their base budgets with
`git show <ref>:<file>`**, which resolves from the git root. Every budget read as absent at base, so the
ratchet guard passed unconditionally and the type-discipline ratchet treated every rule as newly seeded.
Both now prefix the engine path.

**`make lint` fetched a branch that does not exist.** The Makefile is on `origin/main` throughout.

**`run_migration.py` deleted a tracked directory.** It used `schema.prisma`'s own parent as scratch space,
which upstream was the repository root but here is `code/engine`, so its scratch path landed on
`code/engine/migrations/` and its teardown `rmtree`'d it. It now copies the schema into a real temporary
directory with the migrations beside it. If you see `migrations/Dockerfile` or `migrations/run.py` disappear,
something has regressed this.

**The migration freshness check now warns instead of refusing**, at the maintainer's request, because this
repo is developed in parallel and a branch is behind `origin/main` most of the time.
`--require-fresh-branch` restores the refusal. **The destructive-migration guard is untouched and still
refuses outright** — that is the check that actually stops a dropped column, and an agent must not pass
`--allow-destructive` on its own.

---

## 4. Environment

```bash
cd code/engine
uv sync --extra proxy --group dev --group proxy-dev
```

`postgresql@14` is installed via Homebrew (needed for `run_migration.py`), along with `testing.postgresql`
in the venv. Export the path before running migrations:

```bash
export PATH="/opt/homebrew/opt/postgresql@14/bin:$PATH"
uv run python ci_cd/run_migration.py "your_migration_name"
```

Detection needs Presidio and, optionally, an NER server. See section 6 for what actually works, because the
compose file does not.

---

## 5. What was built

Seven commits on `pii-codec-implementation`. Each phase left the tree green and is independently reviewable.

**Phase A, correctness.** `decode_text` was a `str.replace` fold, so once one value was restored a later
token could rewrite inside it. It is now a single regex pass resolved through a callback. Nothing stopped a
minted token colliding with a token-shaped literal already in the prompt, so `encode_batch` now scans every
text in the batch first and mints at the first free ordinal, giving up with `TokenSpaceExhausted` rather than
looping when a codec ignores the ordinal it is handed. `get_many` added across the store protocol.

**Phase B, the grammar.** `AngleBracketGrammar` behind a `TokenGrammar` protocol owns the wire format; the
codecs differ only in which variant they mint, including the masked form. Recognition is tolerant where
minting is strict: case, internal whitespace, markdown-escaped brackets and underscores, emphasis, and
possessive or plural suffixes all resolve to the minted token. Matching anchors on the closed entity
vocabulary so ordinary `<LIKE_THIS>` prose is not a token, and a truncated token is never prefix-guessed.
`canonical_tokens` is the one question encode and decode both ask.

**Phase C, the ephemeral path.** Streaming never decoded at all, because `streaming_transform_mode` defaults
to `block_only` and that silently drops text rewrites; the guardrail now opts into `incremental_diff`, sets
`mask_response_content`, and returns `stream_holdback_chars`. `ScopeResolver` turns a key and the
`litellm_session_id` the proxy already resolves into request or conversation scope, and conversation scope
refuses to start without a shared cache. Tool-call arguments now share one token space with the messages.

**Phase D, key management.** `PiiKeyProvider` with an HKDF-SHA256 `DerivedKeyProvider` and a
`SecretManagerKeyProvider` over the existing `BaseSecretManager`. AES-256-GCM with AAD binding
`token_id`, scope type, scope id, and key version, so a row copied into another scope or a token_id swapped
between rows fails to decrypt. Rotation is lazy. Both the derived key and the AESGCM object are cached; warm,
a seal is 2.9us and an unseal 1.8us.

**Phase E, storage.** `LiteLLM_PiiTokenTable` in all three schemas with a generated migration that is pure
`CREATE TABLE` plus indexes. `PiiVaultRepository` behind a `VaultTable` protocol so every query is testable
against a fake, with `table_from_prisma` as the real adapter. `DatabaseTokenStore` for reads, writes,
revocation, subject export, and the sweep. Authorization is pure and lives away from the proxy.

Test count went from 194 to 395 in the PII suites, plus 107 vault tests.

---

## 6. What live verification found

The previous handover flagged that nothing had run against real detectors and that both wire contracts were
written from documentation. Standing them up found two defects the fake-injected tests could not.

**Streaming never decoded.** Described above. A streamed response reached the caller with `<PERSON_1>` still
in it while the identical non-streamed request came back correct.

**piiranha reports the whitespace before a word as part of the entity.** Against the live model,
`My name is Ada Lovelace` encoded to `My name is<PERSON_1>`: the separating space was inside the span, so it
went into the mapping instead of staying in the prompt. The round trip stayed lossless but the model was
reading mangled text, which is the thing the token format exists to prevent. Spans are now trimmed onto the
non-whitespace they cover before overlaps resolve.

**Both parsers are otherwise correct against real responses.** Presidio's `/analyze` returns a flat list of
`{entity_type, start, end, score}` plus an ignored `analysis_explanation`. The HF token-classification server
returns `[{entity_group, score, word, start, end}]`. Overlap resolution handles the real noise correctly: a
credit card number that Presidio also reported as `US_BANK_NUMBER` at 0.05 and `US_DRIVER_LICENSE` at 0.01
resolved to `CREDIT_CARD` at 1.0.

**`docker-compose.pii.yml` does not work as written.** `ghcr.io/huggingface/text-inference-toolkit:latest`
returns `denied` to anonymous pulls. Presidio's port 3000 also collides with a `parashift-studio` container
on this machine. What worked: `docker run -d --rm --name pii-presidio-probe -p 3010:3000
mcr.microsoft.com/presidio-analyzer:2.2.360`, and for the NER stage a 20-line uvicorn app running
`transformers.pipeline("token-classification", model="iiiorg/piiranha-v1-detect-personal-information",
aggregation_strategy="simple")`. The model is ~1.1GB and is now in the HuggingFace cache, so it starts
quickly. Fixing the compose file is unclaimed work.

**End-to-end through the guardrail, both detectors live:**

```
in  : Hi, I'm Ada Lovelace in Paris. Email ada@example.com, card 4111111111111111.
out : Hi, I'm <PERSON_1> in <LOCATION_1>. Email <EMAIL_ADDRESS_1>, card <CREDIT_CARD_1>.
tool: {"to": "<EMAIL_ADDRESS_1>", "who": "<PERSON_1>"}     <- same token space, valid JSON
resp: I will contact Ada Lovelace shortly.
mid-stream 'I will contact <PERS' -> holdback 5
```

**Still not done: a real LLM provider.** No request has been encoded, sent to a model, and decoded back.
`CLAUDE.md` is emphatic that proof of fix means curling a live proxy against a real provider, so that is
worth doing before this is called finished.

---

## 7. Where to pick up

Phase E's storage layer is complete and tested; what is missing is the wiring. In rough order:

1. **Routes.** `DELETE /pii/session/{session_id}`, and the subject-scoped erasure and export routes.
   `revoke_session`, `revoke_subject`, and `export_subject` already exist on `DatabaseTokenStore`.
2. **Wire authorization and audit into the decode path.** `authorize_decode`, `used_break_glass`,
   `identity_from`, and `decode_audit_entry` all exist and are tested; nothing calls them yet. `_raise_public`
   in `pii_endpoints/endpoints.py` needs a `VaultForbidden` case mapping to 403, and the exhaustiveness tests
   in `test_endpoints.py` and `test_pii_anonymizer_guardrail.py` enumerate the error unions, so they will tell
   you if you miss it.
3. **Default `subject_id` from `end_user_id`** at the route layer.
4. **Register the expiry sweep** through `LiteLLM_CronJob`. `sweep_expired` exists on the store.
5. **Phase F, search.** Not started. Re-read Part 7 of the plan first; the decision is a filtered exhaustive
   scan and `entity_type` is the only search-specific column. Do not add a column derived from a value.
6. **Phase G, UI.**
7. **Cross-cutting:** `make check` has still never been run end to end in this repo. The individual gates
   pass; `make check` also runs basedpyright, which needs its own owned venv and has not been exercised here.

---

## 8. Conventions that bit hardest

`CLAUDE.md` is authoritative for style. Beyond it, three things cost real time last session:

**`ruff format` breaks `# mutable-ok` suppressions.** The checker attributes a violation to a specific line,
and several files carry suppressions on lines longer than 120 characters. Running `ruff format` rewraps those
lines, the comment lands on a different line, and five previously-suppressed violations reappear as yours.
`pii_anonymizer_guardrail.py` was in this state and has been made format-stable; other files may not be.
Always check `git diff` after formatting a file you did not write.

**Keep a suppression on a line short enough to survive formatting.** If the statement plus the comment
exceeds 120 characters, formatting will split it and move the comment. Extract to a named variable instead.

**`typing.Any` is banned (TID251) and blind `except Exception` is budgeted (BLE001), and both budgets are at
their ceiling.** Adding one means clearing one. Narrowing a catch around a decode to
`(InvalidTag, ValueError, TypeError)`, or validating a key length once so the encrypt genuinely cannot fail,
are both legitimate ways to pay for a new one; that is how the vault's DB-boundary catch was funded.

**Model failures as values.** `litellm/pii/types.py` holds the error union and both boundaries map it once
with an exhaustive `match` plus `assert_never`. `VaultForbidden` is defined and unused, waiting for step 2
above.

---

## 9. Decisions made since the last handover

Recorded so they are not re-litigated. Everything in Part 8 of the plan still stands.

- **`PiiKeyProvider.key_for` is async**, where the plan sketched it sync. `BaseSecretManager`'s read is
  async, and a sync protocol would force `SecretManagerKeyProvider` to either block the event loop or not
  exist.
- **`DatabaseTokenStore` is deliberately not a `PiiTokenStore`.** That protocol carries the ephemeral
  `TokenScope`; these operations need the vault scope, the entity type, and the session id. Two object
  graphs, as Part 1 of the plan intends, rather than one signature forced onto both.
- **`structured_messages` needs no implementation.** No handler writes it back, and its text already arrives
  in `texts`, which is rewritten. Writing to it would be dead code.
- **The AAD separator is NUL**, not a literal pipe, so the parts cannot be confused by concatenation.
- **A conversation-scoped request with no session id falls back to request scope** rather than failing. An
  unidentified conversation is one request as far as we can tell, and refusing would break every client that
  does not send the header.
