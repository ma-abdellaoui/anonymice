import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { sanitizeServedPolicy } from '../src/policy/sanitize.ts';
import { auth, logged, startRig } from './helpers.ts';

test('the sanitiser drops what the client would refuse, and says why', () => {
  const { policy, rejected } = sanitizeServedPolicy({
    policyVersion: '2026-08-22',
    native: ['crm.internal.example', '*.clinic.internal.example', '*', 'http://x.example', 'x.example:8080', 'a b'],
    trusted: 'not-an-array',
    scanTrusted: 'sometimes',
    policyEndpoint: 'https://elsewhere.example/v1/policy',
    activated: ['untrusted.example'],
    surprise: true,
  });

  assert.deepEqual(policy.native, ['crm.internal.example', '*.clinic.internal.example']);
  assert.equal(policy.trusted, undefined);
  assert.equal(policy.scanTrusted, undefined);
  assert.equal(policy.policyVersion, '2026-08-22');
  assert.ok(!('policyEndpoint' in policy), 'a response may not redirect the next pull');
  assert.ok(!('activated' in policy), 'activation is the user consent, not the server to grant');
  assert.equal(rejected.length, 9, rejected.join('\n'));
});

test('an omitted list is "no opinion"; an empty one empties it', () => {
  assert.equal(sanitizeServedPolicy({ policyVersion: 'v' }).policy.native, undefined);
  assert.deepEqual(sanitizeServedPolicy({ native: [] }).policy.native, []);
});

test('200 then 304, and a live edit invalidates the ETag', async () => {
  const rig = await startRig();
  try {
    const first = await fetch(`${rig.base}/v1/policy`, { headers: auth() });
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag && etag.startsWith('"'), 'a strong ETag');
    assert.equal(first.headers.get('cache-control'), 'max-age=300');
    const body = (await first.json()) as { native: string[]; policyVersion: string };
    assert.deepEqual(body.native, ['native.anonymice.test']);

    const second = await fetch(`${rig.base}/v1/policy`, { headers: auth({ 'if-none-match': etag }) });
    assert.equal(second.status, 304);

    rig.writePolicy({ policyVersion: '2026-08-23', locale: 'de-CH', native: ['other.anonymice.test'] });
    const third = await fetch(`${rig.base}/v1/policy`, { headers: auth({ 'if-none-match': etag }) });
    assert.equal(third.status, 200, 'an edited file must stop 304-ing');
    assert.notEqual(third.headers.get('etag'), etag);
    assert.deepEqual(((await third.json()) as { native: string[] }).native, ['other.anonymice.test']);
  } finally {
    await rig.close();
  }
});

test('a file that breaks while running keeps serving the last good copy, loudly', async () => {
  const rig = await startRig();
  try {
    const first = await fetch(`${rig.base}/v1/policy`, { headers: auth() });
    const etag = first.headers.get('etag');

    writeFileSync(rig.policyFile, '{ not json');
    const second = await fetch(`${rig.base}/v1/policy`, { headers: auth() });
    assert.equal(second.status, 200, 'un-listing a host silently is the outcome to avoid');
    assert.equal(second.headers.get('etag'), etag);
    assert.equal(logged(rig.lines, 'policy.read_failed').length, 1);
  } finally {
    await rig.close();
  }
});

test('a rejected list entry is reported, never silently shortened', async () => {
  const rig = await startRig({ policy: { policyVersion: 'v1', native: ['ok.example', '*'] } });
  try {
    const rejected = logged(rig.lines, 'policy.rejected');
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]?.reason), /is not a host pattern/);
    const metrics = (await (await fetch(`${rig.base}/v1/metrics`, { headers: auth() })).json()) as {
      policy: { rejected: string[] };
    };
    assert.equal(metrics.policy.rejected.length, 1);
  } finally {
    await rig.close();
  }
});
