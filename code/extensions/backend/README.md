# anonymice detection backend

The service the browser extension needs before it does anything at all:
`/v1/health`, `/v1/policy`, `/v1/detect`, on one origin, behind one bearer
credential. The contract is
[`docs/extensions/browser/ENDPOINTS.md`](../../../docs/extensions/browser/ENDPOINTS.md);
the detection semantics are [`browser/SPEC.md`](../browser/SPEC.md) §3 and §5.

Tracked as [#8](https://github.com/ma-abdellaoui/anonymice/issues/8).

## The one constraint everything else follows from

This process receives raw page text and decides which pages get read at all, so
it sits **inside the same trust boundary as the vault** (SPEC §3.1). That is not
a deployment preference; it is why:

- it binds to **loopback by default**, and warns when told to do otherwise;
- there is **no default credential** — an unset `DETECT_TOKEN` refuses to start,
  and `--dev` is the only route to the well-known `dev-token`;
- it has **no dependencies**. Every dependency here is code with access to page
  text;
- **no page text is ever logged.** `log.ts` throws on a field name that could
  carry it, so the rule is enforced rather than remembered.

## Run it

```sh
npm run dev                      # loopback, `dev-token`, :8788 — drop-in for the extension's mock
DETECT_TOKEN=… npm start         # anything else
npm test                         # 50 tests, no build step
npm run check                    # typecheck + tests + parity
```

| env | default | what |
|---|---|---|
| `DETECT_TOKEN` | — | the bearer credential. Required; at least 16 characters |
| `DETECT_TOKEN_PREVIOUS` | — | also accepted, so a rotation has no closed window |
| `HOST` / `PORT` | `127.0.0.1` / `8788` | bind address |
| `POLICY_FILE` | `./policy.json` | the trust lists served by `/v1/policy` |
| `CACHE_MAX_ENTRIES` | `5000` | bounded LRU of detection results |
| `MAX_BODY_BYTES` | `1048576` | over it is a `413`, i.e. "re-split" |
| `ALLOWED_ORIGINS` | extension + loopback | CORS allow-list; a wildcard is never sent |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

## Layout

| path | what |
|---|---|
| `src/main.ts` | startup: resolve config, fail loudly, listen |
| `src/server.ts` | routing, CORS, auth gate, request lifecycle |
| `src/routes/` | one file per endpoint, plus the non-contract `/v1/metrics` |
| `src/policy/` | the trust-list file: sanitise, ETag, live re-read |
| `src/detect/` | rule pass, model pass, cache, engine |
| `src/lib/` | **vendored from the extension** — see parity below |

## What it does that the mock does not

`browser/mock/` stays where it is: it is the offline stand-in the eval and the
QA walkthrough use, and it is deliberately a single file. This is the service.

| | mock | backend |
|---|---|---|
| Credential | `dev-token`, baked | required, rotatable, constant-time compare |
| Policy file | re-read per request | re-read on change, sanitised, last-good on breakage |
| Policy validation | none | the client's own §2.5 refusals, applied at the source |
| Detection cache | none | bounded LRU, versioned key, hit/miss counters |
| Hashes | trusted | recomputed; the client's hash is echoed, never used as a key |
| Failure | `200` with whatever worked | `502`, so the page reads as "not scanned" |
| Classes | IBAN, AHV, CARD, EMAIL, PHONE, PERSON, ORG | the same, plus `SECRET` |
| Logs | page-class counts on stdout | structured, and provably text-free |
| CORS | `*` | the extension and loopback |

## Parity with the extension

`src/lib/{checksums,normalize,policy,protocol,types}.ts` are **byte-identical
copies** of the extension's, and `npm run parity` diffs them. The two are
separately deployed artifacts, so they cannot import each other — but a backend
and a clone that disagree about what a valid IBAN is (SPEC §8.7), or a server
and a client that disagree about what a hostname is (ENDPOINTS.md §2.5), would
produce exactly the silent divergence those rules exist to prevent. Same trick,
same reason as `vscode`'s `npm run format-parity` for the token format.

`test/hash.test.ts` goes further and runs the extension's WebCrypto hash against
this one, because the two key the same cache.

## The model pass is a seam, not an LLM

SPEC §3.3's model pass is specified as an LLM. What ships here is
`GazetteerModelPass` — deterministic, credential-free, and the pass the eval
scores. `ModelPass` in `src/detect/model.ts` is the interface an LLM
implementation drops into, and its header states the three properties such an
implementation has to hold that the interface cannot enforce: determinism across
restarts, no confidence on the wire, and UTF-16 offsets.

## One thing the spec does not settle

`SECRET` has no row in the SPEC §5.1 normalisation table, so it falls through
`normalizeValue` into the free-text branch, which case-folds. Case-folding
credential material is wrong twice: `AKIA…` and `akia…` are not the same key,
and two distinct secrets differing only in case would collapse onto one vault
entry. The rule pass therefore states `normalized` for `SECRET` itself — base
normalisation, case preserved — and the client uses it as given. If §5.1 grows a
`SECRET` row that says otherwise, `src/detect/rules.ts` is the one place to
change.
