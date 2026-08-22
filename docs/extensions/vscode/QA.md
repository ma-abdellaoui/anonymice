# QA: manual test pass, VS Code extension

What this covers: loading the extension, the rule pass, tokenisation, reveal,
paste and copy — [`code/extensions/vscode/SPEC.md`](../../../code/extensions/vscode/SPEC.md)
§2–§8. Read [Out of scope](#out-of-scope) before filing anything.

**Read this first.** The packaged extension has **never been loaded in a running
VS Code**. Automated testing covers the pure logic (70 unit tests) and runs the
real bundled `dist/extension.cjs` against a *stubbed* VS Code API — which proves
`activate()` completes, every contributed command is registered, and no
plaintext reaches a document. It proves nothing about decoration rendering,
the paste provider firing, the keybinding, or the status bar, because none of
those exist outside a real editor. **Step 2 is the first time this code runs in
VS Code at all.** A failure there is expected information, not a surprise.

You need: VS Code 1.97+, Node 24+, ~15 minutes.

---

## 0. What the rule pass can and cannot find

This decides what you should expect to light up. There is no detection backend
yet, so everything is the local, deterministic rule pass (SPEC §5.1).

| Class | Found by | Example that must be found |
|---|---|---|
| `IBAN` | mod-97 + country length | `CH93 0076 2011 6238 5295 7` |
| `AHV` | `756` prefix + EAN-13 check | `756.1234.5678.97` |
| `CARD` | Luhn **and** issuer IIN **and** valid length | `4242 4242 4242 4242` |
| `EMAIL` | shape | `anna.meier+billing@Example.ORG` |
| `SECRET` | vendor prefix | `ghp_…`, `AKIA…`, `sk-ant-…`, PEM blocks |

| Not found, by design | Why |
|---|---|
| `PERSON`, `ADDR`, `ORG` | need the LLM pass; rules cannot do free text |
| high-entropy strings, hashes, UUIDs | no entropy heuristics — too many false positives |
| a 16-digit number with no issuer prefix | Luhn alone passes ~1 in 10 random digit strings |

**"Nothing found" never means "this file is clean."** If the extension ever
implies otherwise, that is a bug worth filing — it is the failure mode the
design is most concerned with (browser SPEC §3.2).

---

## 1. Build

```sh
cd code/extensions/vscode
npm install
npm run check      # 70 tests, typecheck, and the token-format parity diff
npm run build      # -> dist/extension.cjs
```

`npm run check` ending in `token format: browser == vscode` is the gate that the
two extensions still agree on the token format. If that diff fails, stop — a
token minted here will not resolve in the browser extension.

---

## 2. Load it

Three ways. **Use (a) for a test pass** — it reloads on rebuild and gives you a
debug console.

### (a) Extension Development Host — recommended

Open `code/extensions/vscode/` as the VS Code window's folder, then press
<kbd>F5</kbd> (*Run → Start Debugging*).

A second window opens, titled `[Extension Development Host]`, already pointed at
the `demo/` workspace. Everything below assumes that window.

If <kbd>F5</kbd> does nothing, run it from a terminal instead:

```sh
code --extensionDevelopmentPath="$PWD" "$PWD/demo"
```

### (b) Install the packaged build

```sh
npm run package
code --install-extension anonymice.vsix
code demo/
```

Uninstall with `code --uninstall-extension anonymice.anonymice-vscode`.

### (c) Neither — check it is not silently absent

If nothing below works, first confirm the extension actually activated:
*Help → Toggle Developer Tools → Console*, look for errors mentioning
`anonymice`. Then run *Developer: Show Running Extensions* and confirm
`Anonymice` is listed with an activation time.

### Confirm activation

| | |
|---|---|
| **Do** | Open the Command Palette (<kbd>ctrl+shift+P</kbd>), type `Anonymice` |
| **Expect** | Seven commands: Tokenize Selection, Tokenize All in File, Hide All Revealed Values, Show Revealed Values, Copy as Token, Toggle Reveal for This File, Reset Vault |
| **Fail** | No commands → the extension did not activate. Check the console before going further |

---

## 3. Classification gates everything

Detection and reveal only run where `anonymice.resources` classifies the file.
This trips people up, so verify it before testing anything else.

The demo workspace ships `demo/.vscode/settings.json`:

```jsonc
{
  "anonymice.resources": [
    { "glob": ".env",         "class": "TRUSTED" },
    { "glob": "customers/**", "class": "NATIVE" }
  ]
}
```

| | |
|---|---|
| **Do** | Open `demo/customers/record.md`. Look at the status bar, right-hand side |
| **Expect** | `⚠ Anonymice: 1 IBAN, 1 EMAIL, 1 CARD, 1 AHV untokenized` |
| **Do** | Hover the status bar item |
| **Expect** | Tooltip naming resource class **NATIVE**, and what the rule pass does *not* cover |
| **Do** | Open `demo/.env` |
| **Expect** | `⚠ Anonymice: 2 SECRET untokenized` — the AWS key and the GitHub token. **`DB_PASSWORD=hunter2-prod-9f` is deliberately not among them**: a plain password has no vendor prefix and no checksum, so no rule can claim it without guessing. Tokenize it by hand in §6 |
| **Do** | Now open any file outside the demo workspace — say this QA doc |
| **Expect** | Status bar shows `Anonymice: untrusted · reveal off`, **no highlighting**. This is correct: an unclassified file is not our business (SPEC §5.1) |

**Do not file "it does nothing on my own files" as a bug** until you have added
a glob to `anonymice.resources`.

---

## 4. Detection paints, and paints only

| | |
|---|---|
| **Do** | In `demo/customers/record.md`, look at the IBAN, email, card and AHV |
| **Expect** | Each has a light-red background, and a mark in the overview ruler (right scrollbar) |
| **Expect** | `Anna Meier` is **not** highlighted — rules cannot find names (§0) |
| **Do** | Hover a highlighted value |
| **Expect** | `Anonymice: IBAN detected by rule iban-mod97` |
| **Do** | Check the file on disk: `cat demo/customers/record.md` |
| **Expect** | **Unchanged.** Detection never rewrites (SPEC §6.1) |

### 4a. Precision — these must NOT light up

Paste into `demo/customers/record.md` (a classified file, so the rule pass runs):

```
const orderId = 1234567890123456;
const ts      = 1700000000000;
const hash    = "a3f2b9c8d7e6f5a4b3c2d1e0f9a8b7c6";
const uuid    = "550e8400-e29b-41d4-a716-446655440000";
const iban    = "CH93 0076 2011 6238 5295 8";
```

| **Expect** | **Nothing highlighted.** `orderId` passes Luhn but has no issuer prefix; the last IBAN has a wrong check digit; hashes and UUIDs are never guessed at |

A false positive here is a real bug — this is the rule pass's whole claim.
Undo (<kbd>ctrl+z</kbd>) when done.

---

## 5. Tokenise a whole file

| | |
|---|---|
| **Do** | In `demo/customers/record.md`, right-click → **Anonymice: Tokenize All in File** |
| **Expect** | A notification naming the count and classes, with a *Tokenize* button. Not a modal |
| **Do** | Click *Tokenize* |
| **Expect** | Each value becomes `ANM1-<CLASS>-<17 chars>`, with the real value rendered beside it in grey |
| **Expect** | Highlighting is gone — those values are no longer untokenized |
| **Expect** | `Anna Meier` untouched |

### 5a. The thing being demonstrated

| | |
|---|---|
| **Do** | Save the file. In a terminal: `cat demo/customers/record.md` |
| **Expect** | **Tokens, no plaintext.** The grey values you can see on screen are not in the file |
| **Do** | `grep -r "CH93" demo/` |
| **Expect** | No match. This is what an agent running `grep` would get (SPEC §2.4) |

That is the product. If plaintext appears in either, stop and file it — it is a
violation of the SPEC §2.3 invariant, the one thing everything else rests on.

### 5b. Undo is the whole safety net

| | |
|---|---|
| **Do** | <kbd>ctrl+z</kbd> once |
| **Expect** | All values back, in one undo step — it is a single `WorkspaceEdit` |

Redo and continue.

---

## 6. Tokenise one value, including one rules cannot classify

| | |
|---|---|
| **Do** | Select `Anna Meier` in `demo/customers/record.md`, right-click → **Anonymice: Tokenize Selection** |
| **Expect** | A quick-pick asking for the class — rules cannot tell, so it asks rather than guessing |
| **Do** | Choose `PERSON` |
| **Expect** | `ANM1-PERSON-…` in the buffer, `Anna Meier` rendered beside it |
| **Do** | Same again for `hunter2-prod-9f` in `demo/.env`, choosing `SECRET` |
| **Expect** | Tokenised. This is the path for everything the rule pass cannot reach — which, until the backend lands, is most real-world sensitive data |

---

## 7. Reveal modes

### 7a. `annotate` — the default

| **Expect** | Token visible, value rendered after it. Put the caret at the end of the line and check the column number in the status bar — it counts the **token**, and the buffer text is what it says |

### 7b. `substitute` — opt-in, and why

| | |
|---|---|
| **Do** | Settings → `anonymice.reveal.mode` → `substitute` |
| **Expect** | The token's characters are hidden; the value renders in its place |
| **Do** | Arrow-key across the hidden region. Then <kbd>ctrl+F</kbd> and search for part of the visible value |
| **Expect** | The caret appears to stall, and find does **not** match the visible text — it matches the token. This is documented behaviour, not a bug (SPEC §7.2), and is why `annotate` is the default |

Set it back to `annotate`.

### 7c. Multi-line values cannot be revealed inline

| | |
|---|---|
| **Do** | Tokenize a PEM block (`demo/.env` has none — paste one in, or use any `-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----`) |
| **Expect** | The decoration reads `SECRET — open to view`, **not** the key. An inline decoration cannot render newlines, and quietly dropping them would misrepresent the value (SPEC §7.1). The webview that would show it is not built |

### 7d. The screen-sharing switch

| | |
|---|---|
| **Do** | Command Palette → **Anonymice: Hide All Revealed Values** |
| **Expect** | Every revealed value disappears in one gesture; tokens remain. Status bar reads `Anonymice: hidden` |
| **Do** | **Anonymice: Show Revealed Values** |
| **Expect** | Back |

### 7e. Reveal is opt-in on unclassified files

| | |
|---|---|
| **Do** | Copy a token into a scratch file **outside** the demo workspace |
| **Expect** | Token shown, **no value revealed** — unclassified means opt-in (SPEC §3) |
| **Do** | Command Palette → **Anonymice: Toggle Reveal for This File** |
| **Expect** | Value now revealed. Reload the window; the opt-in persists |

---

## 8. Paste

| | |
|---|---|
| **Do** | Copy `ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` from *outside* the editor (this doc, a browser). Paste into `demo/.env` |
| **Expect** | An `ANM1-SECRET-…` token is inserted, not the key, with the value revealed beside it |
| **Do** | Copy a token from `demo/.env` and paste it into `demo/customers/record.md` |
| **Expect** | A token is inserted — a *different* one, re-scoped to that destination (SPEC §6.3) — resolving to the same value |
| **Do** | Paste ordinary text, e.g. `const x = 1` |
| **Expect** | Pasted unchanged |
| **Do** | Paste a token-shaped string that is not in the vault: `ANM1-PERSON-K3F9QW2MX7VBNC4H8` |
| **Expect** | Pasted **literally**, nothing minted. Documentation containing an example token must not trigger anything (SPEC §8.1) |

If the paste widget appears and offers a choice, our edit is the default; picking
another option is a documented bypass (SPEC §8.1).

---

## 9. Copy — and its documented hole

| | |
|---|---|
| **Do** | In `demo/customers/record.md`, select the IBAN (an *untokenized* one — undo first if needed) and press <kbd>ctrl+c</kbd>. Paste into a scratch file outside the workspace |
| **Expect** | An `ANM1-IBAN-…` token, not the IBAN |
| **Do** | Select the same IBAN and use the **right-click → Copy** menu item instead |
| **Expect** | **The real IBAN.** This is the known platform hole: no supported API can change what a copy puts on the system clipboard, so only the keyboard path is covered (SPEC §8.2). Do not file it |
| **Do** | Select ordinary code and press <kbd>ctrl+c</kbd> |
| **Expect** | Copied verbatim. **Any failure to copy ordinary text is a serious bug** — the binding must never cost you a working <kbd>ctrl+c</kbd> |

---

## 10. Persistence and reset

| | |
|---|---|
| **Do** | *Developer: Reload Window* |
| **Expect** | Tokens still resolve; values still revealed. The vault survives reload |
| **Do** | Command Palette → **Anonymice: Reset Vault (destroy all tokens)** → confirm |
| **Expect** | A modal warning that tokens already written into files will stay there and stop resolving |
| **Do** | Reload the window |
| **Expect** | Tokens in files now render as *"a … token from another vault or profile"* — legible, not a bare failure (browser SPEC §6.7) |

That last line is the point of the tombstone design: a dead token must always say
what it was.

---

## Out of scope

Not built. Do not file:

- **Detection backend.** No LLM pass; `PERSON`, `ADDR`, `ORG` are never found
  automatically (SPEC §5.1).
- **Webview reveal.** Multi-line values show a placeholder; there is no isolated
  editor and no in-place editing of a revealed value (SPEC §7.3).
- **Custom editor** for vault-backed files (SPEC §7.3).
- **Runtime resolution** — no debug-config or terminal environment injection, so
  a tokenised `.env` will not start your dev server (SPEC §9).
- **Copy via context menu / Edit menu / drag** (SPEC §8.2, and §9 above).
- **Remote, devcontainer, WSL, Codespaces.** `extensionKind: ["ui"]` is declared
  but untested; the vault-on-the-wrong-machine question is open (SPEC §10.1).
- **Notebooks.** Cell sources behave like any document; **outputs are not
  handled at all** and will contain plaintext (SPEC §10.2).
- **The §11 adversary-extension gate.** The claim that no other extension can
  read a revealed value is verified against the API surface, not demonstrated.
  Until that gate runs, treat the isolation property as argued, not proven.

## If something fails

Include: VS Code version (*Help → About*), how you loaded it (§2a/b/c), the
resource class from the status bar tooltip, and anything in *Help → Toggle
Developer Tools → Console*.

The most useful single fact is whether `document.getText()` ever contained the
plaintext — everything else is cosmetic by comparison. You can check directly:
open the file, and in the Developer Tools console of the **Extension Host**, or
simply `cat` the saved file. If the plaintext is in the file or the buffer, that
is a §2.3 violation and outranks every other finding here.
