# anonymice browser extension

Implements [`SPEC.md`](./SPEC.md). This slice covers detection and highlighting
on `NATIVE` hosts — SPEC §1–§5 — plus the eval that gates them.

## Layout

| path | what |
|---|---|
| `src/lib/` | pure core: normalisation, span algebra, projection, annotations, registry, policy, wire contract |
| `src/content/` | scanner loop and painter (Custom Highlight API, overlay fallback) |
| `src/background/` | service worker: policy-driven script registration, the only thing that talks to the backend |
| `mock/` | dev stand-in for the detection service of SPEC §3.1 — real rule pass, gazetteer instead of an LLM |
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
npm run mock        # mock /v1/detect on :8788
npm run fixtures    # serves eval/corpus as a NATIVE host on :8787
npm run check       # typecheck + tests + eval
```

The corpus is six labelled pages in `eval/corpus/` — a `<name>.html` beside a
`<name>.spans.json` of ground-truth `{cls, value}` spans. `npm run eval` scores
every page twice, annotated and with `data-sensitive` stripped, and fails on a
regression against `eval/gate.json`. An empty corpus is treated as a failure
rather than a vacuous 100%.

`npm run fixtures` serves the same corpus on :8787 as a browsable `NATIVE`
host — clean pages, so the extension is what highlights them. For the manual
pass, follow [`docs/extensions/browser/QA.md`](../../../docs/extensions/browser/QA.md),
which lists the expected badge count for each page.

## What has actually been tested

- **68 unit tests** over the pipeline modules, in Node with jsdom.
- **The painter in real Chrome**, via `dev/harness.ts` — a bundle that imports
  the same `Scanner` and calls the mock backend directly. That exercised the
  Custom Highlight API, projection over a real DOM and mutation rescans.
- **Not the extension.** The manifest, the service worker, dynamic content
  script registration and `chrome.runtime` messaging have never been loaded in a
  browser. `QA.md` step 3 is the first time that code runs.

When a corpus existed it scored 100% strict, which was weak evidence: the
`model` pass is a gazetteer written against those fixtures, so it found those
names because it had been told them. The harness's real value is the regression
gate and the contract checks around it — UTF-16 offsets under astral characters,
determinism across runs, the annotated/stripped double pass, and the skip list.
Detection quality becomes measurable when the real backend of
[#8](https://github.com/ma-abdellaoui/anonymice/issues/8) sits behind the same
harness on a corpus it has not seen.

## Not built yet

Clipboard and tokens (SPEC §6–§7), the replacement clone (SPEC §8), the notifier
beyond a badge count (#6), `TRUSTED` scanning (#7), and the real detection
backend (#8). The vault everything downstream depends on has no spec yet — see
SPEC §10.
