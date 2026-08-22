import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSubtree } from '../src/lib/project.ts';
import { SpanRegistry } from '../src/lib/registry.ts';
import type { Span } from '../src/lib/types.ts';
import { domFrom } from './helpers.ts';

const find = (text: string, needle: string, cls: Span['cls'], origin: Span['origin'] = 'rule'): Span => ({
  start: text.indexOf(needle),
  end: text.indexOf(needle) + needle.length,
  cls,
  origin,
});

test('the registry is keyed by value, not by occurrence (SPEC §5)', async () => {
  const doc = domFrom('<p>CH93 0076 2011 6238 5295 7</p><p>ch9300762011623852957</p>');
  const registry = new SpanRegistry();
  for (const chunk of projectSubtree(doc.body)) {
    const value = chunk.text.trim();
    await registry.add(chunk, find(chunk.text, value, 'IBAN'));
  }
  assert.equal(registry.size, 1, 'two formattings, one entry');
  assert.equal(registry.entries()[0]!.ranges.length, 2, 'both occurrences painted');
  assert.equal(registry.entries()[0]!.value, 'CH93 0076 2011 6238 5295 7', 'first formatting kept');
});

test('spanId is deterministic across registries and sessions', async () => {
  const idOf = async () => {
    const doc = domFrom('<p>CH93 0076 2011 6238 5295 7</p>');
    const registry = new SpanRegistry();
    const [chunk] = projectSubtree(doc.body);
    await registry.add(chunk!, find(chunk!.text, chunk!.text, 'IBAN'));
    return registry.entries()[0]!.spanId;
  };
  assert.equal(await idOf(), await idOf());
});

test('the class comes from the highest-precedence origin that matched', async () => {
  const doc = domFrom('<p>Anna Meier</p>');
  const registry = new SpanRegistry();
  const [chunk] = projectSubtree(doc.body);
  await registry.add(chunk!, find(chunk!.text, 'Anna Meier', 'ORG', 'model'));
  await registry.add(chunk!, find(chunk!.text, 'Anna Meier', 'PERSON', 'annotation'));
  assert.equal(registry.entries()[0]!.cls, 'PERSON');
  assert.equal(registry.entries()[0]!.origin, 'annotation');
});

test('revalidate drops ranges whose text moved, and entries that lose every range', async () => {
  const doc = domFrom('<p id="a">Anna Meier</p><p id="b">Anna Meier</p>');
  const registry = new SpanRegistry();
  for (const chunk of projectSubtree(doc.body)) {
    await registry.add(chunk, find(chunk.text, 'Anna Meier', 'PERSON'));
  }
  assert.equal(registry.entries()[0]!.ranges.length, 2);

  doc.getElementById('a')!.textContent = 'Peter Schmid';
  assert.deepEqual(registry.revalidate(), { dropped: 1, removed: 0 });
  assert.equal(registry.entries()[0]!.ranges.length, 1);

  doc.getElementById('b')!.remove();
  assert.deepEqual(registry.revalidate(), { dropped: 1, removed: 1 });
  assert.equal(registry.size, 0, 'the painter never holds a phantom');
});

test('tokens are absent until something mints one (SPEC §5)', async () => {
  const doc = domFrom('<p>Anna Meier</p>');
  const registry = new SpanRegistry();
  const [chunk] = projectSubtree(doc.body);
  const { entry } = await registry.add(chunk!, find(chunk!.text, 'Anna Meier', 'PERSON'));
  assert.equal(entry.tokens, undefined, 'detection is read-only');
});
