/**
 * Ingress resolution and its two failure arms — SPEC §10.9.3.
 *
 * `asked` exists to stop a request storm against a token the vault has already
 * refused (§6.7). The bug these tests pin is what happens when the vault never
 * answered at all: that is not a refusal, and remembering it as one leaves the
 * token showing until the page is reloaded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { attachEgressBridge, type ResolveOutcome } from '../src/content/egress-bridge.ts';
import { SpanRegistry } from '../src/lib/registry.ts';
import type { Minter } from '../src/content/clipboard.ts';

const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';
const VALUE = 'CH93 0076 2011 6238 5295 7';

/** The bridge only mints on a blocked request; nothing here blocks one. */
const minter: Minter = {
  scopeId: 'source:https://trusted.anonymice.test',
  get: () => null,
  ensure: async () => ({ ok: true as const, tokens: [] }),
};

function harness(resolve: (tokens: string[]) => Promise<ResolveOutcome>, retryMs = 60_000) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://trusted.anonymice.test/',
  });
  const win = dom.window as unknown as Window;
  const landed: Array<Record<string, string>> = [];
  const bridge = attachEgressBridge(win, {
    registry: new SpanRegistry(),
    minter,
    mode: 'enforce',
    reveal: 'dom',
    resolve,
    retryMs,
    onValues: (values) => landed.push(values),
  });
  return { bridge, landed };
}

const answered = (values: Record<string, string>): ResolveOutcome => ({ values, unreachable: [] });
const nobodyAnswered = (tokens: string[]): ResolveOutcome => ({ values: {}, unreachable: tokens });

/** Long enough for the deferred retry at `retryMs: 0` to have run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a token nobody answered for is asked again', async () => {
  const calls: string[][] = [];
  let up = false;
  const { bridge, landed } = harness(async (tokens) => {
    calls.push(tokens);
    // The worker is not up for the first round — the cold-load case.
    return up ? answered({ [TOKEN]: VALUE }) : nobodyAnswered(tokens);
  });

  await bridge.warm([TOKEN]);
  assert.deepEqual(calls, [[TOKEN]], 'asked once');
  assert.deepEqual(landed, [], 'and nothing landed');

  up = true;
  await bridge.warm([TOKEN]);
  assert.equal(calls.length, 2, 'the second ask is not suppressed by `asked`');
  assert.deepEqual(landed.at(-1), { [TOKEN]: VALUE });
});

test('a vault that refused is asked exactly once', async () => {
  const calls: string[][] = [];
  const { bridge, landed } = harness(async (tokens) => {
    calls.push(tokens);
    // Answered, but not with a value: a tombstone, a foreign vault, damage.
    // Every one of those is final, and re-asking is the storm `asked` prevents.
    return answered({});
  });

  await bridge.warm([TOKEN]);
  await bridge.warm([TOKEN]);
  await settle();
  assert.deepEqual(calls, [[TOKEN]], 'a final answer is remembered');
  assert.deepEqual(landed, []);
});

test('a resolve that throws does not burn the token either', async () => {
  const calls: string[][] = [];
  let up = false;
  const { bridge, landed } = harness(async (tokens) => {
    calls.push(tokens);
    if (!up) throw new Error('Could not establish connection');
    return answered({ [TOKEN]: VALUE });
  });

  await bridge.warm([TOKEN]);
  assert.deepEqual(landed, [], 'nothing landed, and no rejection escaped');

  up = true;
  await bridge.warm([TOKEN]);
  assert.deepEqual(landed.at(-1), { [TOKEN]: VALUE });
  assert.equal(calls.length, 2);
});

test('the deferred retry needs no second trigger', async () => {
  const calls: string[][] = [];
  let up = false;
  const { landed } = (() => {
    const h = harness(async (tokens) => {
      calls.push(tokens);
      if (up) return answered({ [TOKEN]: VALUE });
      up = true; // up by the time the retry fires
      return nobodyAnswered(tokens);
    }, 0);
    void h.bridge.warm([TOKEN]);
    return h;
  })();

  await settle();
  assert.equal(calls.length, 2, 'the retry fired on its own — a quiet page has no mutations');
  assert.deepEqual(landed.at(-1), { [TOKEN]: VALUE });
});

test('the retry stops at one — an outage is not fixed by hammering it', async () => {
  const calls: string[][] = [];
  const { bridge } = harness(async (tokens) => {
    calls.push(tokens);
    return nobodyAnswered(tokens);
  }, 0);

  await bridge.warm([TOKEN]);
  await settle();
  await settle();
  assert.equal(calls.length, 2, 'the first ask and one deferred retry, and no more');
});
