import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseNormalize, normalizeValue } from '../src/lib/normalize.ts';

test('base normalisation strips zero-width and collapses whitespace', () => {
  assert.equal(baseNormalize('Anna​  \n Meier﻿'), 'Anna Meier');
  assert.equal(baseNormalize('  ­ Anna Meier '), 'Anna Meier');
});

test('formatting variants of one value collapse; different names do not (SPEC §5.1)', () => {
  const iban = normalizeValue('IBAN', 'CH93 0076 2011 6238 5295 7');
  assert.equal(iban, 'CH9300762011623852957');
  assert.equal(normalizeValue('IBAN', 'ch9300762011623852957'), iban);

  // Case and whitespace collapse.
  assert.equal(normalizeValue('PERSON', 'ANNA   MEIER'), normalizeValue('PERSON', 'anna meier'));

  // Entity resolution is refused: over-merge is silent and unrecoverable.
  assert.notEqual(normalizeValue('PERSON', 'MEIER, Anna'), normalizeValue('PERSON', 'Anna Meier'));
  assert.notEqual(normalizeValue('PERSON', 'Müller'), normalizeValue('PERSON', 'Muller'));
  assert.notEqual(normalizeValue('PERSON', 'A. Meier'), normalizeValue('PERSON', 'Anna Meier'));
});

test('email lower-cases the domain only', () => {
  assert.equal(normalizeValue('EMAIL', 'Anna.Meier+Steuern@Example.ORG'), 'Anna.Meier+Steuern@example.org');
  assert.notEqual(
    normalizeValue('EMAIL', 'anna.meier@example.org'),
    normalizeValue('EMAIL', 'anna.meier+tag@example.org'),
  );
});

test('phone reaches E.164 only when the country is known', () => {
  assert.equal(normalizeValue('PHONE', '044 668 18 00', { country: 'CH' }), '+41446681800');
  assert.equal(normalizeValue('PHONE', '+41 44 668 18 00'), '+41446681800');
  assert.equal(normalizeValue('PHONE', '044 668 18 00'), '0446681800');
});
