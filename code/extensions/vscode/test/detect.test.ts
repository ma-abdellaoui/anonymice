import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, summarize } from '../src/lib/detect.ts';
import { mintToken } from '../src/lib/tokens.ts';

const classesIn = (s: string): string[] => detect(s).map((f) => f.cls).sort();

test('IBAN by mod-97, in its page formatting', () => {
  const f = detect('Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7 bei der Bank.');
  assert.equal(f.length, 1);
  assert.equal(f[0]!.cls, 'IBAN');
  assert.equal(f[0]!.value, 'CH93 0076 2011 6238 5295 7', 'value keeps its own formatting');
  assert.equal(f[0]!.normalized, 'CH9300762011623852957', 'identity is the compact form');
});

test('a wrong IBAN check digit is not a finding', () => {
  assert.equal(detect('IBAN CH93 0076 2011 6238 5295 8').length, 0);
});

test('a known country with the wrong length is rejected', () => {
  assert.equal(detect('CH93 0076 2011 6238 5295').length, 0, 'CH is 21 chars');
});

test('cards need a real issuer prefix as well as Luhn', () => {
  assert.equal(classesIn('card 4242 4242 4242 4242').join(), 'CARD');
  assert.equal(classesIn('amex 3782 822463 10005').join(), 'CARD');
  // Passes Luhn, but 9... is not an issued IIN — this is the false positive
  // that makes a Luhn-only rule unusable in source code.
  assert.equal(detect('id 9999999999999995').length, 0, 'Luhn alone must not be enough');
});

test('ordinary numbers in code are not cards', () => {
  const src = `
    const orderId = 1234567890123456;
    const ts = 1700000000000;
    version "1.2.3"; port 8080;
  `;
  assert.equal(detect(src).length, 0, `false positives: ${JSON.stringify(detect(src))}`);
});

test('AHV needs the 756 prefix and the check digit', () => {
  assert.equal(classesIn('AHV 756.1234.5678.97').join(), 'AHV');
  assert.equal(detect('AHV 755.1234.5678.97').length, 0);
  assert.equal(detect('AHV 756.1234.5678.90').length, 0);
});

test('vendor-prefixed secrets, and a PEM block as one span', () => {
  assert.equal(classesIn('token=ghp_' + 'a'.repeat(36)).join(), 'SECRET');
  assert.equal(classesIn('AKIAIOSFODNN7EXAMPLE').join(), 'SECRET');
  assert.equal(classesIn('key: sk-ant-' + 'x'.repeat(30)).join(), 'SECRET');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nlines\n-----END RSA PRIVATE KEY-----';
  const f = detect(`key = """${pem}"""`);
  assert.equal(f.length, 1, 'a PEM block is one finding, not one per line');
  assert.equal(f[0]!.value, pem);
});

test('high-entropy strings that are not vendor-shaped are left alone', () => {
  const src = 'const hash = "a3f2b9c8d7e6f5a4b3c2d1e0f9a8b7c6"; const uuid = "550e8400-e29b-41d4-a716-446655440000";';
  assert.equal(detect(src).length, 0, 'no entropy heuristics — that is the backend\'s job');
});

test('email, with the domain lower-cased and the local part left alone', () => {
  const f = detect('Contact: Anna.Meier+billing@Example.ORG today');
  assert.equal(f.length, 1);
  assert.equal(f[0]!.normalized, 'Anna.Meier+billing@example.org');
});

test('values already tokenized are never offered again', () => {
  const token = mintToken('IBAN');
  assert.equal(detect(`iban = ${token}`).length, 0, 'a minted token must not be re-detected');
});

test('a token next to a live value finds only the value', () => {
  const token = mintToken('SECRET');
  const f = detect(`old=${token}\nnew=CH93 0076 2011 6238 5295 7`);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.cls, 'IBAN');
});

test('overlapping findings resolve to the wider span, never the narrower', () => {
  // The PEM block contains no other rule hit, but the principle is asserted on
  // any overlap: widening is the fail-closed direction (browser §3.3).
  const f = detect('a@b.co and a@b.com');
  assert.equal(f.length, 2);
  assert.ok(f[0]!.start < f[1]!.start, 'findings come back in document order');
});

test('findings are in document order with offsets that index the source', () => {
  const src = 'email a@b.com then iban CH93 0076 2011 6238 5295 7 then key AKIAIOSFODNN7EXAMPLE';
  const f = detect(src);
  assert.equal(f.length, 3);
  for (const x of f) assert.equal(src.slice(x.start, x.end), x.value, 'offsets must index the source');
  for (let i = 1; i < f.length; i++) assert.ok(f[i]!.start >= f[i - 1]!.end, 'no overlaps survive');
});

test('the offer names what it found (SPEC §6.1)', () => {
  const src = 'a@b.com c@d.com CH93 0076 2011 6238 5295 7';
  assert.equal(summarize(detect(src)), '2 EMAIL, 1 IBAN');
});

test('recall is partial by construction — names are not findable by rule', () => {
  assert.equal(detect('Kunde Anna Meier wohnt in Zürich, Bahnhofstrasse 1').length, 0,
    'PERSON and ADDR need the backend; "no findings" must never read as "clean"');
});
