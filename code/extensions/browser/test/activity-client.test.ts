import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityClient, type Beacon } from '../src/background/activity-client.ts';
import { DEFAULT_POLICY, sanitizeRemotePolicy, type Policy } from '../src/lib/policy.ts';

const REPORTING: Policy = {
  ...DEFAULT_POLICY,
  activityEndpoint: 'http://localhost:4000/pii/activity',
  activityToken: 'sk-engine',
};

const A_MINT: Beacon = {
  direction: 'encode',
  action: 'mint',
  host: 'crm.internal',
  trustClass: 'NATIVE',
  entityTypes: ['IBAN', 'IBAN', 'PERSON'],
  tokenCount: 3,
};

interface Sent {
  url: string;
  init: RequestInit;
}

function stubFetch(): { impl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ recorded: true }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, sent };
}

function onlyCall(sent: Sent[]): Sent {
  assert.equal(sent.length, 1, 'exactly one report was sent');
  const call = sent[0];
  assert.ok(call);
  return call;
}

const bodyOf = (sent: Sent[]) => JSON.parse(onlyCall(sent).init.body as string);

test('it ships off: with no endpoint configured nothing is sent anywhere', () => {
  const { impl, sent } = stubFetch();
  const client = new ActivityClient({ policy: DEFAULT_POLICY, fetchImpl: impl });
  client.report(A_MINT);
  assert.equal(client.enabled, false);
  assert.equal(sent.length, 0);
});

test('an endpoint without a credential stays off rather than reporting anonymously', () => {
  const { impl, sent } = stubFetch();
  const policy = { ...REPORTING, activityToken: '' };
  new ActivityClient({ policy, fetchImpl: impl }).report(A_MINT);
  assert.equal(sent.length, 0);
});

test('a configured beacon posts what was done, keyed to the engine credential', () => {
  const { impl, sent } = stubFetch();
  new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report(A_MINT);
  const call = onlyCall(sent);
  assert.equal(call.url, 'http://localhost:4000/pii/activity');
  assert.equal((call.init.headers as Record<string, string>)['authorization'], 'Bearer sk-engine');
  assert.equal(call.init.method, 'POST');
});

test('the report carries classes and counts, and the host it happened on', () => {
  const { impl, sent } = stubFetch();
  new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report(A_MINT);
  const body = bodyOf(sent);
  assert.deepEqual(body.entity_types, ['IBAN', 'IBAN', 'PERSON']);
  assert.equal(body.token_count, 3);
  assert.equal(body.host, 'crm.internal');
  assert.equal(body.trust_class, 'NATIVE');
  assert.equal(body.action, 'mint');
});

test('no field of the wire body can carry page text', () => {
  const { impl, sent } = stubFetch();
  new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report(A_MINT);
  const keys = Object.keys(bodyOf(sent)).sort();
  assert.deepEqual(keys, [
    'action',
    'direction',
    'entity_types',
    'host',
    'resolved_count',
    'token_count',
    'trust_class',
  ]);
});

test('a held request is reported as blocked, naming the class that held it', () => {
  const { impl, sent } = stubFetch();
  new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report({
    ...A_MINT,
    action: 'egress-block',
    blockedEntityType: 'IBAN',
  });
  assert.equal(bodyOf(sent).blocked_entity_type, 'IBAN');
});

test('a failed mint is reported as failed rather than silently omitted', () => {
  const { impl, sent } = stubFetch();
  new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report({
    ...A_MINT,
    tokenCount: 0,
    failedReason: 'no vault at http://localhost:8788/v1/tokens',
  });
  assert.match(bodyOf(sent).failed_reason, /no vault/);
});

test('a log outage never surfaces to the caller', () => {
  const impl = (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  assert.doesNotThrow(() => new ActivityClient({ policy: REPORTING, fetchImpl: impl }).report(A_MINT));
});

test('a pulled policy cannot point the beacon at an origin of its choosing', () => {
  const { policy, rejected } = sanitizeRemotePolicy(
    { activityEndpoint: 'https://attacker.example/collect', activityToken: 'stolen' },
    DEFAULT_POLICY.detectEndpoint,
  );
  assert.equal(policy.activityEndpoint, undefined);
  assert.equal(policy.activityToken, undefined);
  assert.equal(rejected.length, 2);
});
