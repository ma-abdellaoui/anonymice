# QA: manual test pass, browser extension

What this covers: detection and highlighting on `NATIVE` hosts — SPEC §1–§5.
Nothing else is built yet (see [Out of scope](#out-of-scope) before filing
anything).

**Read this first.** The packaged extension has never been loaded in a browser.
Automated testing covered the pipeline modules (68 unit tests) and the painter
running in a page context; the manifest, the service worker, dynamic content
script registration and `chrome.runtime` messaging are **unverified**. Steps 3–6
are the first time that code runs at all, so treat a failure there as expected
information, not as something surprising.

You need: Chrome 105+, Node 24+, two spare terminals, ~15 minutes.

---

## 0. Pages to test against

Six fixtures ship with the repo, each built around one thing that can break.
Serve them:

```sh
npm run fixtures      # http://localhost:8787
```

They are served **clean** — no injected script — so whatever highlights them is
the extension, which is the point. (`HARNESS=1 npm run fixtures` instead injects
a page-script version of the same scanner. Useful when working on the pipeline
without reloading an extension; useless for judging whether the extension works.
The index page says which mode it is in.)

**Expected results per page.** The badge counts **distinct values**; red patches
count **occurrences**, and the two differ wherever a page repeats a value:

| page | badge (values) | red patches | what it is for |
|---|---|---|---|
| `crm-record.html` | 8 | 8 | annotations + rules + model on one page; all three origins |
| `payments-table.html` | 7 | 7 | table cells as chunks; one row deliberately un-annotated |
| `email-thread.html` | 7 | 7 | no annotations at all — rules and model carry it alone |
| `inline-split.html` | **3** | **4** | entities split across inline tags, and one IBAN written two ways |
| `astral.html` | 3 | 3 | emoji, ZWJ sequences and astral letters before the values |
| `skips.html` | **0** | **0** | everything sits somewhere we must never scan |

`inline-split.html` and `skips.html` are the two that matter most. The first
proves formatting variants collapse to one value (3 values, 4 highlights — if
the badge says 4, collapsing is broken). The second must stay completely clean.

### What the mock backend can detect

If you write your own page instead, it has to contain things the stub
recognises. Real rule pass, with checksums:

| class | example that will match |
|---|---|
| `IBAN` | `CH93 0076 2011 6238 5295 7` (mod-97) |
| `AHV` | `756.1234.5678.97` (`756` + EAN-13 check) |
| `CARD` | `4242 4242 4242 4242` (Luhn) |
| `EMAIL` | `anna.meier@example.org` |
| `PHONE` | `+41 44 668 18 00`, `044 668 18 00` |

And a **gazetteer stub standing in for the LLM pass** — not real detection, just
enough to exercise the `model` origin: `PERSON` needs a given name from a fixed
list plus a capitalised surname (`Anna Meier`, `Peter Schmid`); `ORG` needs
capitalised words plus `AG`/`GmbH`/`SA`/`Ltd`/`Holding`. The name list is in
`code/extensions/browser/mock/rules.ts` — `Anna`, `Andrea`, `Beat`, `Claudia`,
`Daniel`, `Elena`, `Felix`, `Hans`, `Julia`, `Luca`, `Marco`, `Maria`, `Martin`,
`Nadia`, `Nicole`, `Peter`, `Sarah`, `Stefan`, `Thomas`, `Ursula`. **Your own
name will not be detected** unless it is on that list. That is the stub, not a
bug.

Site annotations need no backend at all: any element with
`data-sensitive="PERSON"` (or `IBAN`, `CARD`, `AHV`, `PHONE`, `EMAIL`, `ADDR`,
`ORG`, or bare `data-sensitive` for "sensitive, class unknown") is highlighted
on its own — which is also what step 10 checks with the backend stopped.

---

## 1. Build

```sh
cd code/extensions/browser
npm install          # first time only
npm test             # expect: 70 pass, 0 fail
npm run build:qa     # prints the hosts and backend it baked in
```

`build:qa` differs from `npm run build` in two ways, both for local
convenience:

- **Host access pre-granted** — `"host_permissions": ["*://*/*"]` in the built
  manifest, so you are not fighting Chrome's optional-permission prompt. This
  changes what the extension **may** read; it does **not** change where content
  scripts are registered, which stays driven by the policy list. Step 8 is where
  you verify exactly that.
- **A dev policy baked in** — `localhost` as `NATIVE`, backend on :8788. This is
  why step 4 has nothing to type.

Neither applies to `npm run build`: the shipped bundle lists no hosts and asks
for no host permission, so it registers nothing until an administrator supplies
a policy. The extension is also renamed *anonymice (QA build)* so you can tell
the two apart in `chrome://extensions`.

`npm run eval` will fail with "no corpus". That is correct: the fixtures were
removed, and a gate with nothing to score would otherwise report a vacuous pass.

---

## 2. Start the mock backend

```sh
npm run mock          # http://localhost:8788, bearer dev-token
```

Leave it running. If it exits with *port 8788 is already in use*, an earlier one
is still up — `pkill -f 'detect-serve[r].ts'` (the brackets stop the pattern
matching your own shell), or `PORT=9788 npm run mock` and set `detectEndpoint`
to match in step 4. It is a local stand-in for the detection service (SPEC §3.1);
page text goes to `localhost` and nowhere else.

---

## 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `code/extensions/browser/dist`.

**Expected:** the card reads *anonymice (QA build) 0.1.0*, with no red *Errors*
button.

**If there is an Errors button, stop and read it** — that is a manifest or
service-worker startup failure, and it is the single most likely thing to be
broken, since none of this has run before.

---

## 4. Check the policy took (nothing to set)

`build:qa` bakes a dev policy into the worker, so the extension already lists
`localhost` as `NATIVE` and points at the mock backend on :8788. Registration
happens at first boot; there is nothing to type.

Confirm it. On the extension card, click the **service worker** link, and in its
Console:

```js
await chrome.scripting.getRegisteredContentScripts();
```

**Expected:** one entry — `id: "anonymice-content"`, `matches:
["*://localhost/*"]`, `js: ["content.js"]`.

**If it is `[]` or threw** — likely `Cannot add script relating to a host it does
not have access to`, meaning the QA manifest did not take. Check
`(await chrome.permissions.getAll()).origins` shows `*://*/*`, and that you
loaded `dist` *after* running `build:qa`.

### Testing a different host

Rebuild — no console, no reload of anything but the extension:

```sh
npm run build:qa -- --native=crm.example,*.clinic.example
```

Bare hostnames, no port and no scheme. `example.org` matches that host exactly;
`*.example.org` matches it and its subdomains. Other flags: `--endpoint=`,
`--token=`, `--locale=`, `--painter=overlay`, `--trusted=`. The build prints
what it baked. Reload the extension on `chrome://extensions` afterwards.

### Overriding without rebuilding

`chrome.storage.local` outranks the baked policy, so the worker console still
works when you want a one-off:

```js
await chrome.storage.local.set({
  policy: { native: ['localhost', 'crm.example'] },
});
```

Registration re-runs on the storage change. Clear it again with
`await chrome.storage.local.remove('policy')`.

### The real mechanism

Neither of the above is how this ships. SPEC §1 puts the trust list in
`chrome.storage.managed`, distributed by an administrator and not user-editable
— and managed values outrank both the baked policy and `storage.local`. To
exercise that path, generate the enterprise policy file:

```sh
npm run policy -- <extension-id> --native=localhost
```

The id is on `chrome://extensions` with Developer mode on. The command prints
the JSON on stdout and the install instructions on stderr; installing it needs
root, so the script deliberately does not do it for you. Worth one pass before
this goes anywhere real, because the managed path is otherwise untested.

---

## 5. Open the pages

Go to <http://localhost:8787/crm-record.html> and **reload once**. Dynamic
registration only injects on navigations after registration, so a tab that was
already open shows nothing until reloaded.

**Expected:**

| where | what you should see |
|---|---|
| the page | every sensitive value filled light-red (`#ffdada`) |
| toolbar badge | red `8` |
| badge tooltip | *anonymice: 8 sensitive value(s) on this page* |

Then walk the rest of the table in step 0. The one to look at closely is
`inline-split.html`: **3 in the badge, 4 patches of red**, because the same IBAN
is written `CH93 0076 …` in one place and `CH9300762011623852957` in another and
the two collapse to a single value (SPEC §5.1). A badge of 4 there means
formatting variants are not collapsing, which is a real bug.

---

## 6. Check what is *not* highlighted

Open <http://localhost:8787/skips.html>. Every value on it sits somewhere SPEC
§3.5 forbids scanning on `NATIVE`: an `<input>`, a password field, a
`<textarea>`, a `contenteditable` div, `<code>`, `<pre>`, a `<script>`, and one
element marked as our own UI.

**Expected: nothing highlighted, badge empty.**

**Any highlight on that page is a bug**, and a highlight inside an editable is
the worst of them — on `NATIVE` we never touch editable regions at all.

---

## 7. Check the page was not modified

This is the property the whole copy path depends on, so test it directly:

1. Select a highlighted IBAN with the mouse, copy, paste into a plain text
   editor. **Expected:** exactly the text as displayed, no markers, no extra
   spaces.
2. Right-click the value → Inspect. **Expected:** the value sits in its original
   text node with **no wrapper element** around it. The only thing the extension
   added to the page is one `<style data-anonymice="highlight-style">` in
   `<head>`.
3. In the **page** console (not the worker's):
   ```js
   CSS.highlights.get('anonymice-sensitive')?.size
   ```
   **Expected:** a number equal to the count of red patches on that page — `8`
   on `crm-record.html`, `4` on `inline-split.html`.

**If that returns `undefined` while the page still looks correctly highlighted**,
the painter fell back to the overlay backend — fine, but tell me, because it
means the Custom Highlight API is not reaching the page from the content
script's isolated world. That specific interaction has never been tested and is
the thing I am least sure of in this build.

**If nothing is highlighted at all**, force the fallback painter and reload:

```js
// service worker console — overrides the baked policy, leaves the host list alone
const { policy } = await chrome.storage.local.get('policy');
await chrome.storage.local.set({ policy: { ...policy, painter: 'overlay' } });
```

or rebuild with `npm run build:qa -- --painter=overlay`. Either way, reload the
page.

If highlights appear with `overlay` but not with `auto`, that confirms the
isolated-world problem above. Set it back to `auto` afterwards.

---

## 8. Check the extension stays off unlisted hosts

This is the gate the whole trust model rests on (SPEC §1): a host in no list is
never touched at all, rather than touched and then let go.

Open any site that is **not** in your `native` list — `example.com` will do.

| check | expected |
|---|---|
| the page | no highlights |
| badge | empty |
| page console: `document.querySelector('[data-anonymice]')` | `null` — nothing of ours in the DOM |
| DevTools → Sources → Content scripts | no `content.js` for this page |
| worker console: `await chrome.scripting.getRegisteredContentScripts()` | still only your listed host |

**A `content.js` present on an unlisted host is the most serious failure in this
document.** It would mean the gate is an early return rather than a registration
boundary.

---

## 9. Check a live page change is picked up

On <http://localhost:8787/email-thread.html> (7 values to start from), in the
**page** console:

```js
const p = document.createElement('p');
p.textContent = 'Nachtrag: CH56 0483 5012 3456 7800 9 von Claudia Weber.';
document.body.appendChild(p);
```

**Expected:** within ~1 second, both new values are highlighted and the badge
count rises by 2.

Then re-render the same text — the React-reconciliation case:

```js
p.textContent = p.textContent;
```

**Expected:** the count stays the same, and the red does not darken. Darkening
means duplicate ranges stacked over one occurrence.

Then remove it:

```js
p.remove();
```

**Expected:** count returns to 7.

---

## 10. Check failure is loud, not silent

Stop the mock backend (Ctrl-C in that terminal), then reload the page.

**Expected:** badge shows **`?`** on a brown background, tooltip reads
*anonymice: page not scanned — detection unavailable*.

This matters more than it looks: an empty badge would read as "nothing sensitive
here", which is the one lie the product cannot tell (SPEC §3.2). Values carrying
a `data-sensitive` attribute should **still** be highlighted with the backend
down — annotations are DOM facts, not guesses.

`crm-record.html` is the page to check this on: with the backend down it should
still highlight the four `data-sensitive` elements and nothing else, because
annotations are DOM facts rather than guesses. `email-thread.html`, which has no
annotations, should go completely clean with a `?` badge.

Restart the backend and reload; the counts should come back.

---

## Out of scope

Not built. Please don't file these:

- **No popup.** Clicking the toolbar icon does nothing; the badge and tooltip
  are the entire UI. The in-page pill and popup list are [#6].
- **No clipboard or token behaviour.** Copying a highlighted value copies the
  value. Minting, `ANM1-…` tokens and the vault are SPEC §6–§7, unbuilt.
- **No reveal / input replacement.** SPEC §8, unbuilt.
- **`TRUSTED` hosts are not scanned.** `policy.scanTrusted` is `off` and only
  `off` is implemented [#7].
- **Detection quality is a stub.** The rule pass is real; the LLM pass is a
  gazetteer. Missed names are the stub, not the detector — the real backend is
  [#8].
- **Frames.** `allFrames: false`; iframe content is not scanned.

## If something fails

Capture, in this order:

1. `chrome://extensions` → the card's **Errors** button, if present.
2. Service worker console — all output, including anything red at startup, plus
   `await chrome.storage.managed.get(null)` and `(await chrome.storage.local.get('policy'))`.
3. Page console — same.
4. `await chrome.scripting.getRegisteredContentScripts()` and
   `(await chrome.permissions.getAll()).origins`.
5. The page you were testing, or enough of it to reproduce.

Steps 3–6 failing is the expected shape of a first run. Steps 7–10 failing means
the pipeline logic is wrong, which would be more surprising — that part has
tests behind it.

[#6]: https://github.com/ma-abdellaoui/anonymice/issues/6
[#7]: https://github.com/ma-abdellaoui/anonymice/issues/7
[#8]: https://github.com/ma-abdellaoui/anonymice/issues/8
