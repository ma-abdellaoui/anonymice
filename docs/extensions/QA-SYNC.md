# QA: browser → editor, one value across two extensions

Copy a value in Chrome. Paste it in VS Code. The buffer holds a token; you see
the value.

This is the only flow that needs **both** extensions and the shared vault, so it
has its own pass. The two halves have their own docs and neither covers this:
[browser/QA.md](browser/QA.md) ends at the clipboard, [vscode/QA.md](vscode/QA.md)
starts at the buffer.

You need: Chrome 105+, VS Code, Node 24+, three terminals, ~10 minutes. Do
[browser/QA.md](browser/QA.md) steps 0–3 first if the extension is not already
loaded — this doc assumes the fixtures resolve and the extension is installed.

---

## 0. What is being tested, and what is not

The claim: **a value copied in the browser never enters the editor's buffer, and
the editor can still show it to you.** Everything an LSP, a language model, a
linter or another extension can read holds the token.

| | holds | who can read it |
|---|---|---|
| the page you copied from | the real value | it is the source of truth (SPEC §1, `NATIVE`) |
| the system clipboard | the **token** | everything — that is why substitution happens at copy (SPEC §7) |
| the VS Code buffer | the **token** | every extension, every LSP, every model |
| the vault | the real value | the two extensions, over an authenticated loopback socket |
| what you see in the editor | the real value | you, and nothing else — it is a decoration |

**Mock-grade, and it matters here.** The vault lives inside the mock backend, in
memory. Restart the mock and every token ever minted becomes unresolvable —
permanently, because the plaintext is gone with it. That is the demo's shape, not
a bug to file.

---

## 1. Start the vault

The vault is served by the mock backend, so there is nothing extra to run:

```sh
cd code/extensions/browser
npm run mock
```

Expected, in the banner:

```
  POST /v1/tokens , /v1/tokens/resolve , DELETE /v1/tokens/{token}
  vault: in memory — every token dies when this process does
```

If those two lines are missing you are running an older build.

Second terminal, the fixtures:

```sh
cd code/extensions/browser
npm run fixtures
```

---

## 2. Point the editor at the same vault

The editor is **local-only by default** — it resolves what it minted itself and
nothing else. That default is deliberate: an editor that phones an unconfigured
host about every token it sees would be worse than one that says *"from another
vault"*.

Install the extension, then in VS Code **user** settings (`Ctrl+,` → *Open
Settings (JSON)*):

```jsonc
{
  "anonymice.vault.endpoint": "http://localhost:8788/v1/tokens",
  "anonymice.vault.token": "dev-token"
}
```

Both are **machine scope** — VS Code will refuse them in a workspace
`.vscode/settings.json`, so a cloned repository cannot point your editor at a
vault of its choosing.

Install from the packaged build:

```sh
cd code/extensions/vscode
npm run package
code --install-extension anonymice.vsix
```

---

## 3. The round trip

1. Open `http://native.anonymice.test:8787/` in Chrome. Values are light-red.
2. Select a highlighted **IBAN**, Ctrl+C.
3. In VS Code, open a scratch file — `~/notes/scratch.md` will do, anywhere in a
   workspace folder — and Ctrl+V.

**Expected:** the line reads

```
ANM1-IBAN-YDP5N8DWXH19P1ZRD    CH93 0076 2011 6238 5295 7
└──────── in the buffer ─────┘  └── decoration, not text ──┘
```

The token is grey-on-normal; the value renders after it in the dimmer
"code lens" colour. If reveal is off for that file you will see the bare token —
that is step 5.

### Prove the buffer holds the token, not the value

This is the whole claim, so check it three ways rather than trusting your eyes:

1. **Select the line and copy it.** Paste into the address bar. You get the
   token. There is no value in the selection to copy.
2. **Ctrl+F for `CH93`.** No match. Find operates on the document, and the
   document has no IBAN in it.
3. **Save the file, then `cat` it in a terminal.** The token, alone on the line.

Anything that reads a `TextDocument` — Copilot, an LSP server, a formatter, a
git diff — sees exactly what `cat` sees.

---

## 4. Check the token is re-scoped, not passed through

Compare the token in the buffer with what is actually on your clipboard: paste
into the address bar again and put the two side by side.

**Expected:** they are **different tokens**. The clipboard token was scoped to
the page you copied from; the paste handler swapped in one scoped to this
workspace (SPEC §6.3). Both resolve to the same value, and revoking either kills
both.

**If they are identical**, re-scoping did not happen — most likely
`anonymice.vault.endpoint` is unset, so the editor never reached the vault and
pasted the clipboard token literally.

---

## 5. Check the failure directions

Each of these should be *legible*, never a bare failure or a silent blank.

| do this | expected |
|---|---|
| Paste a token into a file the policy classes `UNTRUSTED` and you have not opted into | bare token, no decoration. `Anonymice: Reveal in This File` turns it on |
| Type a plausible-looking token by hand — `ANM1-IBAN-AAAAAAAAAAAAAAAAA` | *"this looks like a damaged token"* — the check character disagrees |
| Take a real token and change one character in the middle | same — damaged, not missing |
| **Stop the mock backend**, then open a file full of tokens | the values stop resolving. The tokens stay; nothing is invented |
| Restart the mock, reload the window, open it again | still unresolvable. The vault was in memory and the plaintext is gone |
| In Chrome, stop the mock and copy a highlighted value | **empty clipboard**, and `anonymice: mint failed` in the page console. Never the plaintext |

That last row is the one worth dwelling on. With no vault reachable, the
browser has a choice between putting the real value on the clipboard and putting
nothing there. It puts nothing there.

---

## 6. Check revocation reaches both

With the token in your buffer and the mock running:

```sh
curl -X DELETE http://localhost:8788/v1/tokens/ANM1-IBAN-YDP5N8DWXH19P1ZRD \
  -H 'Authorization: Bearer dev-token'
```

Use the **clipboard** token — the one from the browser, not the one in the
buffer. Then reload the VS Code window and reopen the file.

**Expected:** `{"revoked":2}` from curl, and the buffer's token now reads as
*revoked on <date>* rather than showing the value. Revoking one alias kills the
record and every alias of it (SPEC §8.4).

---

## What this does not do yet

- **The vault dies with the mock.** Nothing is persisted anywhere.
- **No `T_draft` sweep, no expiry in practice.** Retention is 90 days and the
  process will not live that long, so the expiry path is only exercised by unit
  tests.
- **The editor caches resolutions per window.** A value revoked while a window is
  open keeps rendering until that window reloads. Retention rolling on resolve
  (SPEC §6.7) is honoured on the vault side, but the editor's redraw cache means
  it does not roll on every repaint.
- **Editing a revealed value does not mint a child.** SPEC §8.4's child-token
  path is unbuilt; the buffer holds whatever token it held.
- **Nothing re-scopes on the way out of the editor.** Copying a token out of a
  buffer copies that token.
- **The browser cannot resolve.** It mints only. There is no reveal in the page,
  so a token pasted back into a `TRUSTED` page stays a token (SPEC §8, unbuilt).

## If something fails

Capture:

1. The mock backend's terminal — every mint and resolve is logged there by token
   and outcome (`-> value`, `-> foreign`, `-> tombstone`).
2. Chrome's **page** console for the copy side, and the **service worker**
   console for `anonymice: mint failed`.
3. VS Code: *Help → Toggle Developer Tools* → Console, for
   `anonymice: shared vault lookup failed`.
4. Which token you had at each step — clipboard, buffer, and what the mock logged.

`-> foreign` in the mock log means the vault genuinely does not know that token:
either it was minted before a mock restart, or the browser minted it while
pointed at a different backend.
