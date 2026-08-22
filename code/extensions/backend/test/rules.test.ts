import assert from 'node:assert/strict';
import test from 'node:test';
import { rulePass } from '../src/detect/rules.ts';

const at = (text: string, needle: string): number => text.indexOf(needle);

test('a checksum failure means no span at all, not a low-confidence one', () => {
  const bad = 'IBAN CH93 0076 2011 6238 5295 8 and card 4111 1111 1111 1112';
  assert.deepEqual(rulePass(bad, 'de-CH'), []);

  const good = 'IBAN CH93 0076 2011 6238 5295 7 and card 4111 1111 1111 1111';
  const classes = rulePass(good, 'de-CH').map((s) => s.cls).sort();
  assert.deepEqual(classes, ['CARD', 'IBAN']);
});

test('AHV needs the 756 prefix and the check digit', () => {
  assert.equal(rulePass('AHV 756.1234.5678.97', 'de-CH')[0]?.cls, 'AHV');
  assert.deepEqual(rulePass('AHV 756.1234.5678.96', 'de-CH'), []);
});

test('offsets are exact, so the client paints what the backend matched', () => {
  const text = 'Zahlung an anna.meier@example.org bis 044 668 18 00';
  for (const span of rulePass(text, 'de-CH')) {
    assert.equal(text.slice(span.start, span.end).trim().length > 0, true);
  }
  const email = rulePass(text, 'de-CH').find((s) => s.cls === 'EMAIL');
  assert.equal(email?.start, at(text, 'anna.meier@example.org'));
  assert.equal(text.slice(email?.start ?? 0, email?.end ?? 0), 'anna.meier@example.org');
});

test('EMAIL normalisation lower-cases the domain only', () => {
  const span = rulePass('Anna.Meier+Steuern@Example.ORG', 'de-CH')[0];
  assert.equal(span?.normalized, 'Anna.Meier+Steuern@example.org');
});

test('SECRET keeps its case: two keys differing only in case are two secrets', () => {
  const text = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
  const span = rulePass(text, 'de-CH').find((s) => s.cls === 'SECRET');
  assert.ok(span, 'a shaped AWS key id is credential material');
  assert.equal(span.normalized, 'AKIAIOSFODNN7EXAMPLE');
  assert.equal(text.slice(span.start, span.end), 'AKIAIOSFODNN7EXAMPLE');
});

test('SECRET matches shaped credentials and not long random-looking strings', () => {
  const hits = (text: string): number => rulePass(text, 'de-CH').filter((s) => s.cls === 'SECRET').length;
  assert.equal(hits('-----BEGIN OPENSSH PRIVATE KEY-----'), 1);
  assert.equal(hits('token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'), 1);
  assert.equal(hits('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 1);
  // A content hash and a minified bundle are not credentials.
  assert.equal(hits('app.4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f.js'), 0);
  assert.equal(hits('function a(b,c){return b+c}//# sourceMappingURL=a.js.map'), 0);
});

test('the phone rule promotes to E.164 only where the locale states a country', () => {
  assert.equal(rulePass('044 668 18 00', 'de-CH')[0]?.normalized, '+41446681800');
  assert.equal(rulePass('044 668 18 00', 'de')[0]?.normalized, '0446681800');
});
