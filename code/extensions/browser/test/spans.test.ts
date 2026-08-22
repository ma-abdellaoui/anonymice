import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSpans } from '../src/lib/spans.ts';
import type { Span } from '../src/lib/types.ts';

const span = (start: number, end: number, cls: Span['cls'], origin: Span['origin']): Span =>
  ({ start, end, cls, origin });

test('class comes from the higher-precedence origin, extent is the union (SPEC §3.3)', () => {
  const merged = mergeSpans([
    span(10, 30, 'PERSON', 'model'),
    span(14, 24, 'IBAN', 'annotation'),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { start: 10, end: 30, cls: 'IBAN', origin: 'annotation' });
});

test('a span is never narrowed by a higher-ranked one', () => {
  const merged = mergeSpans([span(0, 40, 'PERSON', 'model'), span(5, 9, 'ORG', 'annotation')]);
  assert.equal(merged[0]!.start, 0);
  assert.equal(merged[0]!.end, 40);
});

test('widening runs to a fixpoint', () => {
  // c overlaps b only after a and b have merged.
  const merged = mergeSpans([
    span(0, 10, 'PERSON', 'model'),
    span(8, 20, 'PERSON', 'rule'),
    span(18, 30, 'ORG', 'model'),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0]!.start, merged[0]!.end, merged[0]!.origin], [0, 30, 'rule']);
});

test('touching spans are not overlapping', () => {
  const merged = mergeSpans([span(0, 10, 'PERSON', 'rule'), span(10, 20, 'IBAN', 'rule')]);
  assert.equal(merged.length, 2);
});

test('equal precedence: the longer extent carries the class', () => {
  const merged = mergeSpans([span(0, 5, 'ORG', 'rule'), span(2, 20, 'IBAN', 'rule')]);
  assert.equal(merged[0]!.cls, 'IBAN');
});

test('empty spans are dropped', () => {
  assert.deepEqual(mergeSpans([span(4, 4, 'PERSON', 'rule')]), []);
});
