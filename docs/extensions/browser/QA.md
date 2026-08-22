# QA: manual test pass, browser extension

What this covers: detection and highlighting on `NATIVE` hosts, and the trust
classes that decide where any of it runs — SPEC §1–§5.
Nothing else is built yet (see [Out of scope](#out-of-scope) before filing
anything).

**Read this first.** The packaged extension has never been loaded in a browser.
Automated testing covered the pipeline modules, the trust-list pull and the
painter running in a page context (88 unit tests); the manifest, the service
worker, dynamic content script registration and `chrome.runtime` messaging are
**unverified**. The backend endpoints have been exercised by `curl` and by the
policy client against the running mock, but never by the extension itself. Steps 3–6
are the first time that code runs at all, so treat a failure there as expected
information, not as something surprising.

You need: Chrome 105+, Node 24+, three terminals, one `sudo` line, ~15 minutes.

---

## 0. Two pages, two hosts

Trust class is a property of the **host**, not the page — so the fixtures are
two pages served from one port under two names:

| host | page | class | what should happen |
|---|---|---|---|
| `native.anonymice.test` | `native.html` | `NATIVE` | everything sensitive highlighted |
| `trusted.anonymice.test` | `trusted.html` | `TRUSTED` | content script registered, **nothing painted** |
| anything else, incl. `localhost` | — | `UNTRUSTED` | no content script at all |

**Point both names at loopback first**, or nothing below resolves:

```sh
cd code/extensions/browser
npm run hosts          # checks, prints the line and the sudo command; writes nothing itself
```

It will tell you to run:

```sh
echo "127.0.0.1 native.anonymice.test trusted.anonymice.test # anonymice QA fixtures" \
  | sudo tee -a /etc/hosts
```

Re-run `npm run hosts` until it says *already resolvable*. Undo when finished:

```sh
sudo sed -i '/anonymice QA fixtures/d' /etc/hosts
```

`.test` is reserved by RFC 6761 for exactly this, so it cannot collide with a
real domain.

Then serve them:

```sh
npm run fixtures      # :8787, routed by Host header; prints both URLs
```

**Always include `:8787`.** The hostnames resolve to loopback, so a bare
`http://native.anonymice.test/` goes to whatever already owns port 80 — on a box
with Apache or nginx installed, that is its default page, not the fixtures. The
fixture server probes for this at startup and warns you if something answers
there. Two consequences worth knowing:

- Landing on a stranger's default page with an empty badge is not a detection
  failure. Check the port before believing anything.
- Chrome match patterns ignore the port, so the extension *does* inject into
  that port-80 page as well — it is the same host. There is nothing sensitive on
  an Apache welcome page, so the badge stays empty, which is correct and
  uninformative.

Pages are served **clean** — no injected script — so whatever highlights them is
the extension, which is the point. (`HARNESS=1 npm run fixtures` instead injects
a page-script version of the same scanner. Useful when working on the pipeline
without reloading an extension; useless for judging whether the extension works.
The index on `localhost:8787` says which mode it is in.)

**Expected results per page.** The badge counts **distinct values**; red patches
count **occurrences**, and the two differ wherever a page repeats a value:

| page | badge (values) | red patches | why |
|---|---|---|---|
| `native.html` | **11** | **13** | `Anna Meier` appears twice, and one IBAN is written both `CH93 0076 …` and `CH9300762011623852957` |
| `trusted.html` | **0** | **0** | not scanned — `policy.scanTrusted` is `off` |

`native.html` puts every layer and every awkward shape on one page: three
annotated values, four rule classes with real checksums, two model guesses, an
entity split across inline tags, an IBAN split across six elements, an IBAN
behind emoji and astral characters, one value written two ways, and a block of
things that must never be scanned.

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
on its own — which is also what step 9 checks with the backend stopped.

---

## 1. Build

```sh
cd code/extensions/browser
npm install          # first time only
npm test             # expect: 88 pass, 0 fail
npm run build:qa     # prints the hosts and backend it baked in
```

`build:qa` differs from `npm run build` in two ways, both for local
convenience:

- **Host access pre-granted** — `"host_permissions": ["*://*/*"]` in the built
  manifest, so you are not fighting Chrome's optional-permission prompt. This
  changes what the extension **may** read; it does **not** change where content
  scripts are registered, which stays driven by the policy list — confirm with
  `await chrome.scripting.getRegisteredContentScripts()` in the service worker
  console, which lists the two fixture hosts and nothing else.
- **A dev policy baked in** — the two fixture hosts as `NATIVE` and `TRUSTED`,
  the backend on :8788, and the trust-list pull pointed at it and refreshing
  every minute. This is why there is no policy to set by hand before opening a
  page.

Neither applies to `npm run build`: the shipped bundle lists no hosts, asks for
no host permission and has no policy endpoint, so it registers nothing and
contacts nobody until an administrator supplies a policy. The extension is also renamed *anonymice (QA build)* so you can tell
the two apart in `chrome://extensions`.

`npm run eval` scores the mock detector against the corpus and prints
`GATE PASSED`. It exercises no browser code, so a green gate says nothing about
steps 3–9; it is there to tell a detection regression apart from an extension
one when something below looks wrong.

---

## 2. Start the mock backend

```sh
npm run mock          # http://localhost:8788, bearer dev-token
```

It prints the three endpoints it serves — the full set the extension needs
(`docs/extensions/browser/ENDPOINTS.md`):

```
GET  /v1/health
GET  /v1/policy   <- mock/policy.json (edit it live; re-read per request)
POST /v1/detect
```

Leave it running. If it exits with *port 8788 is already in use*, an earlier one
is still up — `pkill -f 'detect-serve[r].ts'` (the brackets stop the pattern
matching your own shell), or `PORT=9788 npm run mock` and point the extension
at it — `npm run build:qa -- --endpoint=http://localhost:9788/v1/detect`, or
override `chrome.storage.local` at runtime. It is a local stand-in for the backend
of SPEC §3.1; page text goes to `localhost` and nowhere else.

The real service (`code/extensions/backend`, ENDPOINTS.md §7) is a drop-in on
the same port — `npm run dev` there instead of `npm run mock` — and every step
below is unchanged. Use it when the thing under test is the *backend* rather
than the extension: it is the one that caches, sanitises the lists it serves,
and answers `502` instead of an empty `200` when a pass fails.

Sanity-check it before you go near the browser, so a later failure is not
ambiguous:

```sh
curl -s localhost:8788/v1/health
curl -s -H 'authorization: Bearer dev-token' localhost:8788/v1/policy
curl -s -o /dev/null -w '%{http_code}\n' localhost:8788/v1/policy      # 401
```

**Expected:** `{"status":"ok",…}`, then the trust lists, then `401`. A `401` on
the second line means the token does not match what `build:qa` baked.

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
## 4. The NATIVE page

Open <http://native.anonymice.test:8787/> and **reload once**. Dynamic
registration only injects on navigations after registration, so a tab that was
already open shows nothing until reloaded.

**Expected:**

| where | what you should see |
|---|---|
| the page | every sensitive value filled light-red (`#ffdada`) |
| toolbar badge | red `11` |
| badge tooltip | *anonymice: 11 sensitive value(s) on this page* |
| desktop notification | *Sensitive data on this page* — "11 sensitive values in 13 places on native.anonymice.test:8787", with `4 IBAN · 3 PERSON · …` underneath |
| mock backend terminal | a line like `[native] 12 chunk(s), … locale de-CH` |

That last line is the host class travelling with the request, decided by the
service worker from the tab's own URL — a page cannot talk its way into a
different class. Opening the TRUSTED page in step 6 produces no such line at
all, because nothing is scanned there.

**Count the red patches: 13, not 11.** `Anna Meier` is highlighted twice, and
the same IBAN is highlighted in both of its spellings, because two occurrences
of one value collapse into a single registry entry (SPEC §5.1). A badge of 13
means collapsing is broken.

### The notification fires once, not on every scan

Reload the page: it appears again, because a navigation is a new page. Now force
a re-scan that does not change the count — in the page console:

```js
document.body.appendChild(document.createElement('p'));
```

**Expected: no second notification.** The badge and the highlights are ambient
state that keeps up with the page; the notification is the one-shot "this page
has something on it". A page that mutates constantly would otherwise notify on
every tick and train you to dismiss it.

It fires again only when the same page turns out to hold **more** than was
announced — step 8 checks that. To silence it, set `notifications` to `off` in
the policy (managed, `storage.local`, or `--notifications=off` at build time).

If nothing appears at all, check Chrome's notification settings and the OS
do-not-disturb state before suspecting the extension: `notifications.create`
fails silently when either suppresses it.

---

## 5. Check what is *not* highlighted

Still on the NATIVE page, scroll to the **Never scanned** block. Every value in
it sits somewhere SPEC §3.5 forbids scanning:

- the IBAN in the `<input>`, and the AHV in the password field
- the card number in the `<textarea>`
- the name and email in the `contenteditable` paragraph
- the IBAN in `<code>` and the name in `<pre>`
- the name in the element marked `data-anonymice` (our own UI)
- the name inside a `<script>`

**Any highlight there is a bug**, and one inside an editable is the worst of
them: on `NATIVE` we never touch editable regions at all.

---

## 6. The TRUSTED page

Open <http://trusted.anonymice.test:8787/> and reload once.

**Expected: nothing highlighted, badge empty** — even though the page carries an
annotated name, an annotated AHV, a valid IBAN, an email and a phone number, and
even though a content script *is* registered for this host —
`await chrome.scripting.getRegisteredContentScripts()` in the worker console
lists it.

Scanning is `NATIVE`-only today: `policy.scanTrusted` is `off`, and only `off`
is implemented (SPEC §1). Confirm the script is present rather than absent:

```js
// page console on trusted.anonymice.test
document.querySelector('style[data-anonymice="highlight-style"]')   // -> null, nothing painted
```

and in DevTools → **Sources → Content scripts**, `content.js` **is** listed for
this page. Registered, injected, and deliberately doing nothing is the correct
state — that is the difference between this page and a host in neither list,
where no script is registered at all. A highlight here means the class gate is not holding.

In the target state this page would highlight, and its two form inputs would
hold tokens while a clone showed the real value (SPEC §1, §8). Neither is built.

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
   **Expected:** `13` — the patch count on `native.html`, not the value count.

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

## 8. Check a live page change is picked up

On the NATIVE page (11 values to start from), in the **page** console:

```js
const p = document.createElement('p');
p.textContent = 'Nachtrag: CH56 0483 5012 3456 7800 9 von Claudia Weber.';
document.body.appendChild(p);
```

**Expected:** within ~1 second, both values are highlighted, the badge rises to
**12** — not 13 — and a second notification appears reading *1 more sensitive
value on this page*. That IBAN already appears on the page split across six
elements, so it is a second *occurrence* of a known value; only `Claudia Weber`
is new. Patches go 13 → 15.

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

**Expected:** count returns to 11.

---

## 9. Check failure is loud, not silent

Stop the mock backend (Ctrl-C in that terminal), then reload the page.

**Expected:** badge shows **`?`** on a brown background, tooltip reads
*anonymice: page not scanned — detection unavailable*.

This matters more than it looks: an empty badge would read as "nothing sensitive
here", which is the one lie the product cannot tell (SPEC §3.2). Values carrying
a `data-sensitive` attribute should **still** be highlighted with the backend
down — annotations are DOM facts, not guesses.

On `native.html` that means the **three `data-sensitive` values stay
highlighted** and nothing else does: the annotated name, the annotated AHV and
the bare-attribute note. The eight rule and model values disappear, because
those were guesses and the guesser is gone.

Restart the backend and reload; the count should come back to 11.

---

## Out of scope

Not built. Please don't file these:

- **No popup.** Clicking the toolbar icon does nothing. The badge, the tooltip
  and the notification are the whole UI; the in-page pill and the popup list of
  what was found are still [#6].
- **No clipboard or token behaviour.** Copying a highlighted value copies the
  value. Minting, `ANM1-…` tokens and the vault are SPEC §6–§7, unbuilt.
- **No reveal / input replacement.** SPEC §8, unbuilt.
- **`TRUSTED` hosts are not scanned.** `policy.scanTrusted` is `off` and only
  `off` is implemented [#7].
- **Detection quality is a stub.** The rule pass is real; the LLM pass is a
  gazetteer. Missed names are the stub, not the detector — the real backend is
  [#8]. What that backend has to serve is
  [ENDPOINTS.md](ENDPOINTS.md); the mock implements all of it.
- **No vault endpoints.** `/v1/tokens*` are sketched in ENDPOINTS.md §6 and not
  built, so nothing mints or resolves.
- **Frames.** `allFrames: false`; iframe content is not scanned.

## If something fails

Capture, in this order:

1. `chrome://extensions` → the card's **Errors** button, if present.
2. Service worker console — all output, including anything red at startup, plus
   `await chrome.runtime.sendMessage({ type: 'anonymice:diagnostics' })`,
   `await chrome.storage.managed.get(null)` and `(await chrome.storage.local.get('policy'))`.
   Diagnostics first: it names which source the lists came from, which decides
   whether the fault is in the backend, the policy, or the extension.
3. Page console — same.
4. `await chrome.scripting.getRegisteredContentScripts()` and
   `(await chrome.permissions.getAll()).origins`.
5. The page you were testing, or enough of it to reproduce.

Steps 3–6 failing is the expected shape of a first run. Steps 7–9 failing means
the pipeline logic is wrong, which would be more surprising — that part has
tests behind it.

[#6]: https://github.com/ma-abdellaoui/anonymice/issues/6
[#7]: https://github.com/ma-abdellaoui/anonymice/issues/7
[#8]: https://github.com/ma-abdellaoui/anonymice/issues/8
