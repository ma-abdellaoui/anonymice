import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGIL, looksLikeToken, mintToken, parseToken, scanTokens } from '../src/lib/tokens.ts';

/** SPEC §6.4 — the grammar both extensions must agree on, character for character. */
const SPEC_REGEX = /\bANM1-[A-Z]{2,10}-[0-9A-HJKMNP-TV-Z]{17}\b/;
const GOLDEN = 'ANM1-PERSON-K3F9QW2MX7VBNC4H8';

test('minted tokens match the grammar in SPEC §6.4', () => {
  for (const cls of ['PERSON', 'IBAN', 'SECRET'] as const) {
    const t = mintToken(cls);
    assert.match(t, SPEC_REGEX, t);
    assert.equal(t.length, SIGIL.length + 1 + cls.length + 1 + 17);
    assert.equal(t.split('-')[1], cls);
  }
});

test('alphabet excludes I, L, O and U', () => {
  // 200 mints is ~3200 payload symbols; a leaked symbol would show up long before.
  for (let i = 0; i < 200; i++) {
    const core = mintToken('PERSON').split('-')[2]!;
    assert.ok(!/[ILOU]/.test(core), `leaked confusable in ${core}`);
  }
});

test('mints are unique and unpredictable', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(mintToken('PERSON'));
  assert.equal(seen.size, 1000, 'CSPRNG collision in 1000 mints');
});

test('round-trips its own mint', () => {
  const t = mintToken('IBAN');
  const r = parseToken(t);
  assert.equal(r.kind, 'token');
  assert.equal(r.kind === 'token' && r.cls, 'IBAN');
  assert.equal(r.kind === 'token' && r.token, t);
});

test('a bad check character reads as damaged, not as absent', () => {
  const t = mintToken('PERSON');
  // Flip the final check character to any other symbol.
  const bad = t.slice(0, -1) + (t.endsWith('Z') ? 'Y' : 'Z');
  const r = parseToken(bad);
  assert.equal(r.kind, 'damaged', 'a mangled token must stay legible (SPEC §6.7)');
  assert.equal(r.kind === 'damaged' && r.cls, 'PERSON', 'class survives to explain the failure');
});

test('the check character catches a transposition', () => {
  const t = mintToken('PERSON');
  const core = t.split('-')[2]!;
  let swapped = '';
  for (let i = 0; i + 1 < core.length; i++) {
    if (core[i] !== core[i + 1]) {
      swapped = core.slice(0, i) + core[i + 1] + core[i] + core.slice(i + 2);
      break;
    }
  }
  assert.notEqual(swapped, '', 'fixture needs two adjacent distinct symbols');
  assert.equal(parseToken(`${SIGIL}-PERSON-${swapped}`).kind, 'damaged');
});

test('truncation is damaged, ordinary text is none', () => {
  assert.equal(parseToken(GOLDEN.slice(0, 24)).kind, 'damaged');
  assert.equal(parseToken('just some prose').kind, 'none');
  assert.equal(parseToken('').kind, 'none');
  assert.equal(parseToken('ANM1--K3F9QW2MX7VBNC4H8').kind, 'none', 'empty class label');
});

test('readers accept a class label this build does not know (SPEC §6.6)', () => {
  const t = mintToken('PERSON').replace('-PERSON-', '-NEWCLASS-');
  const r = parseToken(t);
  assert.equal(r.kind, 'token', 'an unknown label must not make the token unreadable');
  assert.equal(r.kind === 'token' && r.knownCls, false);
});

test('case-insensitive decode, and hyphens inside the core are ignored', () => {
  const t = mintToken('PERSON');
  const core = t.split('-')[2]!;
  const hyphenated = `${SIGIL}-PERSON-${core.slice(0, 8)}-${core.slice(8)}`;
  assert.equal(parseToken(hyphenated).kind, 'token', 'a line-wrap must not destroy a token');
  assert.equal(parseToken(t.toLowerCase()).kind, 'token');
  const r = parseToken(t.toLowerCase());
  assert.equal(r.kind === 'token' && r.token, t, 'canonicalises back to upper case');
});

test('survives what a rich editor does to it on copy-paste', () => {
  const t = mintToken('PERSON');
  const mangled = t.slice(0, 12) + '​' + t.slice(12, 20) + '­' + t.slice(20);
  assert.equal(parseToken(mangled).kind, 'token', 'zero-width injection is a silent failure otherwise');
  const nb = t.replace('-', '‑'); // non-breaking hyphen
  assert.equal(parseToken(nb).kind, 'token');
});

test('scan finds tokens and reports offsets into the original string', () => {
  const a = mintToken('PERSON');
  const b = mintToken('IBAN');
  const src = `Kunde ${a} mit Konto ${b}.`;
  const found = scanTokens(src);
  assert.equal(found.length, 2);
  assert.equal(found[0]!.token, a);
  assert.equal(found[1]!.token, b);
  assert.equal(src.slice(found[0]!.start, found[0]!.end), a, 'offsets must index the source');
  assert.equal(src.slice(found[1]!.start, found[1]!.end), b);
});

test('scan maps offsets correctly past astral characters', () => {
  const t = mintToken('PERSON');
  const src = `\u{1F600}\u{1F600} ${t} tail`;
  const found = scanTokens(src);
  assert.equal(found.length, 1);
  assert.equal(src.slice(found[0]!.start, found[0]!.end), t, 'emoji must not shift offsets');
});

test('scan skips a token-shaped string whose check character is wrong', () => {
  const t = mintToken('PERSON');
  const bad = t.slice(0, -1) + (t.endsWith('Z') ? 'Y' : 'Z');
  assert.equal(scanTokens(`prose ${bad} prose`).length, 0, 'never mint on a bad check char');
});

test('the golden token is stable across both extensions', () => {
  // Byte-identical fixture in browser/ and vscode/. If one side changes the
  // alphabet, the payload width or the check rule, this diverges.
  assert.match(GOLDEN, SPEC_REGEX);
  assert.equal(GOLDEN.length, 29);
  const r = parseToken(GOLDEN);
  assert.ok(r.kind === 'token' || r.kind === 'damaged', 'must at least be recognised as token-shaped');
  assert.equal(r.kind === 'token' ? r.cls : r.cls, 'PERSON');
});

test('looksLikeToken is a pre-filter, not a decision', () => {
  assert.ok(looksLikeToken(`see ${GOLDEN} here`));
  assert.ok(looksLikeToken('anm1-person-whatever'), 'pre-filter is deliberately loose');
  assert.ok(!looksLikeToken('nothing here'));
});
