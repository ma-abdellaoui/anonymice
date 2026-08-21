# Mock vault service

One process that plays **all** the parts outside the browser:

- the **vault** (token ↔ real value, the part that stays in Switzerland),
- the **classifier** (span detection, minting, the egress sweep),
- the **policy server** (which destinations are trusted),
- a **fake foreign service** that stores whatever reaches it, verbatim,
- a live **trace console** showing every one of the above as it happens.

Because every control point in the extension has to phone home, the console is
a complete record of what crossed the boundary — and of what did not.

No dependencies. Node 18+.

## Launch

```bash
node code/extensions/utils/server.mjs
```

```
anonymice mock  →  http://vault.localhost:8787/     console
                   http://trusted.localhost:8787/   internal CRM   [TRUSTED]
                   http://cloud.localhost:8787/     fake Confluence [TOKENIZING]
                   http://ai.localhost:8787/        fake LLM chat   [TOKENIZING/surrogate]
```

All four are the same process on port 8787, routed by `Host`. Chrome resolves
`*.localhost` to 127.0.0.1 on its own — no hosts-file entry needed.

State (vault entries, captured payloads, trace log) is in memory. Restarting
wipes it; `reset vault` in the console does the same without a restart.

To watch it with the extension active:

```bash
node code/extensions/build.mjs        # → dist/chrome
```
then `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`.

## What gets captured

Open the console at **http://vault.localhost:8787/**.

**Left — the trace.** One row per event, newest first, click to expand.

| Badge | Where the event came from |
|---|---|
| ① | capture-phase input / clipboard / read — before the untrusted client's JS |
| ② | editor adapter — the document model |
| ③ | chokepoint shim — `fetch`, XHR, WebSocket, beacon, upload |
| 🌍 | the fake foreign service received something |

Expanding a row shows `before` (what existed inside our boundary, with detected
spans highlighted), `after` (what actually left), the span list with each
entity's class, confidence and token, and whether the entity was new.

**Right — three panels.**

- `foreign storage` — every payload the fake provider received, verbatim. This
  is the ground truth: **if a real value appears here, the design failed.**
- `vault` — the token table: digest, class, real value, use count. Watch the
  use count climb when the same value is masked again from a different flow —
  that is cross-document consistency, visible.
- `legend` — the badges above.

**Header — `re-identify as`.** Switches the actor for every subsequent
`resolve` call: `admin` (everything), `hr` (PER, EMAIL, PHONE, ADDR),
`finance` (IBAN, CONTRACT, CARD), `guest` (nothing). Change it and reload a
tokenized page to see flow 7 — same page, two readers, different content.

**Terminal.** The same events, one line each:

```
③ F2-typing            egress-mask  masked 2 (opaque)
  F1-clipboard-copy    classify     2 span(s) PER,IBAN
                       resolve      as finance: 0 granted, 1 denied (PER)
🌍                     PROVIDER-RECEIVED-PLAINTEXT ⚠️  2 real value(s) crossed the border: PER,IBAN
```

`PROVIDER-RECEIVED-PLAINTEXT` is the only failure that matters. The server
re-runs the classifier over everything the fake provider receives, so a leak is
detected by the service itself rather than by eyeballing the payload — and the
console auto-expands that row.

## The baseline worth running first

Load `http://cloud.localhost:8787/` with the extension **disabled**, type a name
and an IBAN, hit Publish. The console goes red: the provider stored real values.

Enable the extension, `reset vault`, repeat. Same actions, and now `foreign
storage` holds only `⟦PER·…⟧` / `⟦IBAN·…⟧`.

That contrast is the whole pitch, and it takes about forty seconds.

## API

Everything below is also what the extension calls, so you can drive any flow
from `curl` without a browser.

| Endpoint | Purpose |
|---|---|
| `POST /api/destination` `{url}` | trust class, token style, blocked, passthrough paths |
| `POST /api/classify` `{text, caretOffset, style, flow, point}` | interactive path — caret-aware, high recall |
| `POST /api/sweep` `{text, url, flow}` | egress gate — dumb, unconditional, no caret exemption |
| `POST /api/resolve` `{digests, actor}` | re-identification, authorized per entity class |
| `POST /api/trace` `{op, summary, …}` | control points reporting something that isn't a decision |
| `POST /api/actor` `{actor}` | switch role |
| `POST /api/reset` | clear vault + captured payloads + trace |
| `GET /api/state` | actor, roles, vault table, foreign storage |
| `GET /events` | SSE trace stream (what the console subscribes to) |
| `POST /cloud/api/*` | fake Confluence — **captures whatever it is sent** |
| `POST /ai/v1/messages` | fake model — captures the prompt, streams a reply back in awkward 7-byte SSE chunks so token-splitting bugs reproduce |

```bash
# what leaves for a foreign destination
curl -s localhost:8787/api/sweep -H 'content-type: application/json' \
  -d '{"url":"http://cloud.localhost:8787/cloud/api/content",
       "text":"Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7"}'
# {"text":"Kunde ⟦PER·b8a373⟧, IBAN ⟦IBAN·ea7105⟧","changed":true,"count":2}

# same values, different flow → same tokens (deterministic derivation)
# a trusted destination → untouched
# the AI host → format-preserving surrogates instead of brackets
```

## Fixtures

| Page | Exercises |
|---|---|
| `fixtures/trusted.html` | flow 1 copy source, re-identifying paste target, trusted egress |
| `fixtures/cloud.html` | flows 2–5: editor + autosave, publish, beacon, WebSocket, XHR, @mention typeahead (blocked by policy), search, attachment, read-back |
| `fixtures/ai.html` | flow 6: RAG context + prompt, streamed response |

Each fixture is deliberately naive — it does exactly what a real SaaS client
does and knows nothing about the extension. Nothing in them cooperates with
masking; if the data comes out tokenized, the extension did it.

## Caveats

- `DEV-ONLY-KEY-NEVER-SHIP` is the HMAC key, and the vault returns real values
  to whoever asks with a permitted role. Authentication is out of scope here:
  this mock exists to make data flow **visible**, not to be secure.
- Trace log keeps the last 500 events; the vault and foreign storage are
  unbounded until reset.
- The classifier is shared with the extension tree (`../core/lib/`), so a rule
  change affects both — which is the point, but means a mock-side edit is not
  mock-only.
