import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectChunk, MODEL_VERSION } from '../mock/rules.ts';
import { runPipeline, type Detector } from '../src/lib/pipeline.ts';
import type { DetectChunkRequest, DetectResponse } from '../src/lib/protocol.ts';
import { domFrom } from './helpers.ts';

const backend = (locale = 'de-CH'): Detector => ({
  async detect(chunks: DetectChunkRequest[]): Promise<DetectResponse> {
    return {
      modelVersion: MODEL_VERSION,
      policyVersion: 'test',
      chunks: chunks.map((c) => ({ id: c.id, hash: c.hash, spans: detectChunk(c.text, locale) })),
    };
  },
});

test('annotation hints cross the wire, and nothing else structural does (SPEC §3.2)', async () => {
  const doc = domFrom('<p><span data-sensitive="PERSON">Anna Meier</span> ruft an</p>');
  let seen: DetectChunkRequest[] = [];
  await runPipeline(doc.body, {
    async detect(chunks) {
      seen = chunks;
      return null;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.text, 'Anna Meier ruft an');
  assert.deepEqual(seen[0]!.hints, [{ start: 0, end: 10, cls: 'PERSON', origin: 'annotation' }]);
  assert.ok(seen[0]!.hash.startsWith('sha256:'));
  assert.equal(Object.keys(seen[0]!).sort().join(','), 'hash,hints,id,text', 'no HTML, no URL');
});

test('a failed detection is "not scanned", and annotations still apply', async () => {
  const doc = domFrom('<p><span data-sensitive="IBAN">CH93 0076 2011 6238 5295 7</span></p>');
  const result = await runPipeline(doc.body, { async detect() { return null; } });
  assert.equal(result.unscanned, true, 'the badge must say so, not stay silent');
  assert.equal(result.registry.size, 1, 'annotations are DOM facts, not guesses');
});

test('the staleness guard discards a chunk whose text changed in flight', async () => {
  const doc = domFrom('<p id="p">Kunde Anna Meier</p>');
  const result = await runPipeline(doc.body, {
    async detect(chunks) {
      // The page mutates while the request is out.
      doc.getElementById('p')!.textContent = 'Kunde Peter Schmid';
      return {
        modelVersion: MODEL_VERSION,
        policyVersion: 'test',
        chunks: chunks.map((c) => ({ id: c.id, hash: c.hash, spans: detectChunk(c.text, 'de-CH') })),
      };
    },
  });
  assert.equal(result.stale, 1);
  assert.equal(result.registry.size, 0, 'stale spans are never painted');
});

test('all three layers land in one registry', async () => {
  const doc = domFrom(`
    <p><span data-sensitive>interne Notiz</span></p>
    <p>IBAN CH93 0076 2011 6238 5295 7</p>
    <p>Kunde Anna Meier</p>`);
  const { registry } = await runPipeline(doc.body, backend(), { locale: 'de-CH' });
  const byOrigin = Object.fromEntries(registry.entries().map((e) => [e.origin, e.cls]));
  assert.deepEqual(byOrigin, { annotation: 'UNKNOWN', rule: 'IBAN', model: 'PERSON' });
});

test('detection is deterministic: same page, same spans (SPEC §3.2)', async () => {
  const run = async () => {
    const doc = domFrom('<p>Anna Meier, IBAN CH93 0076 2011 6238 5295 7</p>');
    const { registry } = await runPipeline(doc.body, backend(), { locale: 'de-CH' });
    return registry.entries().map((e) => `${e.cls}:${e.normalized}`).sort();
  };
  assert.deepEqual(await run(), await run());
});
