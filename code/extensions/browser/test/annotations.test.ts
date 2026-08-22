import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotationSpans } from '../src/lib/annotations.ts';
import { projectSubtree } from '../src/lib/project.ts';
import { domFrom } from './helpers.ts';

const spansOf = (html: string) =>
  projectSubtree(domFrom(html).body).flatMap((c) =>
    annotationSpans(c).map((s) => ({ ...s, text: c.text.slice(s.start, s.end) })),
  );

test('an annotated element yields a span with its class', () => {
  const spans = spansOf('<p>Kunde <span data-sensitive="PERSON">Anna Meier</span> heute</p>');
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.cls, 'PERSON');
  assert.equal(spans[0]!.text, 'Anna Meier');
  assert.equal(spans[0]!.origin, 'annotation');
});

test('the container itself may carry the attribute', () => {
  const spans = spansOf('<table><tr><td data-sensitive="IBAN">CH93 0076 2011 6238 5295 7</td></tr></table>');
  assert.equal(spans[0]?.text, 'CH93 0076 2011 6238 5295 7');
});

test('a bare data-sensitive means sensitive, class unknown (SPEC §3.4)', () => {
  const spans = spansOf('<p><span data-sensitive>interne Notiz</span></p>');
  assert.equal(spans[0]?.cls, 'UNKNOWN');
});

test('an unrecognised class is kept as UNKNOWN, never dropped', () => {
  const spans = spansOf('<p><span data-sensitive="SHOE-SIZE">interne Notiz</span></p>');
  assert.equal(spans[0]?.cls, 'UNKNOWN');
});

test('nested annotations resolve innermost-first', () => {
  const spans = spansOf(
    '<p data-sensitive="ADDR">Bahnhofstrasse 1, <span data-sensitive="PERSON">Anna Meier</span></p>',
  );
  assert.equal(spans[0]!.cls, 'PERSON', 'innermost first');
  assert.equal(spans[1]!.cls, 'ADDR');
});

test('there is no suppressing form: annotations only ever add', () => {
  // data-sensitive="none" is not special-cased anywhere; it just reads as UNKNOWN.
  const spans = spansOf('<p><span data-sensitive="none">Anna Meier</span></p>');
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.cls, 'UNKNOWN');
});
