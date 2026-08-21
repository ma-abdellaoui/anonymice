# Anonymice — browser extension (skeleton)

Tokenizes sensitive values **before** they reach a service outside our control,
and re-identifies them locally for authorized users. The mapping token ↔ real
value stays on a server in Switzerland.

Status: skeleton. Wiring, control points and policy plumbing are real; the
vault is a dev stub, editor chips and confirm UI are TODO.

## Read first

- [`docs/USER_FLOWS.md`](docs/USER_FLOWS.md) — the eight flows and the design decisions behind them
- [`docs/CONTROL_POINTS.md`](docs/CONTROL_POINTS.md) — where we intercept and what each point is worth

## Layout

```
manifest.json              MV3, dual-world content scripts, managed policy
src/background/
  service-worker.js        the only place that classifies, mints or resolves
src/lib/
  policy.js                destination classes (trust list, not a geo list)
  classifier.js            high-recall span detection, caret-aware + dumb sweep
  spans.js                 reverse-order substitution, DOM text projection
  vault.js                 mint/resolve client — DEV STUB, fail-closed
  tokens.js                opaque tokens vs. format-preserving surrogates
src/content/
  bridge.js      ISOLATED  shared runtime + MAIN↔SW message bridge
  clipboard.js   ISOLATED  ① copy/cut/paste/drop, capture phase
  input.js       ISOLATED  ① typed input + ② editor adapters
  chokepoint.js  MAIN      ③ fetch/XHR/WebSocket/beacon/upload gate
```

## Load it

`chrome://extensions` → Developer mode → Load unpacked → this directory.
Chrome 111+ (needs `"world": "MAIN"` content scripts).

Without an enterprise policy, `src/lib/policy.js` falls back to `DEFAULTS`
(`ourco.atlassian.net` as the tokenizing surface). Edit those for local testing
— in a real deployment the list arrives via `chrome.storage.managed` and users
cannot change it.

## Invariants

1. Plaintext never reaches the clipboard — tokens in `text/plain`, provenance
   (spans + entity ids only) in the custom format.
2. Plaintext never reaches the untrusted client's JS on the input path.
3. Nothing leaves without passing the chokepoint sweep.
4. Everything fails closed: vault down, bridge timeout, unknown policy → no egress.
5. High-confidence classes (IBAN, AHV, card, contract no.) can not be waived by
   a user override.
