import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectChunk, MODEL_VERSION } from '../mock/rules.ts';
import {
  attachClipboardGuard,
  collectHits,
  createRemoteMinter,
  intersectsRegistry,
  planCopy,
  type MintRequest,
  type Minter,
} from '../src/content/clipboard.ts';
import { runPipeline, type Detector } from '../src/lib/pipeline.ts';
import { mintToken, scanTokens } from '../src/lib/tokens.ts';
import type { SpanRegistry } from '../src/lib/registry.ts';
import type { Cls } from '../src/lib/types.ts';
import { domFrom } from './helpers.ts';

const backend: Detector = {
  async detect(chunks) {
    return {
      modelVersion: MODEL_VERSION,
      policyVersion: 'test',
      chunks: chunks.map((c) => ({ id: c.id, hash: c.hash, spans: detectChunk(c.text, 'de-CH') })),
    };
  },
};

interface TestMinter extends Minter {
  /** One entry per round-trip, so batching and dedupe are observable. */
  readonly batches: MintRequest[][];
  fail: boolean;
}

/**
 * Stands in for the vault behind the worker. Mints on `ensure` and only ever
 * *reads* on `get`, which is the property the copy handler depends on.
 */
function testMinter(scopeId = 'source:https://crm.internal.example'): TestMinter {
  const batches: MintRequest[][] = [];
  const issued = new Map<string, string>();
  const minter = createRemoteMinter(scopeId, async (specs) => {
    batches.push(specs);
    if (state.fail) return { tokens: null, reason: 'no vault in this test' };
    return { tokens: specs.map((spec) => {
      const key = `${spec.scopeId}|${spec.cls}|${spec.normalized}`;
      let token = issued.get(key);
      if (!token) {
        token = mintToken(spec.cls as Cls);
        issued.set(key, token);
      }
      return token;
    }) };
  });
  const state = Object.assign(minter, { batches, fail: false }) as TestMinter;
  return state;
}

async function scanned(html: string): Promise<{ doc: Document; registry: SpanRegistry; minter: TestMinter }> {
  const doc = domFrom(html);
  const { registry } = await runPipeline(doc.body, backend, { locale: 'de-CH' });
  return { doc, registry, minter: testMinter() };
}

/** What the copy handler does, minus the event: pre-mint, then spend. */
async function plan(ranges: Range[], native: string, registry: SpanRegistry, minter: Minter) {
  const { hits } = collectHits(ranges, registry);
  await minter.ensure(hits);
  return planCopy(ranges, native, registry, minter);
}

function selectContents(doc: Document, selector: string): Range {
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector(selector)!);
  return range;
}

/** A selection over `[start, end)` of one element's first text node. */
function selectChars(doc: Document, selector: string, start: number, end: number): Range {
  const node = doc.querySelector(selector)!.firstChild!;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

const IBAN = 'CH93 0076 2011 6238 5295 7';

test('a selection that touches nothing sensitive is left alone', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">Kunde ${IBAN}</p><p id="b">nichts hier</p>`);
  const range = selectContents(doc, '#b');
  assert.equal(intersectsRegistry([range], registry), false);
  assert.equal(await plan([range], range.toString(), registry, minter), null);
  assert.deepEqual(minter.batches, [], 'nothing sensitive, nothing minted');
});

test('a whole-value copy puts a token where the value was (SPEC §7)', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN} bitte</p>`);
  const range = selectContents(doc, '#a');
  const p = (await plan([range], range.toString(), registry, minter))!;

  assert.equal(p.ready, true);
  assert.match(p.text, /^IBAN ANM1-IBAN-[0-9A-HJKMNP-TV-Z]{17} bitte$/);
  assert.equal(p.replacements.length, 1);
  assert.equal(p.replacements[0]!.whole, true);
});

test('the plaintext does not survive the copy in any form', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN} bitte</p>`);
  const range = selectContents(doc, '#a');
  const p = (await plan([range], range.toString(), registry, minter))!;

  assert.ok(!p.text.includes(IBAN));
  assert.ok(!p.text.includes('CH93'));
  assert.ok(!p.text.replace(/\s/g, '').includes('CH9300762011623852957'));
});

test('the vault is asked for the normalised value, not the page formatting', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">${IBAN}</p>`);
  await plan([selectContents(doc, '#a')], IBAN, registry, minter);

  const spec = minter.batches[0]![0]!;
  assert.equal(spec.normalized, 'CH9300762011623852957', 'so two pages spelling it differently share one record');
  assert.equal(spec.value, IBAN, 'the record still holds what the user actually sees');
  assert.equal(spec.scopeId, 'source:https://crm.internal.example');
});

test('one value, one token — however many times the page shows it (SPEC §5, §6.3)', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">${IBAN}</p><p id="b">${IBAN}</p>`);
  const first = (await plan([selectContents(doc, '#a')], IBAN, registry, minter))!;
  const second = (await plan([selectContents(doc, '#b')], IBAN, registry, minter))!;

  assert.equal(first.text, second.text);
  assert.equal(minter.batches.length, 1, 'the second copy is a cache hit, not a second round-trip');
});

test('one round-trip covers every value in a selection, each asked for once', async () => {
  const { doc, registry, minter } = await scanned(
    `<p id="a">Anna Meier, ${IBAN}, anna.meier@example.org, und nochmal ${IBAN}</p>`,
  );
  const range = selectContents(doc, '#a');
  await plan([range], range.toString(), registry, minter);

  assert.equal(minter.batches.length, 1, 'batched');
  const asked = minter.batches[0]!.map((s) => s.normalized);
  assert.equal(new Set(asked).size, asked.length, 'the repeated IBAN is asked for once');
});

test('two scopes never share a token, even for one value (SPEC §6.3)', async () => {
  const { doc, registry } = await scanned(`<p id="a">${IBAN}</p>`);
  const range = selectContents(doc, '#a');
  const here = (await plan([range], IBAN, registry, testMinter('source:https://a.example')))!;
  const there = (await plan([range], IBAN, registry, testMinter('source:https://b.example')))!;
  assert.notEqual(here.replacements[0]!.token, there.replacements[0]!.token);
});

test('a partial copy gets its own token, not the parent value (SPEC §7)', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">${IBAN}</p>`);
  const whole = (await plan([selectContents(doc, '#a')], IBAN, registry, minter))!;

  const half = selectChars(doc, '#a', 0, 12);
  const partial = (await plan([half], half.toString(), registry, minter))!;

  assert.equal(partial.replacements[0]!.whole, false);
  assert.notEqual(partial.replacements[0]!.token, whole.replacements[0]!.token);
  assert.ok(!partial.text.includes('CH93'));
  assert.match(partial.text, /^ANM1-IBAN-[0-9A-HJKMNP-TV-Z]{17}$/);
});

test('several values in one selection each get their own token', async () => {
  const { doc, registry, minter } = await scanned(
    `<p id="a">Anna Meier, IBAN ${IBAN}, anna.meier@example.org</p>`,
  );
  const range = selectContents(doc, '#a');
  const p = (await plan([range], range.toString(), registry, minter))!;

  const tokens = scanTokens(p.text).map((m) => m.token);
  assert.equal(tokens.length, p.replacements.length);
  assert.equal(new Set(tokens).size, tokens.length, 'distinct values, distinct tokens');
  assert.ok(!p.text.includes('Anna Meier'));
  assert.ok(!p.text.includes('anna.meier@example.org'));
  assert.ok(p.text.includes(', IBAN '), 'the text between values is untouched');
});

test("tokens are spliced into the browser's own text, line breaks and all", async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">Anna Meier</p><p id="b">${IBAN}</p>`);
  const range = doc.createRange();
  range.selectNodeContents(doc.body);

  // What Chrome hands to Selection.toString(): block boundaries become breaks,
  // which Range.toString() does not reproduce.
  const native = 'Anna Meier\n\n' + IBAN;
  const p = (await plan([range], native, registry, minter))!;

  assert.match(p.text, /^ANM1-PERSON-[0-9A-HJKMNP-TV-Z]{17}\n\nANM1-IBAN-[0-9A-HJKMNP-TV-Z]{17}$/);
});

test('an unalignable native string costs the formatting, never the value', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const range = selectContents(doc, '#a');
  const p = (await plan([range], 'something else entirely', registry, minter))!;

  assert.ok(!p.text.includes('CH93'));
  assert.match(p.text, /^IBAN ANM1-IBAN-/);
});

test('overlapping entries do not nest one token inside another', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">Anna Meier AG</p>`);
  const range = selectContents(doc, '#a');
  const p = (await plan([range], range.toString(), registry, minter))!;

  let reach = -1;
  for (const r of p.replacements) {
    assert.ok(r.start >= reach, 'replacements are disjoint and in order');
    reach = r.end;
  }
  assert.ok(!/ANM1-[A-Z]+-[0-9A-Z]*ANM1/.test(p.text), 'no token spliced inside another');
});

test('a selection ending inside a value still tokenises the part it took', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN} bitte</p>`);
  const range = selectChars(doc, '#a', 0, 14); // "IBAN CH93 0076"
  const p = (await plan([range], range.toString(), registry, minter))!;

  assert.equal(p.replacements[0]!.whole, false);
  assert.ok(!p.text.includes('CH93'));
  assert.match(p.text, /^IBAN ANM1-IBAN-/);
});

// --- the vault is the only source of tokens ---------------------------------

test('with no token in hand the plan is not ready, and carries no text at all', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const range = selectContents(doc, '#a');
  // No ensure(): this is the copy that outran its pre-mint.
  const p = planCopy([range], range.toString(), registry, minter)!;

  assert.equal(p.ready, false);
  assert.equal(p.text, '', 'a half-substituted string would still hold the value');
});

test('a vault that cannot be reached mints nothing locally', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  minter.fail = true;
  const range = selectContents(doc, '#a');

  assert.equal((await minter.ensure(collectHits([range], registry).hits)).ok, false);
  const p = planCopy([range], range.toString(), registry, minter)!;
  assert.equal(p.ready, false);
  assert.equal(p.text, '');
});

// --- event wiring -----------------------------------------------------------
// jsdom has Selection and Range but no ClipboardEvent, so the event is faked.
// What is being checked here is the handler's contract, not the DOM's.

interface FakeClipboard {
  prevented: boolean;
  written: Record<string, string>;
}

function fireCopy(doc: Document, ranges: Range[], type = 'copy'): FakeClipboard {
  const view = doc.defaultView!;
  const selection = view.getSelection()!;
  selection.removeAllRanges();
  for (const range of ranges) selection.addRange(range);

  const state: FakeClipboard = { prevented: false, written: {} };
  const event = new view.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (t: string, d: string) => void (state.written[t] = d) },
  });
  const preventDefault = event.preventDefault.bind(event);
  Object.defineProperty(event, 'preventDefault', {
    value: () => {
      state.prevented = true;
      preventDefault();
    },
  });
  doc.dispatchEvent(event);
  return state;
}

/** Selection change is debounced; give the pre-mint a tick to land. */
async function settle(doc: Document, ranges: Range[]): Promise<void> {
  const view = doc.defaultView!;
  const selection = view.getSelection()!;
  selection.removeAllRanges();
  for (const range of ranges) selection.addRange(range);
  doc.dispatchEvent(new view.Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 20));
}

test('an ordinary copy is not intercepted at all', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">${IBAN}</p><p id="b">nichts hier</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });

  const state = fireCopy(doc, [selectContents(doc, '#b')]);
  detach();
  assert.equal(state.prevented, false, 'the browser keeps every flavour it would have written');
  assert.deepEqual(state.written, {});
});

test('selecting a value mints it before the copy, and only text/plain is written', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });

  const range = selectContents(doc, '#a');
  await settle(doc, [range]);
  assert.equal(minter.batches.length, 1, 'minted while the user was still selecting');

  const state = fireCopy(doc, [range]);
  detach();
  assert.equal(state.prevented, true);
  assert.deepEqual(Object.keys(state.written), ['text/plain'], 'text/html would carry the value through');
  assert.match(state.written['text/plain']!, /^IBAN ANM1-IBAN-/);
  assert.ok(!state.written['text/plain']!.includes('CH93'));
});

test('selecting nothing sensitive asks the vault for nothing', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">${IBAN}</p><p id="b">nichts hier</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });
  await settle(doc, [selectContents(doc, '#b')]);
  detach();
  assert.deepEqual(minter.batches, []);
});

test('a copy that outruns its pre-mint is cancelled and leaves the clipboard empty', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 10_000 });

  const state = fireCopy(doc, [selectContents(doc, '#a')]);
  detach();
  assert.equal(state.prevented, true);
  assert.equal(state.written['text/plain'], '', 'empty, never the value');
});

test('a cut is a copy for this purpose', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });
  const range = selectContents(doc, '#a');
  await settle(doc, [range]);

  const state = fireCopy(doc, [range], 'cut');
  detach();
  assert.ok(!state.written['text/plain']!.includes('CH93'));
  assert.match(state.written['text/plain']!, /ANM1-IBAN-/);
});

test('a failure mid-sanitisation empties the clipboard rather than filling it', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  let calls = 0;
  const brittle = {
    entries: () => {
      if (++calls > 1) throw new Error('boom');
      return registry.entries();
    },
  } as unknown as SpanRegistry;

  const detach = attachClipboardGuard(doc, { registry: brittle, minter, preMintDelayMs: 10_000 });
  const state = fireCopy(doc, [selectContents(doc, '#a')]);
  detach();

  assert.equal(state.prevented, true, 'prevented before the work that can throw');
  assert.equal(state.written['text/plain'], '');
});

test('detaching puts the page back exactly as it was', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });
  const range = selectContents(doc, '#a');
  await settle(doc, [range]);
  detach();

  const state = fireCopy(doc, [range]);
  assert.equal(state.prevented, false);
});

// --- when the vault does not answer -----------------------------------------

test('a failed mint carries its reason, so the page console explains itself', async () => {
  const minter = createRemoteMinter('source:test', async () => ({
    tokens: null,
    reason: 'no vault at http://localhost:8788/v1/tokens — is the backend running?',
  }));
  const outcome = await minter.ensure([
    { cls: 'IBAN', value: IBAN, normalized: 'CH9300762011623852957', whole: true },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /is the backend running/);
});

test('a reloaded extension is named as such, because the remedy is different', async () => {
  const minter = createRemoteMinter('source:test', async () => {
    throw new Error('Extension context invalidated.');
  });
  const outcome = await minter.ensure([
    { cls: 'IBAN', value: IBAN, normalized: 'CH9300762011623852957', whole: true },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /reload this page/);
});

test('a rejecting worker does not escape as an unhandled rejection', async () => {
  const minter = createRemoteMinter('source:test', async () => {
    throw new Error('Could not establish connection.');
  });
  // The whole point: `ensure` resolves, so the copy path can report and move on.
  await assert.doesNotReject(() =>
    minter.ensure([{ cls: 'IBAN', value: IBAN, normalized: 'x', whole: true }]),
  );
});

test('an empty clipboard tells someone, rather than just being empty', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  minter.fail = true;
  const reasons: string[] = [];
  const detach = attachClipboardGuard(doc, {
    registry,
    minter,
    preMintDelayMs: 10_000,
    onFailure: (reason) => void reasons.push(reason),
  });

  const state = fireCopy(doc, [selectContents(doc, '#a')]);
  assert.equal(state.written['text/plain'], '', 'still fails closed');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reasons, ['no vault in this test'], 'and says why');
  detach();
});

test('a pre-mint that fails is not silent', async () => {
  const { doc, registry, minter } = await scanned(`<p id="a">IBAN ${IBAN}</p>`);
  minter.fail = true;
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  const detach = attachClipboardGuard(doc, { registry, minter, preMintDelayMs: 1 });
  try {
    await settle(doc, [selectContents(doc, '#a')]);
    assert.equal(warnings.length, 1, 'the vault was already unreachable while selecting');
    assert.match(String(warnings[0]![0]), /cannot mint for this selection/);
  } finally {
    console.warn = original;
    detach();
  }
});

/**
 * The mint-time cache warm — SPEC §10.9.3.
 *
 * This is what makes reveal-on-paste synchronous. A `paste` is a user gesture
 * and cannot await a resolve, so the pair has to already be in hand; minting is
 * the one moment it is, for free, because the vault is being told the value
 * rather than asked for it.
 */
test('minting hands the reveal cache the pair it just created', async () => {
  const learned: Array<[string, string]> = [];
  const minter = createRemoteMinter(
    'source:https://example.test',
    async (specs) => ({ tokens: specs.map((_, i) => `ANM1-IBAN-TOKEN${i}`) }),
    (token, value) => learned.push([token, value]),
  );

  const needs = [
    { cls: 'IBAN' as const, value: 'CH93 0076 2011 6238 5295 7', normalized: 'CH9300762011623852957', whole: true },
    { cls: 'EMAIL' as const, value: 'a@b.test', normalized: 'a@b.test', whole: true },
  ];
  assert.equal((await minter.ensure(needs)).ok, true);

  assert.deepEqual(learned, [
    ['ANM1-IBAN-TOKEN0', 'CH93 0076 2011 6238 5295 7'],
    ['ANM1-IBAN-TOKEN1', 'a@b.test'],
  ]);

  // A second ensure mints nothing, so it must not re-announce what is held.
  await minter.ensure(needs);
  assert.equal(learned.length, 2, 'the cache is warmed once per mint, not per ask');
});

test('a failed mint announces nothing — there is no pair to remember', async () => {
  const learned: string[] = [];
  const minter = createRemoteMinter(
    'source:https://example.test',
    async () => ({ tokens: null, reason: 'vault down' }),
    (token) => learned.push(token),
  );
  const outcome = await minter.ensure([
    { cls: 'IBAN' as const, value: 'x', normalized: 'x', whole: true },
  ]);
  assert.equal(outcome.ok, false);
  assert.deepEqual(learned, []);
});
