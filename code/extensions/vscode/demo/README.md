# Anonymice demo workspace

1. Open `.env`, select `hunter2-prod-9f`, right-click → **Anonymice: Tokenize Selection**.
2. The buffer now holds `ANM1-SECRET-…`; the real value renders beside it.
3. Save, then in a terminal: `cat .env` — the plaintext is gone from disk.
4. Open the Command Palette → **Anonymice: Hide All Revealed Values** (for screen sharing).
5. Copy the token, paste it into another file — it re-scopes and reveals there too.

What you should *not* be able to do: get the plaintext out of the document.
`document.getText()`, the file on disk, git, and every hover/inlay/CodeLens
provider all see the token. That is the point (SPEC §2.4).
