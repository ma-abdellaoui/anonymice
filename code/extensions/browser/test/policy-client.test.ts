import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TTL_MS,
  PolicyClient,
  type CachedPolicy,
  type PolicyClientOptions,
  type PolicyStore,
} from '../src/background/policy-client.ts';

const PIN = 'https://detect.internal.example/v1/detect';

function memStore(seed: CachedPolicy | null = null): PolicyStore & { value: CachedPolicy | null } {
  const store = {
    value: seed,
    async read() {
      return store.value;
    },
    async write(v: CachedPolicy) {
      store.value = v;
    },
    async clear() {
      store.value = null;
    },
  };
  return store;
}

/** Minimal Response stand-in — only the three things the client reads. */
function reply(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function stub(replies: Array<() => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const next = replies[Math.min(i, replies.length - 1)]!;
    i++;
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (opts: Partial<PolicyClientOptions> & { store: PolicyStore }) =>
  new PolicyClient({
    endpoint: 'https://detect.internal.example/v1/policy',
    token: 'enrollment-token',
    pin: PIN,
    maxAttempts: 1,
    ...opts,
  });

test('a pulled list is sanitised before it can become a match pattern', async () => {
  const store = memStore();
  const { impl } = stub([
    () =>
      reply(200, {
        native: ['crm.internal.example', '*.clinic.example', '*', 'http://evil.example/x', 'a.example:8080'],
        trusted: ['docs.partner.example'],
        painter: 'overlay',
        policyEndpoint: 'https://attacker.example/v1/policy',
      }),
  ]);
  const result = await client({ store, fetchImpl: impl }).refresh();

  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.policy?.native, ['crm.internal.example', '*.clinic.example']);
  assert.equal(result.rejected.length, 5, 'three bad hosts and two non-remote keys, all reported');
  assert.ok(!('policyEndpoint' in (result.policy ?? {})), 'a response cannot redirect the next pull');
  assert.ok(!('painter' in (result.policy ?? {})), 'a local debugging knob does not cross the network');
});

test('the pull may not move the detector off the configured origin', async () => {
  const store = memStore();
  const { impl } = stub([
    () => reply(200, { native: ['a.example'], detectEndpoint: 'https://exfil.example/v1/detect' }),
  ]);
  const result = await client({ store, fetchImpl: impl }).refresh();
  assert.equal(result.policy?.detectEndpoint, undefined, 'page text keeps going where the administrator said');
  assert.match(result.rejected.join(' '), /detectEndpoint/);

  const same = stub([() => reply(200, { detectEndpoint: 'https://detect.internal.example/v2/detect' })]);
  const moved = await client({ store: memStore(), fetchImpl: same.impl }).refresh();
  assert.equal(moved.policy?.detectEndpoint, 'https://detect.internal.example/v2/detect', 'a new path is fine');
});

test('a backend outage serves the last good copy, and only until it expires', async () => {
  let now = 1_000;
  const seed: CachedPolicy = {
    policy: { native: ['crm.internal.example'] },
    fetchedAt: now,
    expiresAt: now + 60_000,
  };
  const store = memStore(seed);
  const { impl } = stub([() => reply(500)]);

  const during = await client({ store, fetchImpl: impl, now: () => now }).refresh();
  assert.equal(during.status, 'cached');
  assert.deepEqual(during.policy?.native, ['crm.internal.example'], 'an outage does not un-protect a known host');

  now += 120_000;
  const after = await client({ store, fetchImpl: impl, now: () => now }).refresh();
  assert.equal(after.status, 'expired');
  assert.equal(after.policy, null, 'stale lists stop being used, so hosts fall back to UNTRUSTED');
  assert.equal(store.value, null, 'and the copy is dropped rather than left to be found later');
});

test('304 renews the copy we hold instead of re-transferring it', async () => {
  let now = 5_000;
  const store = memStore({ policy: { native: ['a.example'] }, etag: '"abc"', fetchedAt: 0, expiresAt: 60_000 });
  const { impl, calls } = stub([() => reply(304, undefined, { 'cache-control': 'max-age=90' })]);

  const result = await client({ store, fetchImpl: impl, now: () => now }).refresh();
  assert.equal(calls[0]?.headers['if-none-match'], '"abc"');
  assert.equal(result.status, 'not-modified');
  assert.deepEqual(result.policy?.native, ['a.example'], 'kept without the server resending it');
  assert.equal(store.value?.expiresAt, now + 90_000, 'and the 304 may restate the life');
});

test('a bare 304 renews the previous life, it does not extend it to the default', async () => {
  const now = 100_000;
  // Was served with a 60s life; a 304 carrying no cache-control must not turn
  // that into a day.
  const store = memStore({ policy: {}, etag: '"abc"', fetchedAt: 0, expiresAt: 60_000 });
  const { impl } = stub([() => reply(304)]);
  await client({ store, fetchImpl: impl, now: () => now }).refresh();
  assert.equal(store.value?.expiresAt, now + 60_000);
});

test('the envelope is not mistaken for junk', async () => {
  const { impl } = stub([() => reply(200, { native: ['a.example'], maxAgeSeconds: 300 })]);
  const result = await client({ store: memStore(), fetchImpl: impl, now: () => 0 }).refresh();
  assert.deepEqual(result.rejected, [], 'maxAgeSeconds is protocol, not a stray key');
  assert.equal(result.expiresAt, 300_000, 'and the body may state the life when no header does');
});

test('a server that states no life gets the default, not an unbounded one', async () => {
  const store = memStore();
  const { impl } = stub([() => reply(200, { native: ['a.example'] })]);
  const result = await client({ store, fetchImpl: impl, now: () => 0 }).refresh();
  assert.equal(result.expiresAt, DEFAULT_TTL_MS);
});

test('max-age bounds how long a copy may be held', async () => {
  const store = memStore();
  const { impl } = stub([() => reply(200, { native: ['a.example'] }, { 'cache-control': 'max-age=60', etag: '"e"' })]);
  const result = await client({ store, fetchImpl: impl, now: () => 0 }).refresh();
  assert.equal(result.expiresAt, 60_000);
  assert.equal(store.value?.etag, '"e"');
});

test('a revoked credential does not retry, and does not discard a live copy', async () => {
  const store = memStore({ policy: { native: ['a.example'] }, fetchedAt: 0, expiresAt: 10_000 });
  const { impl, calls } = stub([() => reply(401)]);
  const result = await client({ store, fetchImpl: impl, now: () => 1, maxAttempts: 3 }).refresh();
  assert.equal(calls.length, 1, 'retrying a 401 only burns the backend');
  assert.equal(result.status, 'unauthorized');
  assert.deepEqual(result.policy?.native, ['a.example']);
});

test('no endpoint configured means no pull at all', async () => {
  const { impl, calls } = stub([() => reply(200, {})]);
  const result = await client({ endpoint: '', store: memStore(), fetchImpl: impl }).refresh();
  assert.equal(result.status, 'disabled');
  assert.equal(result.policy, null);
  assert.equal(calls.length, 0, 'a shipped build with no policy server never phones anywhere');
});

test('the credential rides in the header and nothing else is sent', async () => {
  const { impl, calls } = stub([() => reply(200, {})]);
  await client({ store: memStore(), fetchImpl: impl }).refresh();
  assert.equal(calls[0]?.headers.authorization, 'Bearer enrollment-token');
  assert.deepEqual(Object.keys(calls[0]?.headers ?? {}).sort(), ['accept', 'authorization']);
});
