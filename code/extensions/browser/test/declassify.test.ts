import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fold,
  judgeEdit,
  longestCommonSubstring,
  shareThreshold,
  stillClassifies,
} from '../src/lib/declassify.ts';

const IBAN = 'CH93 0076 2011 6238 5295 7';

test('a genuine replacement is written through (SPEC §8.5)', () => {
  assert.deepEqual(judgeEdit('IBAN', 'invoice ref 12', IBAN), { kind: 'declassify' });
});

test('every fragment of the resolved plaintext is refused', () => {
  // Prefix, at every length — the typed-prefix leak by another route.
  for (const len of [1, 2, 4, 8, 12, 20]) {
    const prefix = IBAN.replace(/\s/g, '').slice(0, len);
    const verdict = judgeEdit('IBAN', prefix, IBAN);
    assert.equal(verdict.kind, 'refuse', `prefix of length ${len} must not be written through`);
  }
});

test('a truncation from the other end is a fragment, not a replacement', () => {
  assert.equal(judgeEdit('IBAN', '6238 5295 7', IBAN).kind, 'refuse');
});

test('re-spacing is the same secret, and is refused', () => {
  assert.equal(judgeEdit('IBAN', 'CH930076201162385295', IBAN).kind, 'refuse');
  assert.equal(judgeEdit('IBAN', 'CH-93-0076-2011', IBAN).kind, 'refuse');
});

test('a hand-typed second IBAN is not a declassification (SPEC §8.5)', () => {
  // Different IBAN, valid mod-97.
  const other = 'CH56 0483 5012 3456 7800 9';
  const verdict = judgeEdit('IBAN', other, IBAN);
  assert.equal(verdict.kind, 'tokenize');
  assert.equal(verdict.kind === 'tokenize' && verdict.normalized, 'CH5604835012345678009');
});

test('an unchanged value is a token, not a decision', () => {
  assert.equal(judgeEdit('IBAN', IBAN, IBAN).kind, 'tokenize');
  assert.equal(judgeEdit('IBAN', 'ch9300762011623852957', IBAN).kind, 'tokenize');
});

test('clearing the field declassifies — an empty string holds no secret', () => {
  assert.deepEqual(judgeEdit('IBAN', '', IBAN), { kind: 'declassify' });
  assert.deepEqual(judgeEdit('IBAN', '   ', IBAN), { kind: 'declassify' });
});

test('the floor is relative, so a short value is judged more strictly', () => {
  assert.equal(shareThreshold(21), 4, 'anything of ordinary length');
  assert.equal(shareThreshold(8), 4);
  assert.equal(shareThreshold(5), 3);
  assert.equal(shareThreshold(4), 2);
  assert.equal(shareThreshold(2), 1);
});

test('a short secret cannot be leaked three characters at a time', () => {
  // A fixed floor of 4 would pass this: the value is only 5 long.
  assert.equal(judgeEdit('UNKNOWN', 'abc', 'abcde').kind, 'refuse');
});

test('an incidental short overlap is not a fragment', () => {
  // "invoice ref 12" and the IBAN share single digits and nothing longer.
  assert.equal(longestCommonSubstring(fold('invoice ref 12'), fold(IBAN)) < 4, true);
  assert.equal(judgeEdit('IBAN', 'invoice ref 12', IBAN).kind, 'declassify');
});

test('a four-character run of the secret is enough to refuse', () => {
  assert.equal(judgeEdit('IBAN', 'ref 6238 please', IBAN).kind, 'refuse');
  assert.equal(judgeEdit('IBAN', 'ref 623 please', IBAN).kind, 'declassify', 'three is under the floor');
});

test('free-text classes fall through to the fragment test, not to a guess', () => {
  // No checksum exists for PERSON, so nothing here claims to know it is a name.
  assert.equal(stillClassifies('PERSON', 'Anna Meier'), false);
  // The protection is the fragment test, and it still holds.
  assert.equal(judgeEdit('PERSON', 'Anna Mei', 'Anna Meier').kind, 'refuse');
  assert.equal(judgeEdit('PERSON', 'Bob', 'Anna Meier').kind, 'declassify');
});

test('checksums come from the same library the rule pass uses (SPEC §8.7.2)', () => {
  assert.equal(stillClassifies('IBAN', 'CH93 0076 2011 6238 5295 7'), true);
  assert.equal(stillClassifies('IBAN', 'CH93 0076 2011 6238 5295 8'), false, 'mod-97 must disagree');
  assert.equal(stillClassifies('CARD', '4242 4242 4242 4242'), true);
  assert.equal(stillClassifies('CARD', '4242 4242 4242 4243'), false);
  assert.equal(stillClassifies('EMAIL', 'anna@example.org'), true);
  assert.equal(stillClassifies('EMAIL', 'anna@example'), false);
});

test('longest common substring is exact, not an approximation', () => {
  assert.equal(longestCommonSubstring('', 'abc'), 0);
  assert.equal(longestCommonSubstring('abc', ''), 0);
  assert.equal(longestCommonSubstring('abcdef', 'zzcdezz'), 3);
  assert.equal(longestCommonSubstring('abcdef', 'abcdef'), 6);
  assert.equal(longestCommonSubstring('xyz', 'abc'), 0);
});

test('folding is what makes the comparison see through formatting', () => {
  assert.equal(fold('CH93 0076'), 'ch930076');
  assert.equal(fold('CH-93.0076'), 'ch930076');
  assert.equal(fold('  Anna  Meier '), 'annameier');
});
