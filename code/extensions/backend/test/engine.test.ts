import assert from 'node:assert/strict';
import test from 'node:test';
import { detectCacheKey, LruCache } from '../src/detect/cache.ts';
import { canonicalise, DetectEngine, DetectionUnavailable } from '../src/detect/engine.ts';
import { UnavailableModelPass, type ModelPass } from '../src/detect/model.ts';
import { chunkHash } from '../src/lib/hash.ts';
import type { DetectRequest, DetectSpan } from '../src/lib/protocol.ts';

function request(text: string, over: Partial<DetectRequest> = {}): DetectRequest {
  return {
    policyVersion: 'v1',
    locale: 'de-CH',
    hostClass: 'native',
    chunks: [{ id: 'c1', hash: chunkHash(text), text }],
    ...over,
  };
}

test('modelVersion covers both passes, so either one can invalidate a cache', () => {
  const engine = new DetectEngine();
  assert.equal(engine.modelVersion, 'rules-1+gazetteer-1');
});

test('a repeat call is served from the cache and is identical', async () => {
  const engine = new DetectEngine();
  const first = await engine.detect(request('IBAN CH93 0076 2011 6238 5295 7'));
  const before = engine.stats.hits;
  const second = await engine.detect(request('IBAN CH93 0076 2011 6238 5295 7'));
  assert.deepEqual(second, first);
  assert.equal(engine.stats.hits, before + 1);
});

test('a policyVersion or locale bump misses the cache', async () => {
  const engine = new DetectEngine();
  await engine.detect(request('044 668 18 00'));
  const misses = engine.stats.misses;
  await engine.detect(request('044 668 18 00', { policyVersion: 'v2' }));
  assert.equal(engine.stats.misses, misses + 1);
  await engine.detect(request('044 668 18 00', { locale: 'de-DE' }));
  assert.equal(engine.stats.misses, misses + 2);
});

test('normalisation follows the locale, which is why it is in the cache key', async () => {
  const engine = new DetectEngine();
  const swiss = await engine.detect(request('044 668 18 00'));
  const german = await engine.detect(request('044 668 18 00', { locale: 'de-DE' }));
  const phone = (r: typeof swiss): string | undefined => r.chunks[0]?.spans.find((s) => s.cls === 'PHONE')?.normalized;
  assert.equal(phone(swiss), '+41446681800');
  assert.equal(phone(german), '+49446681800');
});

test('a wrong client hash is counted and never used as a cache key', async () => {
  const engine = new DetectEngine();
  const text = 'Anna Meier';
  await engine.detect({ policyVersion: 'v1', locale: 'de-CH', hostClass: 'native', chunks: [{ id: 'c1', hash: 'sha256:wrong', text }] });
  assert.equal(engine.stats.hashMismatches, 1);

  // A second client sends the same lie over different text: it must not collide.
  const other = await engine.detect({
    policyVersion: 'v1',
    locale: 'de-CH',
    hostClass: 'native',
    chunks: [{ id: 'c1', hash: 'sha256:wrong', text: 'IBAN CH93 0076 2011 6238 5295 7' }],
  });
  assert.ok(other.chunks[0]?.spans.some((s) => s.cls === 'IBAN'));
  assert.equal(other.chunks[0]?.hash, 'sha256:wrong', 'the client hash is echoed even when wrong');
});

test('a failing pass throws rather than returning what did work', async () => {
  const engine = new DetectEngine({ model: new UnavailableModelPass() });
  await assert.rejects(() => engine.detect(request('IBAN CH93 0076 2011 6238 5295 7')), DetectionUnavailable);
});

test('spans come back in a total order with duplicates collapsed by precedence', () => {
  const span = (start: number, end: number, cls: DetectSpan['cls'], origin: DetectSpan['origin']): DetectSpan => ({ start, end, cls, normalized: 'x', origin });
  const out = canonicalise([
    span(10, 20, 'IBAN', 'rule'),
    span(0, 5, 'PERSON', 'model'),
    span(10, 20, 'IBAN', 'model'),
    span(0, 9, 'ORG', 'model'),
  ]);
  assert.deepEqual(
    out.map((s) => [s.start, s.end, s.cls, s.origin]),
    [
      [0, 5, 'PERSON', 'model'],
      [0, 9, 'ORG', 'model'],
      [10, 20, 'IBAN', 'rule'],
    ],
  );
});

test('overlaps survive: narrowing is the client\'s merge to do, not the backend\'s', () => {
  const out = canonicalise([
    { start: 0, end: 10, cls: 'PERSON', normalized: 'a', origin: 'model' },
    { start: 4, end: 14, cls: 'ORG', normalized: 'b', origin: 'rule' },
  ]);
  assert.equal(out.length, 2);
});

test('the LRU evicts the oldest and counts what it did', () => {
  const cache = new LruCache<number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, 'b was least recently used');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.stats.evictions, 1);
});

test('the cache key carries every version the answer depends on', () => {
  assert.equal(detectCacheKey('sha256:x', 'rules-1+m', 'v1', 'de-CH'), 'sha256:x|rules-1+m|v1|de-CH');
});

test('a model pass returning nothing is a valid answer; only a throw is a failure', async () => {
  const silent: ModelPass = { version: 'silent-1', detect: async () => [] };
  const engine = new DetectEngine({ model: silent });
  const out = await engine.detect(request('nothing sensitive here'));
  assert.deepEqual(out.chunks[0]?.spans, []);
});
