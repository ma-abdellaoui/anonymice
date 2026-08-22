import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkHash, spanIdFor } from '../src/lib/digest.ts';
import { sha256Bytes } from '../src/lib/sha256.ts';

const enc = new TextEncoder();

async function viaWebCrypto(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('known vectors', () => {
  assert.equal(sha256Bytes(enc.encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Bytes(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('agrees with WebCrypto — the fallback must be indistinguishable', async () => {
  const cases = [
    '',
    'a',
    'Anna Meier',
    'CH93 0076 2011 6238 5295 7',
    'Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7',
    'Grüsse aus Zürich — ümlauts and em-dashes',
    '👨‍👩‍👧‍👦 Familienkonto 🏦',
    '𝔄𝔫𝔫𝔞 astral letters',
    'x'.repeat(55),   // one byte under a block boundary
    'x'.repeat(56),   // padding spills into a second block
    'x'.repeat(64),
    'x'.repeat(1000),
    'x'.repeat(4000), // the chunk cap of SPEC §3.2
  ];
  for (const value of cases) {
    assert.equal(sha256Bytes(enc.encode(value)), await viaWebCrypto(value), `mismatch for ${JSON.stringify(value.slice(0, 24))}`);
  }
});

test('digest.ts works with crypto.subtle absent, as on an http page', async () => {
  const real = globalThis.crypto;
  try {
    // An insecure context still has crypto, just no subtle.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: real.getRandomValues.bind(real) },
      configurable: true,
    });
    assert.equal(await chunkHash('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal((await spanIdFor('anna meier')).length, 64);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});
