/**
 * `reveal: 'dom'` — SPEC §10.9, §10.10.
 *
 * The mode the whole thing is for: the page renders real values, the wire
 * carries tokens. These tests hold both halves at once, because either alone is
 * a different (and useless) feature.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { CHANNEL, digestOf, installEgressShim, type EgressConfig, type FromShim } from '../src/content/egress-main.ts';
import { detokenize, safeToSubstitute } from '../src/lib/detokenize.ts';
import { normalizeValue } from '../src/lib/normalize.ts';

const IBAN = 'CH93 0076 2011 6238 5295 7';
const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';

const tokensMap = () => ({ [digestOf(normalizeValue('IBAN', IBAN), 'IBAN')]: TOKEN });
const valuesMap = (): Record<string, string> => ({ [TOKEN]: IBAN });

function harness(config: Partial<EgressConfig> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://trusted.anonymice.test/',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const sent: Array<{ transport: string; body: unknown }> = [];
  const reports: FromShim[] = [];

  let respondWith = '{}';
  win.fetch = ((_i: unknown, init?: RequestInit) => {
    sent.push({ transport: 'fetch', body: init?.body });
    // jsdom has no `Response`; Node's global is the same shape the shim uses.
    return Promise.resolve(
      new Response(respondWith, { headers: { 'content-type': 'application/json' } }),
    );
  }) as typeof win.fetch;

  win.addEventListener('message', (e) => {
    const d = e.data as FromShim | null;
    if (d?.channel === CHANNEL) reports.push(d);
  });

  const handle = installEgressShim(win);
  win.postMessage(
    {
      channel: CHANNEL,
      kind: 'config',
      config: { mode: 'enforce', known: [], tokens: {}, ...config } as EgressConfig,
    },
    '*',
  );
  return {
    win,
    sent,
    reports,
    handle,
    setResponse: (t: string) => (respondWith = t),
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

test('ingress: a token in a response is a value by the time the app sees it', async () => {
  const h = harness({ reveal: 'dom', values: valuesMap() });
  await h.tick();
  h.setResponse(`{"field":"${TOKEN}"}`);

  const body = await (await h.win.fetch('/page')).text();
  assert.ok(body.includes(IBAN), 'the application reads the real value');
  assert.ok(!body.includes(TOKEN), 'and never sees the token');
});

test('round trip: what the app reads is a value, what the network gets is a token', async () => {
  const h = harness({ reveal: 'dom', values: valuesMap(), tokens: tokensMap() });
  await h.tick();
  h.setResponse(`{"field":"${TOKEN}"}`);

  const shown = await (await h.win.fetch('/load')).text();
  assert.ok(shown.includes(IBAN), 'in: value');

  // The app edits and saves what it was shown.
  await h.win.fetch('/save', { method: 'POST', body: shown });
  const saved = h.sent.at(-1)!.body as string;
  assert.ok(saved.includes(TOKEN), 'out: token');
  assert.ok(!saved.includes(IBAN), 'and no plaintext on the wire');
});

test('an unresolvable token is left showing, and reported so it can be warmed', async () => {
  const h = harness({ reveal: 'dom', values: {} });
  await h.tick();
  h.setResponse(`{"field":"${TOKEN}"}`);

  const body = await (await h.win.fetch('/page')).text();
  assert.ok(body.includes(TOKEN), 'a token we cannot resolve is still the right thing to show');
  await h.tick();
  const asked = h.reports.filter((r) => r.kind === 'unresolved');
  assert.ok(asked.length > 0, 'and the bridge is told to go and resolve it');
});

test('ingress is off unless the mode asks for it', async () => {
  const h = harness({ values: valuesMap() });
  await h.tick();
  h.setResponse(`{"field":"${TOKEN}"}`);
  const body = await (await h.win.fetch('/page')).text();
  assert.ok(body.includes(TOKEN), 'default mode leaves responses alone');
});

test('a positional payload is never rewritten in either direction', async () => {
  const steps = `{"clientID":42,"steps":[{"stepType":"replace","from":11,"to":11,"slice":{"content":[{"type":"text","text":"${IBAN}"}]}}]}`;
  assert.equal(safeToSubstitute(steps), false, 'recognised as offset-addressed');

  // Ingress leaves it alone even when every token is resolvable.
  const withToken = steps.replace(IBAN, TOKEN);
  const revealed = detokenize(withToken, (t) => valuesMap()[t]);
  assert.ok(safeToSubstitute(withToken) === false);
  assert.ok(revealed.text.includes(IBAN), 'detokenize itself is willing…');

  // …but the shim refuses, and holds the send rather than corrupting the doc.
  const h = harness({ reveal: 'dom', values: valuesMap(), tokens: tokensMap() });
  await h.tick();
  const ws = { url: 'wss://x/', send: () => {} };
  void ws;
  await assert.rejects(() => h.win.fetch('/collab', { method: 'POST', body: steps }));
  assert.equal(h.sent.length, 0, 'held — substituting would shift every offset after it');

  await h.tick();
  const blocked = h.reports.find((r) => r.kind === 'blocked');
  assert.ok(blocked && blocked.kind === 'blocked');
});

test('a flat REST payload is still rewritten — the guard is not a blanket refusal', () => {
  assert.equal(safeToSubstitute(`{"iban":"${IBAN}","who":"Anna"}`), true);
});

test('form submit: fields are tokenised in place before the browser serialises', async () => {
  const h = harness({ tokens: tokensMap() });
  await h.tick();
  h.win.document.body.innerHTML =
    '<form id="f" method="post" action="/pay"><input name="iban"><input name="memo"></form>';
  const form = h.win.document.getElementById('f') as HTMLFormElement;
  const iban = form.elements.namedItem('iban') as HTMLInputElement;
  const memo = form.elements.namedItem('memo') as HTMLInputElement;
  iban.value = IBAN;
  memo.value = 'invoice 12';

  form.dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true }));

  assert.equal(iban.value, TOKEN, 'the field the browser will serialise holds a token');
  assert.equal(memo.value, 'invoice 12', 'and an ordinary field is untouched');
});

test('form submit: an untokenised value cancels the navigation', async () => {
  const h = harness();
  await h.tick();
  h.win.document.body.innerHTML = '<form id="f" method="post"><input name="iban"></form>';
  const form = h.win.document.getElementById('f') as HTMLFormElement;
  (form.elements.namedItem('iban') as HTMLInputElement).value = IBAN;

  const event = new h.win.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'the submit does not proceed — SPEC §10.10');

  await h.tick();
  const blocked = h.reports.find((r) => r.kind === 'blocked');
  assert.ok(blocked && blocked.kind === 'blocked' && blocked.transport === 'form');
});

test('gzip magic bytes are not mistaken for text', async () => {
  const h = harness();
  await h.tick();
  const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
  await h.win.fetch('/upload', { method: 'POST', body: gzip });
  assert.equal(h.sent.length, 1, 'opaque bytes pass — a documented gap, not a silent block');
});

test('a UTF-8 byte body IS read, so a typed value in it is caught', async () => {
  const h = harness();
  await h.tick();
  const bytes = new TextEncoder().encode(`{"iban":"${IBAN}"}`);
  await assert.rejects(() => h.win.fetch('/upload', { method: 'POST', body: bytes }));
  assert.equal(h.sent.length, 0, 'bytes that decode as text are gated like text');
});
