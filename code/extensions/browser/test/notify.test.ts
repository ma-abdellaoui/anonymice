import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakdown, planNotification, type ScanSummary } from '../src/lib/notify.ts';

const scan = (over: Partial<ScanSummary> = {}): ScanSummary => ({
  values: 11,
  occurrences: 13,
  unscanned: false,
  byClass: { IBAN: 4, PERSON: 3, AHV: 1 },
  url: 'http://native.anonymice.test:8787/',
  ...over,
});

test('a first scan with findings announces the count and the footprint', () => {
  const plan = planNotification(null, scan());
  assert.ok(plan);
  assert.equal(plan.title, 'Sensitive data on this page');
  assert.equal(plan.message, '11 sensitive values in 13 places on native.anonymice.test:8787.');
  assert.equal(plan.contextMessage, '4 IBAN · 3 PERSON · 1 AHV');
});

test('a clean page says nothing at all', () => {
  assert.equal(planNotification(null, scan({ values: 0, occurrences: 0, byClass: {} })), null);
});

test('a failed scan is not a "found" event — the badge carries that', () => {
  assert.equal(planNotification(null, scan({ unscanned: true })), null);
});

test('re-scanning the same page does not notify again', () => {
  const previous = { url: 'http://native.anonymice.test:8787/', values: 11 };
  assert.equal(planNotification(previous, scan()), null, 'same count');
  assert.equal(planNotification(previous, scan({ values: 9 })), null, 'fewer than announced');
});

test('finding more on the same page notifies about the difference', () => {
  const previous = { url: 'http://native.anonymice.test:8787/', values: 11 };
  const plan = planNotification(previous, scan({ values: 12, occurrences: 15 }));
  assert.ok(plan);
  assert.equal(plan.title, '1 more sensitive value on this page');
  assert.equal(plan.message, '12 values now highlighted on native.anonymice.test:8787.');
});

test('a navigation is a fresh page, even with the same count', () => {
  const previous = { url: 'http://native.anonymice.test:8787/', values: 11 };
  const plan = planNotification(previous, scan({ url: 'http://native.anonymice.test:8787/other' }));
  assert.ok(plan);
  assert.equal(plan.title, 'Sensitive data on this page');
});

test('singulars read correctly', () => {
  const plan = planNotification(null, scan({ values: 1, occurrences: 1, byClass: { IBAN: 1 } }));
  assert.equal(plan?.message, '1 sensitive value in 1 place on native.anonymice.test:8787.');
});

test('the breakdown is commonest-first and skips empty classes', () => {
  assert.equal(breakdown({ PERSON: 2, IBAN: 5, CARD: 0, AHV: 2 }), '5 IBAN · 2 AHV · 2 PERSON');
});
