/**
 * Headless proof of the SPEC §10.9 round trip — no browser involved.
 *
 * Drives the *real* shim against the *real* fixture server, so it checks the one
 * claim the whole `reveal: dom` mode rests on: the destination stores a token,
 * the application reads a value.
 *
 * Not a substitute for QA §15 — jsdom has no page realm, so this cannot tell you
 * whether the shim wins the race for the originals at `document_start`. It tells
 * you the substitution logic is wired correctly before you go near Chrome.
 *
 *   npm run fixtures        # in another terminal
 *   npm run roundtrip
 */
import { JSDOM } from 'jsdom';
import { CHANNEL, digestOf, installEgressShim } from '../src/content/egress-main.ts';
import { normalizeValue } from '../src/lib/normalize.ts';

const IBAN = 'CH93 0076 2011 6238 5295 7';
const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';
const BASE = process.env.FIXTURES ?? 'http://localhost:8787';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://trusted.anonymice.test/' });
const win = dom.window as unknown as Window & typeof globalThis;
win.fetch = globalThis.fetch.bind(globalThis) as typeof win.fetch;

installEgressShim(win);
win.postMessage({
  channel: CHANNEL,
  kind: 'config',
  config: {
    mode: 'enforce',
    known: [],
    tokens: { [digestOf(normalizeValue('IBAN', IBAN), 'IBAN')]: TOKEN },
    reveal: 'dom',
    values: { [TOKEN]: IBAN },
  },
}, '*');
await new Promise((r) => setTimeout(r, 10));

await win.fetch(`${BASE}/collected`, { method: 'DELETE' });

const doc = `{"title":"Zahlungsauftrag","body":"IBAN: ${IBAN}"}`;
console.log('1. app saves  :', doc);
await win.fetch(`${BASE}/doc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: doc });

const raw = await (await globalThis.fetch(`${BASE}/doc`)).text();
console.log('2. store holds:', raw);

const seen = await (await win.fetch(`${BASE}/doc`)).text();
console.log('3. app reads  :', seen);

console.log('');
console.log('store has plaintext? ', raw.includes(IBAN), '  <- must be false');
console.log('store has token?     ', raw.includes(TOKEN), '  <- must be true');
console.log('app sees plaintext?  ', seen.includes(IBAN), '  <- must be true');
console.log('app sees token?      ', seen.includes(TOKEN), '  <- must be false');

const ok =
  !raw.includes(IBAN) && raw.includes(TOKEN) && seen.includes(IBAN) && !seen.includes(TOKEN);
console.log(ok ? '\n' + 'ROUND TRIP OK' : '\n' + 'ROUND TRIP FAILED');
process.exit(ok ? 0 : 1);
