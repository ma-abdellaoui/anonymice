import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkHash } from '../src/lib/hash.ts';
import { LIMITS } from '../src/lib/protocol.ts';
import { UnavailableModelPass } from '../src/detect/model.ts';
import { parseDetectRequest } from '../src/routes/detect.ts';
import { auth, detectBody, logged, startRig } from './helpers.ts';

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/detect`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('a well-formed request comes back bound to its chunks', async () => {
  const rig = await startRig();
  try {
    const text = 'Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7';
    const res = await post(rig.base, detectBody(text, { chunks: [{ id: 'c1', hash: chunkHash(text), text }] }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const body = (await res.json()) as {
      modelVersion: string;
      policyVersion: string;
      chunks: Array<{ id: string; hash: string; spans: Array<{ start: number; end: number; cls: string; normalized: string; origin: string }> }>;
    };
    assert.equal(body.policyVersion, '2026-08-22');
    assert.match(body.modelVersion, /^rules-1\+gazetteer-1$/);
    const chunk = body.chunks[0];
    assert.equal(chunk?.id, 'c1');
    assert.equal(chunk?.hash, chunkHash(text));

    const iban = chunk?.spans.find((s) => s.cls === 'IBAN');
    assert.ok(iban, 'the rule pass must find a valid IBAN');
    assert.equal(text.slice(iban.start, iban.end), 'CH93 0076 2011 6238 5295 7');
    assert.equal(iban.normalized, 'CH9300762011623852957');
    assert.equal(iban.origin, 'rule');
    assert.ok(chunk?.spans.some((s) => s.cls === 'PERSON' && s.origin === 'model'));
  } finally {
    await rig.close();
  }
});

test('offsets are UTF-16 code units, so astral characters do not desynchronise', async () => {
  const rig = await startRig();
  try {
    // Each 👨‍👩‍👧 is several UTF-16 code units and one "character" to a naive backend.
    const text = '👨‍👩‍👧 Rechnung 👍 an anna.meier@example.org 🧾 senden';
    const res = await post(rig.base, detectBody(text, { chunks: [{ id: 'c1', hash: chunkHash(text), text }] }));
    const body = (await res.json()) as { chunks: Array<{ spans: Array<{ start: number; end: number; cls: string }> }> };
    const email = body.chunks[0]?.spans.find((s) => s.cls === 'EMAIL');
    assert.ok(email);
    assert.equal(text.slice(email.start, email.end), 'anna.meier@example.org');
    assert.equal(email.start, text.indexOf('anna.meier@example.org'));
  } finally {
    await rig.close();
  }
});

test('the same request twice is the same bytes twice', async () => {
  const rig = await startRig();
  try {
    const text = 'Anna Meier, AHV 756.1234.5678.97, Muster AG, 044 668 18 00';
    const body = detectBody(text, { chunks: [{ id: 'c1', hash: chunkHash(text), text }] });
    const first = await (await post(rig.base, body)).text();
    const second = await (await post(rig.base, body)).text();
    assert.equal(first, second, 'determinism is part of the contract (SPEC §3.2)');
  } finally {
    await rig.close();
  }
});

test('every protocol cap answers 413 — the re-split signal, not an error', async () => {
  const rig = await startRig();
  try {
    const long = 'a'.repeat(LIMITS.maxChunkChars + 1);
    const overChunk = await post(rig.base, detectBody('x', { chunks: [{ id: 'c1', hash: 'sha256:x', text: long }] }));
    assert.equal(overChunk.status, 413);
    assert.equal(((await overChunk.json()) as { error: string }).error, 're_split');

    const many = Array.from({ length: LIMITS.maxChunks + 1 }, (_, i) => ({ id: `c${i}`, hash: 'sha256:x', text: 'x' }));
    assert.equal((await post(rig.base, detectBody('x', { chunks: many }))).status, 413);
  } finally {
    await rig.close();
  }
});

test('a body over the byte ceiling gets the same 413, and gets it delivered', async () => {
  // Over the ceiling the upload is discarded — but the answer must still arrive,
  // or the client sees a reset and retries the whole batch instead of halving it.
  const rig = await startRig({ env: { MAX_BODY_BYTES: '2048' } });
  try {
    const huge = { ...detectBody('x'), padding: 'p'.repeat(64_000) };
    const res = await post(rig.base, huge);
    assert.equal(res.status, 413);
    assert.equal(await res.text(), 're-split');
    assert.equal(logged(rig.lines, 'detect.body_too_large').length, 1);
  } finally {
    await rig.close();
  }
});

test('total-character cap answers 413 too', () => {
  const chunks = Array.from({ length: 32 }, (_, i) => ({ id: `c${i}`, hash: 'sha256:x', text: 'x'.repeat(3000) }));
  const result = parseDetectRequest({ policyVersion: 'v', locale: 'de-CH', hostClass: 'native', chunks }, 'de-CH');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 413);
});

test('a malformed request is a 400 that names the field', async () => {
  const rig = await startRig();
  try {
    assert.equal((await post(rig.base, 'not json')).status, 400);
    assert.equal((await post(rig.base, detectBody('x', { hostClass: 'NATIVE' }))).status, 400);
    assert.equal((await post(rig.base, detectBody('x', { policyVersion: '' }))).status, 400);
    assert.equal((await post(rig.base, detectBody('x', { chunks: [{ id: 'c1', text: 'x' }] }))).status, 400);

    const bad = await post(rig.base, detectBody('x', { chunks: 'nope' }));
    assert.equal(((await bad.json()) as { message: string }).message, 'chunks must be an array');
  } finally {
    await rig.close();
  }
});

test('hints are advisory: malformed ones are dropped and counted, not fatal', () => {
  const result = parseDetectRequest(
    {
      policyVersion: 'v',
      locale: 'de-CH',
      hostClass: 'native',
      chunks: [
        {
          id: 'c1',
          hash: 'sha256:x',
          text: 'Anna Meier',
          hints: [
            { start: 0, end: 10, cls: 'PERSON', origin: 'annotation' },
            { start: 5, end: 2, cls: 'PERSON' },
            { start: 0, end: 99, cls: 'PERSON' },
            { start: 0, end: 4, cls: 'NOT_A_CLASS' },
          ],
        },
      ],
    },
    'de-CH',
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.droppedHints, 3);
  assert.equal(result.ok && result.request.chunks[0]?.hints?.length, 1);
});

test('a failed pass is a 502, never a 200 with no spans', async () => {
  const rig = await startRig({ model: new UnavailableModelPass() });
  try {
    const res = await post(rig.base, detectBody('Anna Meier'));
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, 'detector_unavailable');
    assert.equal(logged(rig.lines, 'detect.unavailable').length, 1);
  } finally {
    await rig.close();
  }
});

test('an untrusted host class is answered but never passes unremarked', async () => {
  const rig = await startRig();
  try {
    assert.equal((await post(rig.base, detectBody('Anna Meier', { hostClass: 'untrusted' }))).status, 200);
    assert.equal(logged(rig.lines, 'detect.untrusted_host_class').length, 1);
  } finally {
    await rig.close();
  }
});

test('no page text reaches the logs', async () => {
  const rig = await startRig();
  try {
    const text = 'Anna Meier lives at anna.meier@example.org with IBAN CH93 0076 2011 6238 5295 7';
    await post(rig.base, detectBody(text, { chunks: [{ id: 'c1', hash: chunkHash(text), text }] }));
    const joined = rig.lines.join('\n');
    for (const secretish of ['Anna Meier', 'anna.meier@example.org', 'CH93', 'CH9300762011623852957']) {
      assert.ok(!joined.includes(secretish), `log leaked ${secretish}`);
    }
    assert.equal(logged(rig.lines, 'detect.ok').length, 1);
  } finally {
    await rig.close();
  }
});
