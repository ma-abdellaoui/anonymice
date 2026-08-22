import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPainter, HIGHLIGHT_NAME } from '../src/content/painter.ts';
import { domFrom } from './helpers.ts';

function rangeOver(doc: Document, selector: string): Range {
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector(selector)!);
  return range;
}

test('falls back to the overlay backend where the Highlight API is missing', () => {
  const doc = domFrom('<p id="a">Anna Meier</p>');
  const painter = createPainter(doc);
  assert.equal(painter.backend, 'overlay');

  painter.paint([rangeOver(doc, '#a')]);
  assert.ok(doc.querySelector('[data-anonymice="highlight-layer"]'), 'layer is marked as ours');
  painter.clear();
  assert.equal(doc.querySelector('[data-anonymice="highlight-layer"]'), null);
});

test('uses the Highlight API when the engine has one, and injects the rule once', () => {
  const doc = domFrom('<p id="a">Anna Meier</p>');
  const view = doc.defaultView as unknown as Record<string, unknown>;
  const sets: Array<[string, unknown]> = [];
  const deletes: string[] = [];
  view.CSS = {
    highlights: {
      set: (name: string, hl: unknown) => sets.push([name, hl]),
      delete: (name: string) => deletes.push(name),
    },
  };
  class FakeHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  view.Highlight = FakeHighlight;

  const painter = createPainter(doc);
  assert.equal(painter.backend, 'highlight');

  painter.paint([rangeOver(doc, '#a'), rangeOver(doc, '#a')]);
  assert.equal(sets.length, 1, 'one Highlight object holds every range');
  assert.equal(sets[0]![0], HIGHLIGHT_NAME);
  assert.equal((sets[0]![1] as FakeHighlight).ranges.length, 2);

  const styles = doc.querySelectorAll('style[data-anonymice="highlight-style"]');
  assert.equal(styles.length, 1);
  assert.match(styles[0]!.textContent!, /::highlight\(anonymice-sensitive\)/);

  painter.paint([rangeOver(doc, '#a')]);
  assert.equal(doc.querySelectorAll('style[data-anonymice="highlight-style"]').length, 1, 'injected once');

  // Dim/undim is one registry operation, and keeps what was detected.
  painter.setDimmed(true);
  assert.deepEqual(deletes, [HIGHLIGHT_NAME]);
  painter.setDimmed(false);
  assert.equal(sets.length, 3, 'undim repaints the same ranges');
});

test('the painter never mutates the text, so selection is unchanged', () => {
  const doc = domFrom('<p id="a">Anna Meier</p>');
  const before = doc.body.textContent;
  const painter = createPainter(doc);
  painter.paint([rangeOver(doc, '#a')]);
  assert.equal(doc.querySelector('#a')!.textContent, 'Anna Meier');
  assert.equal(doc.querySelector('#a')!.childNodes.length, 1, 'no wrapper nodes inserted');
  painter.clear();
  assert.equal(doc.body.textContent, before);
});
