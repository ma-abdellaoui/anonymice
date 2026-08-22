import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSensitive, inspect, type KnownValue } from '../src/lib/egress.ts';
import { normalizeValue } from '../src/lib/normalize.ts';
import type { Cls } from '../src/lib/types.ts';

const IBAN = 'CH93 0076 2011 6238 5295 7';
const CARD = '4242 4242 4242 4242';
const AHV = '756.1234.5678.97';

const known = (cls: Cls, value: string): KnownValue => ({
  cls,
  value,
  normalized: normalizeValue(cls, value),
});

/** A vault that has already minted for everything it is asked about. */
const generous = (normalized: string, cls: Cls): string =>
  `ANM1-${cls}-K3F9QW2MX7VBNC4H${normalized.length % 10}`;
const empty = (): undefined => undefined;

test('a body with nothing sensitive in it is clean', () => {
  const verdict = inspect('{"op":"insert","text":"hello there"}', [], generous);
  assert.equal(verdict.kind, 'clean');
});

test('a typed-in-place IBAN is caught with no registry at all', () => {
  const found = findSensitive(`{"text":"${IBAN}"}`, []);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.cls, 'IBAN');
  assert.equal(found[0]!.via, 'checksum', 'pass 2 is what covers the case §10.1 is about');
});

test('a checksum failure is not a match', () => {
  // One digit off — same shape, invalid mod-97.
  assert.equal(findSensitive('CH93 0076 2011 6238 5295 8', []).length, 0);
  assert.equal(findSensitive('4242 4242 4242 4243', []).length, 0);
});

test('CARD, AHV and EMAIL are each anchored on their own check', () => {
  const classes = findSensitive(`${CARD} / ${AHV} / anna.meier@example.ch`, []).map((m) => m.cls);
  assert.deepEqual(classes.sort(), ['AHV', 'CARD', 'EMAIL']);
});

test('a PERSON is only findable through the registry — it has no shape to anchor on', () => {
  const body = '{"text":"call Anna Meier tomorrow"}';
  assert.equal(findSensitive(body, []).length, 0, 'pass 2 cannot see it');
  const found = findSensitive(body, [known('PERSON', 'Anna Meier')]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.via, 'registry');
});

test('a token in the body is left alone — that is the system working', () => {
  const body = 'ref ANM1-IBAN-K3F9QW2MX7VBNC4H8 confirmed';
  assert.deepEqual(findSensitive(body, []), []);
  assert.equal(inspect(body, [], empty).kind, 'clean');
});

test('substitution replaces every match and returns a forwardable body', () => {
  const body = `{"iban":"${IBAN}","who":"Anna Meier"}`;
  const verdict = inspect(body, [known('PERSON', 'Anna Meier')], generous);
  assert.equal(verdict.kind, 'substituted');
  if (verdict.kind !== 'substituted') return;
  assert.ok(!verdict.body.includes(IBAN), 'the IBAN is gone');
  assert.ok(!verdict.body.includes('Anna Meier'), 'so is the name');
  assert.ok(verdict.body.includes('ANM1-IBAN-'));
  assert.ok(verdict.body.includes('ANM1-PERSON-'));
  assert.equal(verdict.replaced.length, 2);
  // The envelope has to survive, or the app's protocol breaks on our account.
  assert.deepEqual(Object.keys(JSON.parse(verdict.body)).sort(), ['iban', 'who']);
});

test('a value with no token blocks the whole body, not just its own span', () => {
  const body = `{"iban":"${IBAN}","who":"Anna Meier"}`;
  // Vault has the person but not the IBAN.
  const partial = (normalized: string, cls: Cls): string | undefined =>
    cls === 'PERSON' ? generous(normalized, cls) : undefined;

  const verdict = inspect(body, [known('PERSON', 'Anna Meier')], partial);
  assert.equal(verdict.kind, 'blocked', 'fail closed — SPEC §10.4');
  if (verdict.kind !== 'blocked') return;
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.missing[0]!.cls, 'IBAN');
  // What the vault owes us, so the bridge can mint exactly that and no more.
  assert.equal(verdict.missing[0]!.normalized, normalizeValue('IBAN', IBAN));
});

test('registry wins over checksum on the same characters', () => {
  // The detector called it UNKNOWN; the local pass would guess IBAN. §3.3 says
  // the detector's claim is the stronger one.
  const found = findSensitive(`pay ${IBAN} now`, [known('UNKNOWN', IBAN)]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.cls, 'UNKNOWN');
  assert.equal(found[0]!.via, 'registry');
});

test('the longest known value wins, so a substring does not shadow it', () => {
  const body = 'ship to Bahnhofstrasse 1, 8001 Zurich please';
  const found = findSensitive(body, [
    known('ADDR', 'Bahnhofstrasse 1, 8001 Zurich'),
    known('ORG', 'Bahnhofstrasse 1'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.cls, 'ADDR');
});

test('every occurrence of the same value is replaced', () => {
  const body = `${IBAN} and again ${IBAN}`;
  const verdict = inspect(body, [], generous);
  assert.equal(verdict.kind, 'substituted');
  if (verdict.kind !== 'substituted') return;
  assert.ok(!verdict.body.includes(IBAN));
  assert.equal(verdict.replaced.length, 2);
});

test('normalisation is what makes the token lookup hit across formatting', () => {
  const spaced = findSensitive(`x ${IBAN} y`, [])[0]!;
  const compact = findSensitive('x CH9300762011623852957 y', [])[0]!;
  assert.equal(spaced.normalized, compact.normalized, 'same vault entry either way');
});
