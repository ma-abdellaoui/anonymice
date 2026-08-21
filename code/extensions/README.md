# Anonymice — browser extension

Tokenizes sensitive values **before** they reach a service outside our control,
and re-identifies them locally for authorized users. The mapping token ↔ real
value stays on a server in Switzerland.

Target: **Chrome / Chromium only** (MV3, 111+), deployed under enterprise
policy. That is a deliberate choice, not a gap — see `platform/README.md`.

Status: skeleton. Control points, policy plumbing and the trace harness are
real; editor chips and the confirm UI are TODO.


## Run it

```bash
node code/extensions/utils/server.mjs     # vault + classifier + fixtures, :8787
node code/extensions/build.mjs            # → dist/chrome
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome`.

| URL | Role |
|---|---|
| http://vault.localhost:8787/ | trace console |
| http://trusted.localhost:8787/ | internal CRM — **trusted** |
| http://cloud.localhost:8787/ | fake Confluence — **tokenizing** |
| http://ai.localhost:8787/ | fake LLM chat — **tokenizing**, surrogate style |

Chrome resolves `*.localhost` to 127.0.0.1 with no hosts-file entry. Every
control point reports to the console, so the trace is a complete record of what
crossed the boundary — and the console flags in red any real value the fake
provider received.

## Invariants

1. Plaintext never reaches the clipboard — tokens in `text/plain`, provenance
   (spans + entity ids only) in the custom format.
2. Plaintext never reaches the untrusted client's JS on the input path.
3. Nothing leaves without passing the chokepoint sweep.
4. Everything fails closed: vault down, bridge timeout, unknown policy → no egress.
5. High-confidence classes (IBAN, AHV, card, contract no.) cannot be waived by
   a user override.
