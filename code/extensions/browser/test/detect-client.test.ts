import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DetectClient } from '../src/background/detect-client.ts';
import { DEFAULT_POLICY } from '../src/lib/policy.ts';
import type { DetectChunkRequest } from '../src/lib/protocol.ts';

const chunk = (id: string, text: string): DetectChunkRequest => ({ id, hash: `sha256:${text}`, text });

function stubFetch(handler: (body: any) => { status?: number; body?: unknown }) {
  const calls: any[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    const { status = 200, body: out = { modelVersion: 'm1', policyVersion: 'p1', chunks: body.chunks.map((c: any) => ({ id: c.id, hash: c.hash, spans: [] })) } } = handler(body);
    return { ok: status >= 200 && status < 300, status, json: async () => out } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('a cached chunk is never sent again (SPEC §3.2)', async () => {
  const { impl, calls } = stubFetch(() => ({}));
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl });
  await client.detect([chunk('c1', 'Anna Meier')]);
  await client.detect([chunk('c2', 'Anna Meier')]);
  assert.equal(calls.length, 1, 'second call was a cache hit');
  assert.equal(client.cacheSize, 1);
});

test('the credential is attached by the worker, and no page data rides along', async () => {
  let headers: Record<string, string> = {};
  const impl = (async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);
    assert.deepEqual(Object.keys(body).sort(), ['chunks', 'hostClass', 'locale', 'policyVersion']);
    return { ok: true, status: 200, json: async () => ({ modelVersion: 'm', policyVersion: 'p', chunks: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  await new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl }).detect([chunk('c1', 'x')]);
  assert.equal(headers['authorization'], `Bearer ${DEFAULT_POLICY.detectToken}`);
});

test('413 makes the client re-split rather than give up', async () => {
  const { impl, calls } = stubFetch((body) => (body.chunks.length > 1 ? { status: 413 } : {}));
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl });
  const res = await client.detect([chunk('c1', 'a'), chunk('c2', 'b')]);
  assert.equal(res?.chunks.length, 2);
  assert.ok(calls.length >= 3, 'one oversized attempt, then the halves');
});

test('failure returns null so the caller can say "not scanned"', async () => {
  const impl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl, maxAttempts: 1 });
  assert.equal(await client.detect([chunk('c1', 'a')]), null);
});

test('the circuit opens after repeated failure and closes after the cooldown', async () => {
  let clock = 0;
  let attempts = 0;
  const impl = (async () => { attempts++; throw new Error('offline'); }) as unknown as typeof fetch;
  const client = new DetectClient({
    policy: DEFAULT_POLICY, fetchImpl: impl, maxAttempts: 1, breakerThreshold: 2,
    breakerCooldownMs: 1000, now: () => clock,
  });
  await client.detect([chunk('a', 'a')]);
  await client.detect([chunk('b', 'b')]);
  assert.equal(client.circuitOpen, true);

  const before = attempts;
  await client.detect([chunk('c', 'c')]);
  assert.equal(attempts, before, 'open circuit does not hit the network');

  clock = 2000;
  assert.equal(client.circuitOpen, false, 'cooldown elapsed');
});

test('cache stays bounded', async () => {
  const { impl } = stubFetch(() => ({}));
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl, cacheSize: 3 });
  for (let i = 0; i < 10; i++) await client.detect([chunk(`c${i}`, `text-${i}`)]);
  assert.equal(client.cacheSize, 3);
});

test('a model version bump invalidates the cache (SPEC §3.2, §9)', async () => {
  let version = 'det-1';
  const { impl, calls } = stubFetch((body) => ({
    body: { modelVersion: version, policyVersion: 'p1', chunks: body.chunks.map((c: any) => ({ id: c.id, hash: c.hash, spans: [] })) },
  }));
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl });

  await client.detect([chunk('c1', 'Anna Meier')]);
  await client.detect([chunk('c2', 'Anna Meier')]);
  assert.equal(calls.length, 1, 'same model, same text: cache hit');

  version = 'det-2';
  // The client cannot know the bump until it asks again, so it asks once more...
  await client.detect([chunk('c3', 'Peter Schmid')]);
  const after = calls.length;
  // ...and from then on the old entries are unreachable.
  await client.detect([chunk('c4', 'Anna Meier')]);
  assert.equal(calls.length, after + 1, 'spans from the retired model are never served');
});

test('the host class travels with the request (SPEC §3.2)', async () => {
  const { impl, calls } = stubFetch(() => ({}));
  const client = new DetectClient({ policy: DEFAULT_POLICY, fetchImpl: impl });
  await client.detect([chunk('c1', 'Anna Meier')], 'trusted');
  assert.equal(calls[0].hostClass, 'trusted');

  await client.detect([chunk('c2', 'Peter Schmid')]);
  assert.equal(calls[1].hostClass, 'native', 'defaults to native when unspecified');
});
