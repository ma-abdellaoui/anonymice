import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidAhv, isValidIban, isValidLuhn } from '../src/lib/checksums.ts';

test('IBAN mod-97 with country length', () => {
  assert.ok(isValidIban('CH9300762011623852957'));
  assert.ok(isValidIban('DE89370400440532013000'));
  assert.ok(isValidIban('GB33BUKB20201555555555'));
  assert.ok(!isValidIban('CH9300762011623852958'), 'wrong check digits');
  assert.ok(!isValidIban('CH930076201162385295'), 'CH is 21 chars, not 20');
});

test('Luhn', () => {
  assert.ok(isValidLuhn('4242424242424242'));
  assert.ok(!isValidLuhn('4242424242424241'));
  assert.ok(!isValidLuhn('42424242'), 'too short to be a card');
});

test('AHV: 756 prefix plus EAN-13 check digit', () => {
  assert.ok(isValidAhv('7561234567897'));
  assert.ok(!isValidAhv('7561234567890'));
  assert.ok(!isValidAhv('7551234567897'), 'prefix is fixed');
});
