# Platform seams

`core/` is browser-agnostic and must never branch on the platform. Everything
that differs lives in `platform/<target>/`, which supplies exactly two files:

| File | Contains |
|---|---|
| `manifest.json` | the browser's manifest, with paths relative to `dist/<target>/` |
| `platform.js` | `self.anonymicePlatform` — the four seams below, loaded before any `core/content/*` script |

## The four seams

**① MAIN-world injection** (`mainWorld`). Chrome declares `"world": "MAIN"` in
the manifest, so the chokepoint shims are installed before the page's own
scripts run. A target that cannot do this must fall back to appending a
`<script>` tag from a content script, which is racy (the page may already hold
its own `fetch` reference) and dies under a strict CSP.

This is not a packaging difference — it is a **guarantee** difference. A target
without declarative MAIN-world injection offers control point ③ at best-effort,
and its README must say so.

**② Clipboard custom formats** (`clipboard`). Chrome carries unsanitized custom
formats, so copy-time provenance can ride alongside the tokens. Where
`customFormats` is false the copy path still holds — `text/plain` still gets
tokens, never plaintext — but every paste takes the slow "no provenance" branch
and re-classifies without context.

**③ Managed policy delivery** (`policy.read`). The trust list must not be
user-editable. Chrome uses `chrome.storage.managed` + a `managed_schema`
declaration; other browsers deliver enterprise policy differently.

**④ API namespace** (`runtime`). `chrome.*` vs `browser.*`, callbacks vs
promises.

## Adding a target

1. `platform/<name>/manifest.json` — paths relative to the build output root
   (`content/…`, `background/…`, `platform.js`, `managed-schema.json`).
2. `platform/<name>/platform.js` — set all four seams honestly. If a seam is
   unavailable, say so in the value; do not fake it.
3. `node code/extensions/build.mjs <name>` — the build fails if the manifest
   references a file the output does not contain.
4. Document which control points are weaker on that target in
   `docs/extension/CONTROL_POINTS.md`.

Currently shipping: **chrome** only (Chromium, MV3, 111+).
