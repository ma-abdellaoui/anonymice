# Anonymice for VS Code

Sensitive values are replaced by a token in the file and in the buffer — which is
what every extension, language server, completion provider and chat agent in the
window reads. You see the real value, rendered through a surface no other
extension can read back.

Full design: [`SPEC.md`](./SPEC.md).

## The invariant

> A sensitive value is never present in any `TextDocument`, and never in any file
> inside the workspace, at any instant. — SPEC §2.3

Everything else follows from it. VS Code has no per-resource reader isolation —
Copilot and agents attach to the *window*, not the file — so the only place to
enforce anything is the text itself.

## What a model sees

Given `DB_PASSWORD=ANM1-SECRET-K3F9QW2MX7VBNC4H8`:

| Reader | Gets |
|---|---|
| inline completion | the token |
| chat `#file`, agent `read_file` | the token |
| agent running `cat` / `grep` | the token — this is why it is tokenised on disk, not only in the buffer |
| language server, git, hot exit, settings sync | the token |

A token is better model input than a redaction: `***` destroys the shape of the
code, `ANM1-SECRET-…` is a well-formed literal of a known class.

## Try it

```
npm install && npm run check && npm run build
```

Then either press <kbd>F5</kbd> (opens an Extension Development Host on `demo/`),
or install the packaged build:

```
npm run package
code --install-extension anonymice.vsix
```

Open `demo/.env`, select a value, right-click → **Anonymice: Tokenize Selection**.

## Commands

| Command | |
|---|---|
| Anonymice: Tokenize All in File | tokenize every rule-pass finding, in one undoable edit (SPEC §6.1) |
| Anonymice: Tokenize Selection | mint a token for the selection and replace it, class asked for if rules can't tell |
| Anonymice: Toggle Reveal for This File | reveal is opt-in on unclassified files (SPEC §3) |
| Anonymice: Hide All Revealed Values | one gesture, for screen sharing (SPEC §7.1) |
| Anonymice: Copy as Token | <kbd>ctrl+c</kbd> where armed — see the copy limitation below |

## Settings

- `anonymice.reveal.mode` — `annotate` (default; token stays, value renders
  beside it, nothing desyncs) or `substitute` (token hidden, value in its place;
  caret, find and column then operate on geometry you cannot see — SPEC §7.2).
- `anonymice.resources` — glob → `NATIVE` / `TRUSTED` / `UNTRUSTED`. Unmatched is
  `UNTRUSTED`.
- `anonymice.suppress` — machine scope only, so a cloned repo cannot mark its own
  contents safe (SPEC §5.2).

## Known limitations in this build

- **Copy is not fully interceptable.** No supported API changes what a copy puts
  on the system clipboard; `prepareDocumentPaste` never reaches it. The
  <kbd>ctrl+c</kbd> binding covers the keyboard path; the editor context menu's
  *Copy* does not. Survivable only because the buffer already holds tokens
  (SPEC §8.2–8.3).
- **Rule pass only; no detection backend yet.** Values are found by regex plus a
  checksum — IBAN (mod-97 + country length), AHV, card (Luhn **and** a real
  issuer prefix), email, and vendor-prefixed secrets. `PERSON`, `ADDR` and `ORG`
  are **not findable this way and are not attempted**. "Rules found nothing"
  never means "this file is clean", and the status bar says so (SPEC §5.1).
- **No webview reveal yet.** Multi-line values (PEM blocks) show a placeholder
  rather than the value, because an inline decoration cannot render newlines
  (SPEC §7.1).
- **The §11 adversary-extension gate has not been run.** The isolation claims in
  SPEC §2.2 are checked against the API surface but not yet demonstrated by a
  second extension trying to read the value.

## Threat model, stated plainly

This defends against readers that read documents — completions, agents, language
servers, telemetry, hot-exit artifacts, session replay of a shared screen. It
does **not** defend against an extension that has decided to steal secrets: the
extension host is one Node process with full filesystem access and no boundary
between extensions (SPEC §2.1).
