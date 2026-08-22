import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickClassify } from '../src/lib/quick-rules.ts';

test('IBAN by mod-97, with the country length table', () => {
  assert.equal(quickClassify('CH93 0076 2011 6238 5295 7')?.cls, 'IBAN');
  assert.equal(quickClassify('CH93 0076 2011 6238 5295 7')?.normalized, 'CH9300762011623852957');
  assert.equal(quickClassify('CH93 0076 2011 6238 5295 8'), undefined, 'wrong check digits');
});

test('AHV requires the 756 prefix and the check digit', () => {
  assert.equal(quickClassify('756.1234.5678.97')?.cls, 'AHV');
  assert.equal(quickClassify('755.1234.5678.97'), undefined);
});

test('card by Luhn', () => {
  assert.equal(quickClassify('4242 4242 4242 4242')?.cls, 'CARD');
  assert.equal(quickClassify('4242 4242 4242 4241'), undefined);
});

test('vendor-prefixed secrets, not entropy guesses', () => {
  assert.equal(quickClassify('ghp_' + 'a'.repeat(36))?.cls, 'SECRET');
  assert.equal(quickClassify('AKIAIOSFODNN7EXAMPLE')?.cls, 'SECRET');
  assert.equal(quickClassify('-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----')?.cls, 'SECRET');
  assert.equal(quickClassify('correcthorsebatterystaple'), undefined, 'no entropy heuristics');
});

test('email lower-cases the domain only', () => {
  const r = quickClassify('Anna.Meier+tag@Example.ORG');
  assert.equal(r?.cls, 'EMAIL');
  assert.equal(r?.normalized, 'Anna.Meier+tag@example.org', 'local part is case-significant');
});

test('prose and names are left to the backend', () => {
  assert.equal(quickClassify('Anna Meier'), undefined, 'PERSON is not a synchronous decision');
  assert.equal(quickClassify('just some code'), undefined);
  assert.equal(quickClassify(''), undefined);
});
