# anonymice browser extension

Implements [`SPEC.md`](./SPEC.md), from detection and highlighting on `NATIVE`
hosts through the clipboard, the token vault and the reveal path, SPEC §1 to
§10, plus the eval that gates detection. What it needs
from a server is
[`docs/extensions/browser/ENDPOINTS.md`](../../../docs/extensions/browser/ENDPOINTS.md),
and [`../backend/`](../backend/README.md) is the service that implements it.

## Layout

| path | what |
|---|---|
| `src/lib/` | pure core: normalisation, span algebra, projection, annotations, registry, policy, tokens, wire contract |
| `src/content/` | scanner loop, painter (Custom Highlight API, overlay fallback), clipboard guard, reveal and egress |
| `src/background/` | service worker: policy-driven script registration, and the only thing that talks to the backend or the vault |
| `mock/` | dev stand-in for the backend of SPEC §3.1 and the vault of §10: `/v1/health`, `/v1/policy`, `/v1/detect`, `/v1/tokens`. Real rule pass, gazetteer instead of an LLM. The detection service itself is [`../backend/`](../backend/README.md) |
| `eval/` | corpus, scorer, regression gate (SPEC §9) |
| `test/` | unit tests |
| `dev/` | build, fixture server, browser harness |

## Commands

```sh
npm test            # unit tests (Node strips the types; no build step)
npm run eval        # scores eval/corpus, fails on regression against eval/gate.json
npm run build       # bundles dist/
npm run build:qa    # QA build: host access pre-granted + dev policy baked in
npm run policy      # emit the enterprise managed-policy file (see QA.md)
npm run mock        # mock backend on :8788: health, policy, detect, tokens (see ENDPOINTS.md)
npm run fixtures    # serves eval/corpus as a NATIVE host on :8787
npm run check       # typecheck + tests + eval
```

The corpus is two labelled pages in `eval/corpus/`, `native.html` and
`trusted.html`, each beside a `<name>.spans.json` of ground-truth
`{cls, value}` spans. `npm run eval` scores both twice, annotated and with
`data-sensitive` stripped, and fails on a regression against `eval/gate.json`.
An empty corpus is treated as a failure rather than a vacuous 100%.

The two exist as a pair because trust class is a property of the host: served
under `native.anonymice.test` and `trusted.anonymice.test` (see `npm run
hosts`), they are what makes the class gate testable by hand. `npm run fixtures`
serves them clean, so the extension is what highlights them. Follow
[`docs/extensions/browser/QA.md`](../../../docs/extensions/browser/QA.md) for
the manual pass; it lists the expected badge count for each.

## What has actually been tested

- **271 unit tests** over the pipeline, clipboard, reveal and vault-contract
  modules, in Node with jsdom. `npm install` first: jsdom is the one devDependency
  the suite needs.
- **The painter in real Chrome**, via `dev/harness.ts`, a bundle that imports
  the same `Scanner` and calls the mock backend directly. That exercised the
  Custom Highlight API, projection over a real DOM and mutation rescans.
- **Not the extension.** The manifest, the service worker, dynamic content
  script registration and `chrome.runtime` messaging have never been loaded in a
  browser. `QA.md` step 3 is the first time that code runs.

When a corpus existed it scored 100% strict, which was weak evidence: the
`model` pass is a gazetteer written against those fixtures, so it found those
names because it had been told them. The harness's real value is the regression
gate and the contract checks around it: UTF-16 offsets under astral characters,
determinism across runs, the annotated/stripped double pass, and the skip list.
Detection quality becomes measurable when the real backend of
[#8](https://github.com/ma-abdellaoui/anonymice/issues/8) sits behind the same
harness on a corpus it has not seen.

## Not built yet

The notifier beyond a badge count ([#6](https://github.com/ma-abdellaoui/anonymice/issues/6))
and `TRUSTED` scanning ([#7](https://github.com/ma-abdellaoui/anonymice/issues/7)),
which stays off until a policy flag turns it on.

The larger gap is the vault itself. SPEC §10 specifies it and `mock/tokens-api.ts`
serves it, so every path downstream works end to end against the mock, but no
deployed service implements `/v1/tokens` yet. The engine's `/pii/*` endpoints are
the same idea from the other side, and joining the two is the open work.
