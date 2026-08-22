/**
 * The backend hashes with `node:crypto`, the client with WebCrypto. They key the
 * same cache, so "they agree" is a property to test rather than to assume — this
 * runs the browser implementation directly and compares.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkHash as browserChunkHash } from '../../browser/src/lib/digest.ts';
import { chunkHash } from '../src/lib/hash.ts';

const SAMPLES = [
  '',
  'Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7',
  'Grüße aus Zürich — Straße 5',
  '👨‍👩‍👧 astral text 🧾',
  'a'.repeat(4000),
];

test('backend and browser compute the same chunk hash', async () => {
  for (const sample of SAMPLES) {
    assert.equal(chunkHash(sample), await browserChunkHash(sample), JSON.stringify(sample.slice(0, 24)));
  }
});

test('the hash is over NFC, as the protocol states', () => {
  const composed = 'Zürich';
  const decomposed = 'Zürich';
  assert.notEqual(composed, decomposed);
  assert.equal(chunkHash(composed), chunkHash(decomposed));
});
