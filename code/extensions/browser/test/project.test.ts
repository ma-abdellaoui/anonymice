import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSubtree, rangeFor } from '../src/lib/project.ts';
import { domFrom } from './helpers.ts';

test('entities straddling inline elements stay in one chunk', () => {
  const doc = domFrom('<p>Sachbearbeiterin <b>Anna</b> Meier heute.</p>');
  const [chunk] = projectSubtree(doc.body);
  assert.ok(chunk);
  assert.equal(chunk.text, 'Sachbearbeiterin Anna Meier heute.');
});

test('source indentation collapses but the range still maps back exactly', () => {
  const doc = domFrom(`<p>
      Konto:
      <span>CH93</span>  <span>0076</span>
   </p>`);
  const [chunk] = projectSubtree(doc.body);
  assert.ok(chunk);
  assert.equal(chunk.text, 'Konto: CH93 0076');

  const at = chunk.text.indexOf('CH93');
  const range = rangeFor(chunk, at, at + 'CH93 0076'.length);
  assert.ok(range);
  assert.equal(range.toString().replace(/\s+/g, ' '), 'CH93 0076');
});

test('a <br> contributes a separator', () => {
  const doc = domFrom('<p>Grüsse<br>Peter Schmid</p>');
  const [chunk] = projectSubtree(doc.body);
  assert.equal(chunk?.text, 'Grüsse Peter Schmid');
});

test('block boundaries split chunks', () => {
  const doc = domFrom('<div><p>Anna Meier</p><p>Peter Schmid</p></div>');
  const chunks = projectSubtree(doc.body);
  assert.deepEqual(chunks.map((c) => c.text), ['Anna Meier', 'Peter Schmid']);
});

test('editables, code and our own UI are never scanned on NATIVE (SPEC §3.5)', () => {
  const doc = domFrom(`
    <input value="CH93 0076 2011 6238 5295 7">
    <textarea>Anna Meier</textarea>
    <div contenteditable="true">Beat Frei</div>
    <code>const x = "Claudia Weber";</code>
    <pre>Marco Rossi</pre>
    <div data-anonymice="pill">Nadia Keller</div>
    <p>Thomas Brunner</p>`);
  const text = projectSubtree(doc.body).map((c) => c.text).join(' | ');
  assert.equal(text, 'Thomas Brunner');
});

test('contenteditable="false" is scannable', () => {
  const doc = domFrom('<div contenteditable="false"><p>Anna Meier</p></div>');
  assert.equal(projectSubtree(doc.body)[0]?.text, 'Anna Meier');
});

test('ranges survive astral characters, because offsets are UTF-16 code units', () => {
  const doc = domFrom('<p>👨‍👩‍👧‍👦 Konto CH93 0076 2011 6238 5295 7 prüfen</p>');
  const [chunk] = projectSubtree(doc.body);
  assert.ok(chunk);
  const at = chunk.text.indexOf('CH93');
  const range = rangeFor(chunk, at, at + 26);
  assert.equal(range?.toString(), 'CH93 0076 2011 6238 5295 7');
});
