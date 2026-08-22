import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { CHANNEL, digestOf, installEgressShim, type EgressConfig, type FromShim } from '../src/content/egress-main.ts';
import { normalizeValue } from '../src/lib/normalize.ts';

const IBAN = 'CH93 0076 2011 6238 5295 7';
const IBAN_TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';

/**
 * jsdom has no real network, so every transport is stubbed before the shim
 * wraps it — which is also what makes "did the original ever get called" the
 * assertion that matters here.
 */
function harness(config: Partial<EgressConfig> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://trusted.anonymice.test/',
  });
  const win = dom.window as unknown as Window & typeof globalThis;

  const sent: Array<{ transport: string; body: unknown }> = [];
  const reports: FromShim[] = [];

  // jsdom ships no `Response` constructor; nothing here reads the result.
  win.fetch = ((_input: unknown, init?: RequestInit) => {
    sent.push({ transport: 'fetch', body: init?.body });
    return Promise.resolve({ ok: true } as unknown as Response);
  }) as typeof win.fetch;

  class FakeWebSocket {
    url = 'wss://trusted.anonymice.test/collab';
    send(data: unknown): void {
      sent.push({ transport: 'websocket', body: data });
    }
  }
  (win as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

  (win.navigator as unknown as { sendBeacon: unknown }).sendBeacon = (_url: string, data: unknown) => {
    sent.push({ transport: 'beacon', body: data });
    return true;
  };

  win.addEventListener('message', (event) => {
    const data = event.data as FromShim | null;
    if (data?.channel === CHANNEL && data.kind !== undefined) reports.push(data);
  });

  const handle = installEgressShim(win);

  const full: EgressConfig = { mode: 'enforce', known: [], tokens: {}, ...config };
  // Applied directly rather than over postMessage, which jsdom delivers async.
  win.postMessage({ channel: CHANNEL, kind: 'config', config: full }, '*');

  return { dom, win, sent, reports, handle, apply: () => new Promise((r) => setTimeout(r, 0)) };
}

const vaultHas = (): Record<string, string> => ({
  [digestOf(normalizeValue('IBAN', IBAN), 'IBAN')]: IBAN_TOKEN,
});

test('the shim reports which transports it managed to patch', () => {
  const { handle } = harness();
  assert.deepEqual(handle.patched.sort(), ['beacon', 'fetch', 'form', 'websocket', 'xhr']);
});

test('a clean body is forwarded untouched', async () => {
  const h = harness();
  await h.apply();
  await h.win.fetch('/x', { method: 'POST', body: 'nothing to see' });
  assert.deepEqual(h.sent, [{ transport: 'fetch', body: 'nothing to see' }]);
});

test('fetch: a known value is substituted before it reaches the network', async () => {
  const h = harness({ tokens: vaultHas() });
  await h.apply();
  await h.win.fetch('/save', { method: 'POST', body: `{"iban":"${IBAN}"}` });

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.body, `{"iban":"${IBAN_TOKEN}"}`);
});

test('fetch: an untokenised value rejects rather than going out', async () => {
  const h = harness();
  await h.apply();
  await assert.rejects(
    () => h.win.fetch('/save', { method: 'POST', body: `{"iban":"${IBAN}"}` }),
    /Blocked by anonymice/,
  );
  assert.equal(h.sent.length, 0, 'the original fetch was never called');
});

test('websocket: the send is dropped, because send cannot await', async () => {
  const h = harness();
  await h.apply();
  const socket = new h.win.WebSocket('wss://trusted.anonymice.test/collab');
  socket.send(`{"op":"insert","text":"${IBAN}"}`);
  assert.equal(h.sent.length, 0, 'a frame carrying a value does not leave — SPEC §10.4');

  socket.send('{"op":"insert","text":"harmless"}');
  assert.equal(h.sent.length, 1, 'and the next frame is unaffected');
});

test('websocket: with a token in hand the frame goes out tokenised', async () => {
  const h = harness({ tokens: vaultHas() });
  await h.apply();
  new h.win.WebSocket('wss://x/').send(`{"op":"insert","text":"${IBAN}"}`);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.body, `{"op":"insert","text":"${IBAN_TOKEN}"}`);
});

test('sendBeacon returns false when it is held — pagehide has no retry', async () => {
  const h = harness();
  await h.apply();
  const ok = h.win.navigator.sendBeacon('/telemetry', `{"iban":"${IBAN}"}`);
  assert.equal(ok, false);
  assert.equal(h.sent.length, 0);
});

test('report mode forwards the original and still says so', async () => {
  const h = harness({ mode: 'report' });
  await h.apply();
  await h.win.fetch('/save', { method: 'POST', body: `{"iban":"${IBAN}"}` });

  assert.equal(h.sent.length, 1, 'report mode does not block');
  assert.equal(h.sent[0]!.body, `{"iban":"${IBAN}"}`);
  await h.apply();
  const blocked = h.reports.filter((r) => r.kind === 'blocked');
  assert.equal(blocked.length, 1, 'but it is still reported');
});

test('a blocked body reports exactly what the vault owes', async () => {
  const h = harness();
  await h.apply();
  await h.win.fetch('/save', { method: 'POST', body: `{"iban":"${IBAN}"}` }).catch(() => {});
  await h.apply();

  const blocked = h.reports.find((r) => r.kind === 'blocked');
  assert.ok(blocked && blocked.kind === 'blocked');
  assert.equal(blocked.missing.length, 1);
  assert.equal(blocked.missing[0]!.cls, 'IBAN');
  assert.equal(blocked.missing[0]!.normalized, normalizeValue('IBAN', IBAN));
});

test('a body we cannot read as text is passed through, and §10.7 says so', async () => {
  const h = harness();
  await h.apply();
  const blob = new h.win.Blob([`{"iban":"${IBAN}"}`]);
  await h.win.fetch('/save', { method: 'POST', body: blob });
  assert.equal(h.sent.length, 1, 'a Blob body is a known gap, not a silent block');
});

test('restore puts every original back', async () => {
  const h = harness();
  await h.apply();
  h.handle.restore();
  await h.win.fetch('/save', { method: 'POST', body: `{"iban":"${IBAN}"}` });
  assert.equal(h.sent.length, 1, 'unpatched again');
  assert.equal(h.sent[0]!.body, `{"iban":"${IBAN}"}`);
});
