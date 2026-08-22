import assert from 'node:assert/strict';
import test from 'node:test';
import { bearerFrom, isAuthorized } from '../src/auth.ts';
import { auth, startRig, TOKEN } from './helpers.ts';

test('bearer parsing accepts the header the client actually sends', () => {
  assert.equal(bearerFrom('Bearer abc'), 'abc');
  assert.equal(bearerFrom('bearer  abc '), 'abc');
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom(undefined), null);
});

test('a rotation keeps both credentials live', () => {
  const tokens = ['new-credential-value', 'old-credential-value'];
  assert.ok(isAuthorized('Bearer new-credential-value', tokens));
  assert.ok(isAuthorized('Bearer old-credential-value', tokens));
  assert.ok(!isAuthorized('Bearer other-credential', tokens));
  assert.ok(!isAuthorized('Bearer ', tokens));
});

test('health is unauthenticated, policy and detect are not', async () => {
  const rig = await startRig();
  try {
    const health = await fetch(`${rig.base}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, 'ok');

    const policy = await fetch(`${rig.base}/v1/policy`);
    assert.equal(policy.status, 401);
    assert.equal(policy.headers.get('www-authenticate'), 'Bearer');

    const detect = await fetch(`${rig.base}/v1/detect`, { method: 'POST', body: '{}' });
    assert.equal(detect.status, 401);

    const metrics = await fetch(`${rig.base}/v1/metrics`, { headers: auth() });
    assert.equal(metrics.status, 200);
  } finally {
    await rig.close();
  }
});

test('unknown routes 404 and wrong methods 405', async () => {
  const rig = await startRig();
  try {
    assert.equal((await fetch(`${rig.base}/v1/nope`)).status, 404);
    const wrong = await fetch(`${rig.base}/v1/policy`, { method: 'POST', headers: auth() });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
  } finally {
    await rig.close();
  }
});

test('the credential never reaches a log line', async () => {
  const rig = await startRig();
  try {
    await fetch(`${rig.base}/v1/policy`, { headers: auth() });
    await fetch(`${rig.base}/v1/policy`, { headers: { authorization: 'Bearer wrong' } });
    assert.ok(!rig.lines.some((line) => line.includes(TOKEN) || line.includes('wrong')));
  } finally {
    await rig.close();
  }
});
