# QA: manual test pass, browser extension

What this covers: detection and highlighting on `NATIVE` hosts, the trust classes
that decide where any of it runs, tokenising a value on copy, reading one back
on `TRUSTED` through a surface the page cannot see, and the egress gate that
stops an untokenised value leaving the browser at all — SPEC §1–§8, §10. For the token's
onward journey into VS Code, see [QA-SYNC.md](../QA-SYNC.md).
Nothing else is built yet (see [Out of scope](#out-of-scope) before filing
anything).

**Read this first.** Steps 0–7 have been through a real browser once, and four
bugs were found doing it. **Steps 8, 11–13, 14 and 15 have not.** The copy path and the
whole of SPEC §8 — the reveal frame, the clone, child tokens, declassification —
exist only as unit tests: 183 across the extension, including a cross-extension
contract test driving the real vault endpoints. But jsdom has no `ClipboardEvent`
and no cross-origin iframes, so the `copy` event, the `chrome-extension://` frame,
its `MessageChannel`, and every pixel of positioning are **faked in those tests
and unverified in a browser**. Treat a failure in 8, 11–13, 14 or 15 as expected
information, not as something surprising.

**Step 14 is the newest and the least exercised.** The egress gate has 23 unit
tests behind it and has never run in Chrome. Its two halves — a `world: "MAIN"`
content script and the isolated-world bridge it talks to over `postMessage` —
are exactly the pieces jsdom cannot represent, so treat step 14 as a first
contact rather than a regression check.

**Steps 8 and 14 need the mock backend running.** Tokens come from the vault it serves,
and a copy with no vault reachable is a deliberately empty clipboard.

You need: Chrome 105+ (**111+** for step 14 — see there), Node 24+, three
terminals, one `sudo` line, ~20 minutes.

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
on its own — which is also what step 10 checks with the backend stopped.

---

## 1. Build

```sh
cd code/extensions/browser
npm install          # first time only
npm test             # expect: 254 pass, 0 fail
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
steps 3–10; it is there to tell a detection regression apart from an extension
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
announced — step 9 checks that. To silence it, set `notifications` to `off` in
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

`TRUSTED` is the class we are willing to **show real values to** — not the class
we let hold them (SPEC §1). Two separate things to check here.

### Highlighting follows the rollout flag, not the host class

The QA build ships `scanTrusted: readonly`, so the read-only regions of this page
paint exactly as the NATIVE page does.

**Expected:** the name, AHV, IBAN, email and phone are light-red; the badge shows
a count. The two **form inputs stay untouched** — `readonly` runs the NATIVE
algorithm and skips every editable, which is what makes it ship no new painting
machinery.

Now turn it off and confirm the flag is real, not decorative:

```js
// service worker console
const { policy } = await chrome.storage.local.get('policy');
await chrome.storage.local.set({ policy: { ...policy, scanTrusted: 'off' } });
```

Reload the page. **Expected:** nothing painted, badge empty — even though the
content script *is* still registered here. Confirm it is present rather than
absent, because "registered and deliberately idle" is a different state from
"never injected":

```js
// page console on trusted.anonymice.test
document.querySelector('style[data-anonymice="highlight-style"]')   // -> null
```

and in DevTools → **Sources → Content scripts**, `content.js` **is** listed. That
is the difference between this page and a host in neither list, where no script
is registered at all.

Set it back to `readonly` before carrying on.

### The form is what this page is for

The two inputs are a payment form, and the page's own JavaScript reads them on
every `input` event and prints what it sees under the form. Whatever appears
there is what the site would have sent. **It must never print a value.**

That is step 11.

---

## 7. Check the page was not modified

This is the property the whole copy path depends on, so test it directly:

1. Select a paragraph with **no** highlight in it, copy, paste into a plain
   text editor. **Expected:** exactly the text as displayed, no markers, no
   extra spaces. (A selection that *does* touch a highlight is intercepted on
   purpose now — that is step 8.)
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

## 8. Copy a highlighted value — the clipboard gets a token

The point of the whole thing (SPEC §7). The clipboard has no reader identity —
one buffer, and every consumer gets the same bytes — so the substitution has to
happen at copy, before any destination is known.

The token is minted by the vault in the mock backend, over the worker. It is
requested while you are still *selecting* — `clipboardData` is writable only
while the `copy` event is dispatching, which is far too late for a round trip.

1. On the NATIVE page, select a highlighted IBAN with the mouse and press
   **Ctrl+C**.
2. Click into the browser's **address bar** and press **Ctrl+V**.

**Expected:** `ANM1-IBAN-` followed by 17 characters, 29 in total. Not the IBAN.

Then, without reloading the page:

3. Select the **same** IBAN again and paste again. **Expected:** the *same*
   token. One value, one token, however many times the page shows it.
4. Select a different highlighted value — a name, an email. **Expected:** a
   different token, carrying its own class: `ANM1-PERSON-…`, `ANM1-EMAIL-…`.
5. Select a **whole sentence** that contains a highlighted value. **Expected:**
   the sentence verbatim, with just the value swapped out.
5b. Select a sentence holding **several** values — a name *and* an IBAN *and* an
   email. **Expected:** every value replaced by its own token, and every word
   between them carried through exactly:

   ```
   Kunde ANM1-PERSON-K3F9QW2MX7VBNC4H8, IBAN ANM1-IBAN-9QW2MX7VBNC4H8K3F,
   Mail ANM1-EMAIL-2MX7VBNC4H8K3F9QW — bitte prüfen.
   ```

   This is the *ordinary* gesture, not an edge case (SPEC §7): people quote a
   record into a message, they do not copy one field at a time. Check the
   punctuation and spacing survived — `Kunde `, `, IBAN `, ` — bitte prüfen.`
   are not ours to touch.
5c. Select a value that appears **twice** in the same paragraph. **Expected:**
   the *same* token in both places. One value, one token (SPEC §5).
6. Select **half** an IBAN — start mid-value and drag past the end. **Expected:**
   still a token, and a *different* one from step 3's. A fragment of a secret is
   still the secret.
7. Select across **two paragraphs**, at least one holding a value. **Expected:**
   the blank line between them survives.
8. Now **reload** and copy the same IBAN. **Expected:** the **same** token as
   step 3. Identity lives in the vault, not in the page.
9. Stop `npm run mock` and copy a highlighted value. **Expected:** an **empty**
   clipboard, and `anonymice: mint failed` in the page console — never the
   plaintext. Restart the mock before carrying on.

Each intercepted copy logs what it did, in the **page** console:

```
anonymice: 1 value(s) tokenised on copy — IBAN -> ANM1-IBAN-K3F9QW2MX7VBNC4H8
```

**Copying plain text must not be intercepted.** Copy a paragraph with no
highlight in it: exact text, and no log line at all.

Tokens come from the vault in the mock backend, not from the page — which is
what makes them mean something in the VS Code extension. That round trip has its
own pass: [QA-SYNC.md](../QA-SYNC.md).

### What this does not do yet

- **The browser cannot resolve, only mint.** Pasting a token back into the
  TRUSTED page does nothing; reveal is SPEC §8, unbuilt.
- **The vault is in memory** and dies with `npm run mock`. Every token minted
  before a restart is unresolvable afterwards, permanently.
- **A partial copy does not record its parent.** SPEC §7 wants a *child* of the
  value's token, sharing its lineage and revocation; today it is a sibling that
  merely behaves right.
- **Drag-and-drop is not covered.** Dragging a highlighted value into another
  window carries the plaintext.
- **Rich flavours are dropped.** An intercepted copy writes `text/plain` and
  nothing else, so pasting that selection into a rich editor loses its
  formatting. Deliberate: `text/html` would carry the value straight through.

---

## 9. Check a live page change is picked up

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

## 10. Check failure is loud, not silent

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

---

## 11. Reveal: paste a token into a TRUSTED field

This is SPEC §8, and the claim is exact: **the page's input holds a token at
every instant** — before the paste, during the edit, at submit. There is no
window in which it holds plaintext, a fragment of plaintext, or anything whose
length is derived from it.

1. On the **NATIVE** page, copy a highlighted IBAN (step 8).
2. Go to <http://trusted.anonymice.test:8787/> and paste into the **IBAN** field.

**Expected:** the field shows the real IBAN — and the line under the form reads

```
the site reads: ANM1-IBAN-YDP5N8DWXH19P1ZRD
```

That line is the page's own JavaScript, reading `input.value` on every keystroke.
What it prints is what the site would have sent. The value you can see is drawn
in a `chrome-extension://` iframe positioned over the hidden field: separate
origin, so the page cannot read it, and usually a separate process.

### Prove the value is not in the page

```js
// page console on trusted.anonymice.test
document.querySelector('#f-iban').value          // the token
document.body.innerText.includes('CH93')         // false
document.querySelectorAll('iframe').length       // 1 — ours
document.querySelector('iframe').contentDocument // null: cross-origin, unreadable
```

That last line is the whole design. A `MutationObserver` installed at
`document_start`, a session-replay script, `getComputedStyle(el, '::after')` —
none of them reach inside it.

### Reveal on demand

Click away, then click **back into** the IBAN field. **Expected:** a popover
below the field showing the value. That is §8.9's first step: no focus transfer,
no caret placement, and it covers "paste it, glance at it, move on".

### Several tokens in one field

This is the case the copy side actually produces (step 5b), so it is the one
worth most of your attention.

1. On the NATIVE page, copy a **whole sentence** holding a name, an IBAN and an
   email.
2. Paste it into **Verwendungszweck** — the wide free-text field.

**Expected:** the field shows the sentence with the real values in it, and the
line under the form reads the sentence with **tokens**:

```
the site reads: Kunde ANM1-PERSON-…, IBAN ANM1-IBAN-…, Mail ANM1-EMAIL-… — bitte prüfen.
```

Read the revealed line against what you copied. **It should be identical.** The
prose is drawn plainly and each value that came out of the vault is shaded, so
you can see which parts of the line were tokens.

**It is read-only.** Click into it and try to type: nothing happens. Editing
mixed content means keeping N spans aligned while the user types between them,
and §8.10 states that limit rather than half-doing it. A field holding **one**
token and nothing else is still editable — that is step 12.

### A dead token in the middle of a sentence

With a mixed reveal on screen, revoke *one* of its tokens:

```sh
curl -X DELETE http://localhost:8788/v1/tokens/ANM1-PERSON-… \
  -H 'Authorization: Bearer dev-token'
```

Click away and back into the field. **Expected:** that one value now reads
`[PERSON — revoked <date>]` in italics, **in place**, and every other value in
the sentence still reads normally. A dead token must not take the sentence with
it (SPEC §8.10).

### Mangled tokens are cleaned on the way in

Paste a sentence whose token you have lower-cased by hand, e.g.
`Ref anm1-iban-… ok`. **Expected:** the field holds the token in canonical
upper case, and it resolves. This is the only edit made to pasted text, and it
never changes which token a string denotes (SPEC §6.4, §8.10).

---

## 12. The clone: edit a revealed value

With the IBAN pasted and the clone mounted, click into it and edit.

| do this | expected |
|---|---|
| Select-all, arrow keys, double-click a word, Ctrl+Z | all behave normally — there is a **real value** for the browser to operate on, not a token wearing a costume |
| Type one character | the line under the form changes to a **different** token. That is the child minted on first divergence (SPEC §8.4) |
| Keep typing | the token stops changing. One child per edit session, not one per keystroke |
| Delete the last four digits | the underline goes wavy — the clone runs the same mod-97 the detector does (SPEC §8.7.2) |
| Type a longer value than `maxlength=34` allows | refused, because the clone mirrors the constraints the page declared (SPEC §8.7.1) |
| Click away | the token is committed |

Then check what the page held throughout:

```js
// page console — run it during the edit, not after
document.querySelector('#f-iban').value
```

**Expected:** always `ANM1-…`. Never a partial IBAN, never plaintext.

**Press Escape mid-edit.** The clone goes away and the field keeps its token —
the edit is lost, nothing leaks. Same if you tear the frame out by hand:

```js
document.querySelector('iframe[data-anonymice]').remove()
```

**Expected:** the field shows the token. Degraded UX, intact security (SPEC §8.6)
— that is the inverse of an eagerly-cloned design, where a mount failure would
make the field appear to vanish.

---

## 13. Declassification — the exit, and the one plaintext write

The user pastes an IBAN, clears the field and types something that is not
sensitive. Emitting a token for `invoice ref 12` would put a token where the
destination expects a plain string, so this is the way out (SPEC §8.5).

What governs it is **not** "did it stop classifying" but whether the new value is
a *descendant* of the old one.

| type this into the clone, then click away | expected in the page's field |
|---|---|
| `invoice ref 12` | **the literal text** — a genuine replacement, written through |
| clear it entirely | empty |
| `CH93 0076` (a prefix) | **still a token** — refused |
| `CH930076201162385295` (re-spaced) | still a token — refused |
| `6238 5295 7` (the tail) | still a token — refused |
| `CH56 0483 5012 3456 7800 9` (a different valid IBAN) | a token — a hand-typed second IBAN is not a declassification |

The refusals are the point. A fragment written through is the typed-prefix leak
arriving by another route, and there is **no confirmation dialog** — a modal on
every edit trains click-through, and the substring test already refuses the only
direction that leaks.

### What is not built here

- **No audit entry is emitted.** §8.5 wants class, a hash of the literal, the
  timestamp and the destination origin recorded. The type exists
  (`AuditEntry` in `src/lib/declassify.ts`) and nothing writes one.
- **No protection indicator in browser chrome.** §8.5 says the passive signal
  dropping is what replaces the modal; there is no such signal yet.
- **`requireDeclassifyConfirm`** (managed policy, off by default) is unbuilt.

## 14. Egress — what the server actually received

Steps 8 and 11–13 are all about what the *page* holds. This one is about what
leaves the browser, and it is the only step where the assertion is made against
the **server's** record rather than against the DOM (SPEC §10).

It exists because §7 and §8 only cover a value that arrived by paste. A value
**typed straight into the page** never goes through either, and before this
section there was nothing to stop it (SPEC §10.1).

**The rule for this whole section:** what the page's own JavaScript prints, and
what DevTools shows, are both hints. The verdict is `GET /collected` — that is
the sink, and it holds exactly what a real destination would have stored.

### Setup

The gate is `off` in a shipped build (SPEC §10.6). `build:qa` bakes it to
`enforce`:

```sh
cd code/extensions/browser
npm test                 # expect: 254 pass, 0 fail
npm run build:qa         # prints: egress : enforce
npm run fixtures         # prints: egress   POST /collect · ws /collab · GET|DELETE /collected
```

**Chrome 111+ is required for this step only.** `world: "MAIN"` in
`chrome.scripting.registerContentScripts` landed in 111, and the manifest floor
is 105. The shim is registered in its **own** call for exactly this reason: on an
older Chrome it fails alone and everything else — detection, highlighting,
reveal — still registers. Check which happened:

```js
await chrome.runtime.sendMessage({ type: 'anonymice:diagnostics' })
```

**Expected:** `egress: { mode: "enforce", matches: ["*://trusted.anonymice.test/*"] }`.
If it carries an `error` instead, read it — `world is not supported` means the
browser is too old and steps 14.1–14.8 cannot run. Anything else is a real bug.

Reload the extension at `chrome://extensions` after any rebuild, then confirm
**two** content scripts are registered — in the service worker console:

```js
(await chrome.scripting.getRegisteredContentScripts()).map(s => [s.id, s.world, s.runAt, s.matches])
```

**Expected:** `anonymice-content` (isolated, `document_idle`, both fixture hosts)
and `anonymice-egress` (`MAIN`, `document_start`, **`trusted.anonymice.test`
only**). If the second is missing, nothing below can pass — the gate is not
loaded. If it lists the `NATIVE` host too, that is a bug: a gate that drops
requests has no business there (SPEC §10.2).

Open `http://trusted.anonymice.test:8787/` and scroll to **Egress**. The page's
console should carry one line at load:

```
anonymice: egress gate up (enforce) — patched fetch, xhr, websocket, beacon
```

All four. A missing transport means the application got its reference first, and
every step below for that transport is meaningless.

### 14.1 A clean body is not touched

1. Click **clear**.
2. Replace the textarea with `{"op":"insert","text":"nothing to see"}`.
3. Click **fetch**, then **what the server got**.

**Expected:** `fetch: resolved`, and the server holds the body **byte-identical**
to what you typed. The gate is not a rewriter of everything it sees.

### 14.2 A typed-in-place IBAN never reaches the server

This is the case the whole section exists for. It is in no registry, it was never
copied, and no scan has ever seen it.

1. **clear**.
2. Leave the default body: `{"op":"insert","text":"CH93 0076 2011 6238 5295 7"}`.
3. Click **fetch**.

**Expected in the page:** `fetch: rejected — AbortError: Blocked by anonymice`.

**Expected from `what the server got`:** `the server received nothing`.

**Expected in the console:** a warning naming the class and the count, and no
value:

```
anonymice: fetch to http://trusted.anonymice.test:8787/collect held — 1 untokenised value(s): IBAN
```

Then click **fetch** a *second* time.

**Expected:** it now **succeeds**, and `what the server got` shows the body with
`ANM1-IBAN-…` where the IBAN was. That is SPEC §10.4 working end to end: the
first attempt was held, the bridge minted what the vault owed, warmed the cache,
and the application's own retry went out tokenised. **We never resend on the
application's behalf** — if the second click had not happened, nothing would
have been sent.

> If the second click is also rejected, the vault is unreachable. Check the mock
> backend is running. Staying blocked is the correct behaviour, not a bug.

### 14.3 WebSocket — the transport that forces the design

`WebSocket.send` returns `void`, which is why the gate cannot await anything
(SPEC §10.3).

1. **clear**, and put an IBAN in the body again — use a *different* one so it is
   not already in the warm cache: `{"op":"insert","text":"CH56 0483 5012 3456 7800 9"}`
2. Click **WebSocket**.

**Expected in the page:** `WebSocket: send() returned (it always does)`. The
application gets no error — it cannot, the API has no way to give one.

**Expected from the server:** **nothing**. The frame was dropped.

3. Click **WebSocket** again.

**Expected:** the server now holds one `websocket` entry carrying the token.

**This is the step where the cost is visible.** A dropped frame desynchronises a
real editor's collab protocol; SPEC §10.4 accepts that deliberately, on the
grounds that a desynchronised editor is recoverable by a reload and a leaked
value is not. If a real Confluence-style destination is ever wired up, expect it
to need a reload after a block.

### 14.4 XHR and sendBeacon are held the same way

Same body, one fresh value each time (`756.1234.5678.97` for AHV,
`4242 4242 4242 4242` for CARD):

| button | first click | after the retry |
|---|---|---|
| **XHR** | `send()` returns, server holds nothing | server holds the token |
| **sendBeacon** | returns **`false`** — the page can see it was held | returns `true`, server holds the token |

`sendBeacon` returning `false` matters: it fires on `pagehide`, when nothing can
be retried and nobody is watching, so it is the one transport that tells the
application synchronously that it was held.

### 14.5 A token already in the body is left alone

1. **clear**.
2. Body: `{"op":"insert","text":"ANM1-IBAN-K3F9QW2MX7VBNC4H8"}`
3. **fetch**, then **what the server got**.

**Expected:** resolved, and the body arrives unchanged. Finding a token is the
system working — the gate must not double-tokenise (SPEC §10.3).

### 14.6 A scanned value is tokenised without a block at all

14.2 costs one round trip because nothing had ever seen the value. A value the
page was *scanned* for is already in the registry and already minted, so it goes
out clean on the **first** attempt.

1. Reload the page and wait for the scan (`scanTrusted` is `readonly` in a QA
   build, so the TRUSTED page is scanned).
2. **clear**.
3. Copy a highlighted name off the page — `Julia Steiner` — and put it in the
   body: `{"op":"insert","text":"Julia Steiner"}`
4. Click **fetch** **once**.

**Expected:** resolved on the first click, and the server holds `ANM1-PERSON-…`.

This is also the only way a `PERSON` is caught at all: a name has no checksum, so
pass 2 cannot see it and pass 1 is the whole coverage (SPEC §10.7).

### 14.7 Turn it down to `report` and confirm the difference

```sh
npm run build:qa -- --egress=report
```

Reload the extension and the page. Console should read `egress gate up (report)`.

Repeat 14.2 with a fresh IBAN.

**Expected:** `fetch: resolved` on the **first** click — and the server holds the
**plaintext IBAN**. `report` does not block; it substitutes what it can and
reports what it cannot. The console warning still appears.

That is the mode an administrator runs first to find out what `enforce` would
break, on their own destinations, before it breaks it (SPEC §10.6). Rebuild with
`--egress=enforce` before continuing.

### 14.8 Confirm the gate is not on `NATIVE`

Open `http://native.anonymice.test:8787/`.

**Expected:** **no** `egress gate up` line in that page's console. There is no
Egress section on the NATIVE fixture, and there should be no shim either.

### What is not built here

- **No pill, no badge, no audit entry.** SPEC §10.8 wants a held request surfaced
  in the in-page pill and the badge, and an audit line carrying class, transport,
  destination origin and a hash of the value. Today the only signal is a
  `console.warn`, which no user will ever see. This is the largest gap in the
  section.
- **Non-text bodies pass straight through.** Try it: the fixture sends strings
  only, but a `Blob`, `FormData`, `ArrayBuffer` or `ReadableStream` body is
  forwarded unexamined (SPEC §10.7). Not a bug — a documented gap.
- **The prefix problem is untested here** and cannot be tested with this fixture,
  because the buttons send complete bodies. On a real keystroke-streaming
  destination the frames carrying a value's *prefix* have already gone by the
  time the completing frame is held (SPEC §10.7).
- **Nothing stops the page removing the shim.** `delete window.fetch` in the page
  console, or re-patching over it, disables the gate. It is a control against a
  careless application, not a hostile one (SPEC §10.2).
- **A too-old Chrome loses the gate silently to the user.** The service worker
  logs it and `anonymice:diagnostics` carries it, but the page shows nothing —
  the same §10.8 gap as the missing pill, and worse, because here the user has no
  reason to suspect anything changed.
- **No real collaborative destination has been tried.** The WebSocket here is a
  40-line echo in the fixture server, not Confluence. Whether a real editor
  survives a dropped frame is unmeasured.

## 15. `reveal: dom` — real values in the DOM, tokens on the wire

Step 14 proves nothing sensitive leaves. This one proves the user still sees
real data while that is true (SPEC §10.9). It is the mode to use when the
destination is something we cannot integrate with — Confluence, a canvas editor,
anything whose internals we do not own.

**Read §10.11 before running this.** The mode deliberately puts plaintext in the
page DOM. That is readable by other extensions and by session-replay scripts, and
there is no code fix for the first one. It is a per-host decision, not a default.

### Setup

```sh
npm run build:qa -- --reveal=dom      # prints: reveal : dom
```

Reload the extension and open `http://trusted.anonymice.test:8787/`.

### 15.1 The round trip

The **Round trip** section on the fixture page. `POST /doc` is the destination's
store; `GET /doc` hands back whatever it holds.

1. Leave the default document — it contains a real IBAN.
2. Click **Save**.
3. Click **what the store holds**.

**Expected:** the store received a body with `ANM1-IBAN-…` in it and **no IBAN**.
That is egress, as in step 14.

4. Click **Load**.

**Expected — and this is the whole point:** the blue line reads
`the page renders: IBAN: CH93 0076 2011 6238 5295 7`. The store holds a token;
the page shows the value. The application never sees the token — the shim
rewrites the response before `r.text()` resolves (SPEC §10.9.1).

5. Reload the whole page and click **Load** again.

**Expected:** same. It survives a reload, which is what separates this from a
one-shot substitution.

### 15.2 Where the value actually is

With the page rendering the IBAN, in the page console:

```js
document.body.innerText.includes('CH93 0076 2011 6238 5295 7')
```

**Expected: `true`.** That is not a bug — it is the mode. Compare with step 11's
`false` on the reveal-frame path, and note that this is the difference §10.11
prices.

### 15.3 An unresolvable token stays a token

1. In the **Round trip** textarea, replace the body value with a token that is
   valid in shape but not in the vault:
   `{"title":"x","body":"IBAN: ANM1-IBAN-KH9YRPPR6V0BX38ZS"}` — then edit one
   character of the payload so the check character no longer matches, e.g. change
   the final `S` to `T`.
2. **Save**, then **Load**.

**Expected:** the page shows the token, unchanged. A token we cannot resolve is
the honest thing to render (SPEC §10.9.3), and a *damaged* one is not even
recognised as a token. Nothing should crash and nothing should blank out.

### 15.4 The form submit gate

The **Form submit** section is a plain `<form method="post">` — a browser
navigation with no JavaScript on its path (SPEC §10.10).

1. Leave the pre-filled IBAN and memo.
2. Click **Submit (navigates)**.

**Expected:** the browser navigates to `/collect` and the JSON response is shown.
Go back, then check `what the server got` in the Egress section.

**Expected:** the recorded body is `iban=ANM1-IBAN-…&memo=invoice+12` — the IBAN
tokenised, the memo untouched.

3. Now change the IBAN to a *different* valid one — `CH56 0483 5012 3456 7800 9`
   — and submit again **without** doing anything else first.

**Expected:** the navigation **does not happen**. The page stays put. The console
carries a `form ... held` warning. Submit a second time and it goes through
tokenised — same mint-then-retry as 14.2.

> This is the step most likely to surprise you: a cancelled submit looks exactly
> like a broken button, because §10.8's pill does not exist yet.

### 15.5 A positional payload is held, never rewritten

This is the constraint that decides whether a real collaborative editor can work
(SPEC §10.9.2).

In the **Egress** section, put a ProseMirror-shaped step in the body:

```json
{"clientID":7,"steps":[{"stepType":"replace","from":11,"to":11,"slice":{"content":[{"type":"text","text":"CH93 0076 2011 6238 5295 7"}]}}]}
```

Click **fetch**.

**Expected:** rejected, and the server got nothing — **even after a retry**. It is
not held for want of a token; it is held because substituting a 29-character
token for a 26-character value would move every offset after it and corrupt the
destination's document.

**What this means for Confluence:** its REST surface and its autosaves are
covered by this mode. Its live collaborative step stream is **not** — every frame
carrying a freshly typed value will be dropped, and the editing session will
desynchronise. Do not expect real-time co-editing to work.

### 15.6 Confluence, if you want to point it at one

```sh
npm run build:qa -- --reveal=dom --trusted='*.atlassian.net'
```

Reload the extension. Expect, in rough order of likelihood:

- **Page loads render values** where the stored content holds tokens — the REST
  path, and the part most likely to just work.
- **Typing a new value into the editor** is caught on the frame that completes
  it, and that frame is dropped (§15.5). The editor will get out of step.
- **The prefix already left.** Frames carrying the first two-thirds of the IBAN
  went out before it was recognisable as one (SPEC §10.7).

Check the network panel, not the page: filter for the collab socket and confirm
no frame carries a complete value. That is the assertion. The editor being unhappy
is expected, and is §10.9.2 doing its job rather than a bug to file.

### What is not built here

- **Still no pill, badge or audit entry** (§10.8). In this mode that gap is worse:
  a cancelled form submit and a dropped collab frame both look like the site is
  broken, with nothing to tell the user why.
- **`Blob`, `FormData` and `ReadableStream` bodies pass unexamined** (§10.7).
  With plaintext in the DOM this is now the primary leak path, not a footnote.
- **Nothing addresses other extensions reading the DOM** (§10.11). Grammarly and
  friends see everything this mode renders. There is no code fix; it is an
  allowlist decision.
- **The positional denylist is a guess.** It knows ProseMirror, OT and Yjs
  shapes. A protocol it does not recognise gets rewritten and the destination's
  document corrupted — the worst failure this design can produce.

## 16. Debugging when nothing happens

Every gate in §14 and §15 is a conjunction, so "nothing happened" has six causes
that look identical from the page. A QA build now prints a banner at each one
(`--debug=off` to silence). Read them in order — the first that is wrong is the
answer.

```sh
npm run build:qa -- --reveal=dom --trusted='*.atlassian.net'
```

### The banners, in the order they should appear

**1. `ANONYMICE — content script running`** — in the *page* console.

| row | what a wrong value means |
|---|---|
| `build` | does not match the `build id` the last `build:qa` printed → **you are looking at a stale extension**. Reload it at `chrome://extensions`, then reload the page. Check this first; it costs nothing and it is the most common cause |
| `hostClass` | not `TRUSTED` → nothing below can run. The host is not in the trusted list; rebuild with `--trusted=` |
| `policy.egress` | `off` → no gate, no shim, no DOM reveal |
| `policy.reveal` | `off` → the gate runs but the page keeps showing tokens |
| `egress gate active` | `NO` → the conjunction above failed |
| `DOM reveal active` | `NO` → gate is up but `reveal` is not `dom` |

**No banner at all** means the content script never ran — and the single most
likely cause is **the policy pull replacing your host list**. The pull outranks
the baked list by design (ENDPOINTS.md §2), and the mock serves the two fixture
hosts, so a build targeting a real destination would register and then silently
*unregister* about a minute later. From the page that is indistinguishable from
a broken extension.

Naming hosts on the command line now turns the pull off, and the build says so:

```
policy pull : (off — baked lists only)
note        : pull disabled (hosts named on the command line), so the list above is final
```

If your build says `a pulled list OUTRANKS the baked one above`, that is the
bug. Rebuild with `--trusted=` naming your host, or add it to
`mock/policy.json`. The service worker console also carries
`ANONYMICE — the policy pull REMOVED n host(s)…` when it happens.

Check `chrome://extensions` for errors, then in the service worker console:

```js
(await chrome.scripting.getRegisteredContentScripts()).map(s => [s.id, s.world, s.matches])
await chrome.runtime.sendMessage({ type: 'anonymice:diagnostics' })
```

**2. `ANONYMICE — egress shim up`** — lists the transports it patched and any it
missed. A transport under `missing` means the application got its reference
first, and that transport is ungated.

**3. `ANONYMICE — DOM reveal armed`** — `tokens found in page`.

- **`(none)`** and you can see a token on screen → the token is somewhere the
  pass does not look. It walks text nodes, plus `textarea` and `input` values.
  It skips `script`, `style`, our own UI, and **any focused field**. Click
  elsewhere and reload.
- **Tokens listed** → it found them; go to banner 4.

**4. `ANONYMICE — vault resolve`** — `asked` vs `resolved`.

- **`resolved: 0`** → the vault does not know these tokens. Almost always this:
  the mock vault holds them **in memory** and dies with the process, so tokens
  minted before a restart resolve as `foreign`. Re-mint them.
- **`unresolved` lists some** → those specific tokens are dead, revoked, or from
  another vault (SPEC §6.7). They stay showing as tokens, by design.

Then `ANONYMICE · values landed (N held) — DOM nodes rewritten: M`. **`M: 0`
with `N > 0`** means resolution worked but nothing was rewritten — the tokens
moved, or they are inside a focused field.

### Known: the title is a `<textarea>`

Confluence's page title is a `<textarea name="livepages-title">`, and the
breadcrumb mirrors it. Its content is a *value*, not a text node, so before
`revealFields` existed the text walk stepped straight over it — every token on
the page resolved **except** the one in the title. If you see that symptom,
you are on a build from before this was fixed.

### Fastest headless check

```sh
npm run roundtrip
```

If that prints `ROUND TRIP OK`, the substitution logic is sound and the problem
is registration, policy or the vault — not the gate.

## Out of scope

Not built. Please don't file these:

- **No popup.** Clicking the toolbar icon does nothing. The badge, the tooltip
  and the notification are the whole UI; the in-page pill and the popup list of
  what was found are still [#6].
- **The vault does not persist.** It lives in the mock's memory (ENDPOINTS.md
  §6, `/v1/tokens*`) and dies with the process. Scope reuse, tombstones and
  revocation are real; surviving a restart is not.
- **No child tokens.** A partial copy mints a sibling, not a child with the
  parent's lineage (SPEC §7, §8.4).
- **No drag-and-drop guard.** Only `copy` and `cut` are intercepted; dragging a
  highlighted value out of the page carries the plaintext.
- **No textarea support.** One `<textarea>` holding three tokens is three spans
  to track through arbitrary edits, and there is no atomic chip to render inside
  one. SPEC §8.3 calls it a separate, harder problem.
- **No `UNTRUSTED` activation.** SPEC §1's per-host opt-in — the popup button and
  `chrome.permissions.request` — is unbuilt, so reveal runs on `TRUSTED` only.
- **Pasting mid-field is not handled.** Only an empty field or a full-replace
  selection is taken (SPEC §8.3); anything else falls through untouched.
- **Mixed content is read-only.** Prose with several tokens in it reveals but
  does not clone — editing it is the rich-editor path (SPEC §8.10).
- **`TRUSTED` hosts are not scanned.** `policy.scanTrusted` is `off` and only
  `off` is implemented [#7].
- **Detection quality is a stub.** The rule pass is real; the LLM pass is a
  gazetteer. Missed names are the stub, not the detector — the real backend is
  [#8]. What that backend has to serve is
  [ENDPOINTS.md](ENDPOINTS.md); the mock implements all of it.
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

Steps 3–6 failing is the expected shape of a first run. Steps 7–10 failing means
the pipeline logic is wrong, which would be more surprising — that part has
tests behind it.

[#6]: https://github.com/ma-abdellaoui/anonymice/issues/6
[#7]: https://github.com/ma-abdellaoui/anonymice/issues/7
[#8]: https://github.com/ma-abdellaoui/anonymice/issues/8
