import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectChunk, MODEL_VERSION } from '../mock/rules.ts';
import { Scanner } from '../src/content/scanner.ts';
import type { Detector } from '../src/lib/pipeline.ts';
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

/** The scanner reads `document` for its default root, so give it one. */
function withDocument<T>(doc: Document, fn: () => T): T {
  const previous = (globalThis as { document?: Document }).document;
  (globalThis as { document?: Document }).document = doc;
  try {
    return fn();
  } finally {
    (globalThis as { document?: Document }).document = previous;
  }
}

test('a scan reports distinct values and painted occurrences separately', async () => {
  const doc = domFrom('<p>Anna Meier</p><p>Anna Meier</p><p>IBAN CH93 0076 2011 6238 5295 7</p>');
  const scanner = withDocument(doc, () => new Scanner({ detector: backend, root: doc.body, locale: 'de-CH' }));
  const state = await scanner.scan();
  assert.deepEqual(state, { values: 2, occurrences: 3, unscanned: false });
});

test('re-scanning a mutated block does not stack duplicate highlights', async () => {
  const doc = domFrom('<div id="host"><p id="p">Anna Meier</p></div>');
  const scanner = new Scanner({ detector: backend, root: doc.body, locale: 'de-CH' });
  assert.equal((await scanner.scan()).occurrences, 1);

  // Same text, re-rendered — the classic SPA reconciliation case.
  doc.getElementById('p')!.textContent = 'Anna Meier';
  const state = await scanner.rescan([doc.getElementById('p')!]);
  assert.equal(state.occurrences, 1, 'one occurrence, one range');
});

test('a value removed from the page stops being painted', async () => {
  const doc = domFrom('<div id="host"><p id="p">Anna Meier</p></div>');
  const scanner = new Scanner({ detector: backend, root: doc.body, locale: 'de-CH' });
  await scanner.scan();
  doc.getElementById('p')!.textContent = 'nichts hier';
  const state = await scanner.rescan([doc.getElementById('p')!]);
  assert.deepEqual([state.values, state.occurrences], [0, 0]);
});

test('a failed detection surfaces as unscanned, not as silence', async () => {
  const doc = domFrom('<p>Anna Meier</p>');
  const scanner = new Scanner({ detector: { async detect() { return null; } }, root: doc.body });
  const state = await scanner.scan();
  assert.equal(state.unscanned, true);
  assert.equal(state.values, 0);
});
