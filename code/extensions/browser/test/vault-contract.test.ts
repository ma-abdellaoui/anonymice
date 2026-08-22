/**
 * The browser's contract with the vault — SPEC §5.2, §6.3, ENDPOINTS.md §6.
 *
 * This was a cross-extension test: the browser minted and the VS Code
 * extension's `RemoteVault` read back, proving both spoke to one vault. That
 * extension has been removed, so the editor half is gone — but the properties it
 * was proving are the *vault's*, not that client's, and they still hold. They
 * are asserted here against the token API directly, over a fetch faked at the
 * socket and real everywhere above it.
 *
 * What is deliberately not replaced is any test that only exercised
 * `RemoteVault`'s own caching and error handling. There is no such object now,
 * and a stub written to satisfy the test would assert nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenApi, openMockVault, type TokenApi } from '../mock/tokens-api.ts';
import { DEFAULT_POLICY as VAULT_POLICY, Vault } from '../mock/vault.ts';
import { VaultClient, type Resolution } from '../src/background/vault-client.ts';
import { collectHits, createRemoteMinter, planCopy } from '../src/content/clipboard.ts';
import { createRevealer, type Box, type Surface } from '../src/content/reveal.ts';
import { runPipeline, type Detector } from '../src/lib/pipeline.ts';
import { DEFAULT_POLICY, type Policy } from '../src/lib/policy.ts';
import { scanTokens } from '../src/lib/tokens.ts';
import { revealSegments } from '../src/ui/reveal.ts';
import type { Command, MountCommand, Outbound } from '../src/ui/reveal.ts';
import { detectChunk, MODEL_VERSION } from '../mock/rules.ts';
import { domFrom } from './helpers.ts';

/** The backend, in process — the same rule and gazetteer passes the mock serves. */
const detector: Detector = {
  async detect(chunks) {
    return {
      modelVersion: MODEL_VERSION,
      policyVersion: 'test',
      chunks: chunks.map((c) => ({ id: c.id, hash: c.hash, spans: detectChunk(c.text, 'de-CH') })),
    };
  },
};

interface FakeSurface extends Surface {
  readonly sent: Command[];
  readonly lastMount: MountCommand | undefined;
}

function fakeSurface(): FakeSurface {
  const sent: Command[] = [];
  return {
    sent,
    send: (c) => void sent.push(c),
    onMessage: () => {},
    place: (_b: Box | null) => {},
    dispose: () => {},
    get lastMount() {
      return [...sent].reverse().find((c): c is MountCommand => c.type === 'mount');
    },
  };
}

/** jsdom has no ClipboardEvent, so the event carries what the handler reads. */
function firePaste(doc: Document, field: HTMLInputElement, text: string): void {
  const view = doc.defaultView!;
  const event = new view.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  Object.defineProperty(event, 'target', { value: field });
  Object.defineProperty(event, 'stopImmediatePropagation', { value: () => {} });
  doc.dispatchEvent(event);
}

const ORIGIN = 'http://vault.test';
const BROWSER_SCOPE = 'source:http://native.anonymice.test:8787';
const EDITOR_SCOPE = 'file:///home/demian/notes';

interface Wired {
  api: TokenApi;
  browser: VaultClient;
  /** Resolves seen, so "a resolve is a write" (§6.7) stays observable. */
  resolves: number;
}

async function wire(vault?: Vault): Promise<Wired> {
  const api = createTokenApi(vault ?? (await openMockVault()));
  const state = { resolves: 0 };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    if (init?.headers && !('authorization' in (init.headers as Record<string, string>))) {
      return { ok: false, status: 401, json: async () => ({}) } as Response;
    }
    // The same routing detect-server.ts does, so the client is exercised against
    // the real path shapes rather than a convenient stand-in.
    const rest = url.pathname.slice('/v1/tokens'.length);
    const method = init?.method ?? 'GET';
    const commit = /^\/(.+)\/commit$/.exec(rest);
    let reply;
    if (method === 'POST' && rest === '') reply = await api.mint(body);
    else if (method === 'POST' && rest === '/resolve') {
      state.resolves++;
      reply = await api.resolve(body);
    } else if (method === 'POST' && rest === '/child') reply = api.child(body);
    else if (method === 'POST' && commit) reply = await api.commit(decodeURIComponent(commit[1]!));
    else if (method === 'PATCH' && rest.startsWith('/')) {
      reply = api.update(decodeURIComponent(rest.slice(1)), body);
    } else return { ok: false, status: 404, json: async () => ({}) } as Response;
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  }) as typeof fetch;

  const policy: Policy = { ...DEFAULT_POLICY, detectEndpoint: `${ORIGIN}/v1/detect`, detectToken: 'dev' };
  return {
    api,
    browser: new VaultClient({ policy, fetchImpl }),
    get resolves() {
      return state.resolves;
    },
  } as Wired;
}

/** What a destination sees when it asks the vault about a token it was handed. */
async function readBack(
  api: TokenApi,
  token: string,
  scopeId?: string,
): Promise<Resolution & { alias?: string }> {
  const body = scopeId ? { token, scopeId } : { token };
  return (await api.resolve(body)).body as Resolution & { alias?: string };
}

const IBAN = 'CH93 0076 2011 6238 5295 7';
const mintIban = { cls: 'IBAN', value: IBAN, normalized: 'CH9300762011623852957', scopeId: BROWSER_SCOPE };

test('a token minted in the browser resolves to its value at a destination', async () => {
  const { browser, api } = await wire();

  const [token] = (await browser.mint([mintIban])).tokens!;
  assert.match(token!, /^ANM1-IBAN-/);

  const resolution = await readBack(api, token!);
  assert.equal(resolution.kind, 'value');
  assert.equal(resolution.kind === 'value' && resolution.value, IBAN);
  assert.equal(resolution.kind === 'value' && resolution.cls, 'IBAN');
});

test('a token this vault has never issued reads as foreign, not as a value', async () => {
  const { api } = await wire();
  // Well-formed, correct check character, minted nowhere.
  const { mintToken } = await import('../src/lib/tokens.ts');
  const stranger = mintToken('PERSON');

  assert.deepEqual(await readBack(api, stranger), { kind: 'foreign', cls: 'PERSON' });
});

test('pasting re-scopes: the destination gets its own alias, not the clipboard token', async () => {
  const { browser, api } = await wire();
  const [clipboard] = (await browser.mint([mintIban])).tokens!;

  const reply = await readBack(api, clipboard!, EDITOR_SCOPE);
  assert.equal(reply.kind, 'value');
  assert.ok(reply.alias, 'a destination scope was given, so an alias comes back');
  assert.notEqual(reply.alias, clipboard, 'correlating the two destinations is the leak §6.3 prevents');

  // Both stand for the same value, and the alias is immediately renderable.
  const aliasResolution = await readBack(api, reply.alias!);
  assert.equal(aliasResolution.kind === 'value' && aliasResolution.value, IBAN);
});

test('the same value copied twice keeps one record, and one alias per scope', async () => {
  const { browser, api } = await wire();
  const [first] = (await browser.mint([mintIban])).tokens!;
  const [second] = (await browser.mint([mintIban])).tokens!;
  assert.equal(first, second, 'one value, one token within a scope');

  const a = await readBack(api, first!, EDITOR_SCOPE);
  const b = await readBack(api, second!, EDITOR_SCOPE);
  assert.equal(a.alias, b.alias, 'and one alias per destination');
});

test('page formatting does not fork the record', async () => {
  const { browser, api } = await wire();
  // The same IBAN, spelled without spaces on some other page.
  const [spaced] = (await browser.mint([mintIban])).tokens!;
  const [bare] = (await browser.mint([
    { ...mintIban, value: 'CH9300762011623852957' },
  ])).tokens!;

  assert.equal(spaced, bare, 'identity is the normalised form (SPEC §5.1)');
  const held = await readBack(api, spaced!);
  assert.equal(held.kind === 'value' && held.value, IBAN, 'the first spelling seen is what the user is shown');
});

test('two source origins never share a token for one value (SPEC §6.3)', async () => {
  const { browser } = await wire();
  const [here] = (await browser.mint([mintIban])).tokens!;
  const [there] = (await browser.mint([{ ...mintIban, scopeId: 'source:https://other.example' }])).tokens!;
  assert.notEqual(here, there);
});

test('revoking kills the clipboard token and the destination alias together', async () => {
  const { browser, api } = await wire();
  const [clipboard] = (await browser.mint([mintIban])).tokens!;
  const reply = await readBack(api, clipboard!, EDITOR_SCOPE);

  const revoked = api.revoke(clipboard!).body as { revoked: number };
  assert.equal(revoked.revoked, 2, 'both aliases, one record');

  const dead = await readBack(api, reply.alias!);
  assert.equal(dead.kind, 'tombstone', 'a dead token stays legible, never a bare unknown (SPEC §6.7)');
});

test('the browser refuses to invent a token when the vault is unreachable', async () => {
  const policy: Policy = { ...DEFAULT_POLICY, detectEndpoint: `${ORIGIN}/v1/detect` };
  const client = new VaultClient({
    policy,
    maxAttempts: 1,
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  assert.equal((await client.mint([mintIban])).tokens, null);
});

// --- the edit path: child tokens and drafts (SPEC §8.4) ----------------------

test('editing a revealed value mints a child, not a second unrelated token', async () => {
  const { browser, api } = await wire();
  const [parent] = (await browser.mint([mintIban])).tokens!;

  const child = (await browser.mintChild(
    parent!,
    'CH56 0483 5012 3456 7800 9',
    'CH5604835012345678009',
    EDITOR_SCOPE,
  ))!;
  assert.match(child, /^ANM1-IBAN-/);
  assert.notEqual(child, parent);

  const held = await readBack(api, child);
  assert.equal(held.kind === 'value' && held.value, 'CH56 0483 5012 3456 7800 9');
});

test('a draft moves as the user types, without minting again', async () => {
  const { browser, api } = await wire();
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'CH5', 'CH5', EDITOR_SCOPE))!;

  assert.equal(await browser.updateDraft(child, 'CH56 0483', 'CH560483'), true);
  assert.equal(await browser.updateDraft(child, 'CH56 0483 5012', 'CH5604835012'), true);

  const held = await readBack(api, child);
  assert.equal(held.kind === 'value' && held.value, 'CH56 0483 5012', 'one token, the value moved under it');
});

test('committing a draft is what puts it in the value index', async () => {
  const vault = await openMockVault();
  const { browser } = await wire(vault);
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'Anna', 'anna', EDITOR_SCOPE))!;

  const indexed = () => Object.keys(vault.state.index).length;
  const before = indexed();
  assert.equal(await browser.commitDraft(child), true);
  assert.equal(indexed(), before + 1, 'a moving value has no business in an index');
  assert.equal(await browser.commitDraft(child), false, 'committing twice is not a thing');
});

test('a child of a child reparents to the root — depth 1, always (SPEC §8.4)', async () => {
  const vault = await openMockVault();
  const { browser } = await wire(vault);
  const [root] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(root!, 'first edit', 'first edit', EDITOR_SCOPE))!;
  const grandchild = (await browser.mintChild(child, 'second edit', 'second edit', EDITOR_SCOPE))!;

  const rootId = vault.state.aliases[root!]!.valueId;
  assert.equal(vault.state.records[vault.state.aliases[child]!.valueId]!.parentId, rootId);
  assert.equal(
    vault.state.records[vault.state.aliases[grandchild]!.valueId]!.parentId,
    rootId,
    'chains make revocation a graph traversal and lineage unreadable',
  );
});

test('revoking the parent kills every child with it', async () => {
  const { browser, api } = await wire();
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'an edit', 'an edit', EDITOR_SCOPE))!;

  const { revoked } = api.revoke(parent!).body as { revoked: number };
  assert.equal(revoked, 2, 'the inheritance that makes the scheme defensible');

  const after = (await api.resolve({ token: child })).body as { kind: string };
  assert.equal(after.kind, 'tombstone');
});

test('children are marked user-modified, so a destination knows they are not canonical', async () => {
  const vault = await openMockVault();
  const { browser } = await wire(vault);
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'an edit', 'an edit', EDITOR_SCOPE))!;
  assert.equal(vault.state.records[vault.state.aliases[child]!.valueId]!.userModified, true);
});

test('an abandoned draft is collected and leaves a tombstone, not nothing', async () => {
  let clock = 1_000_000;
  const vault = await Vault.open(Vault.newKey(), undefined, VAULT_POLICY, () => clock);
  const { browser, api } = await wire(vault);
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'half typed', 'half typed', EDITOR_SCOPE))!;

  clock += VAULT_POLICY.draftMs + 1;
  // Any touch sweeps; a draft token can escape before it is ever committed.
  const after = (await api.resolve({ token: child })).body as { kind: string };
  assert.equal(after.kind, 'tombstone');
  assert.equal(vault.state.records[vault.state.aliases[child]?.valueId ?? ''], undefined);
});

test('a committed child is not swept away with the drafts', async () => {
  let clock = 1_000_000;
  const vault = await Vault.open(Vault.newKey(), undefined, VAULT_POLICY, () => clock);
  const { browser, api } = await wire(vault);
  const [parent] = (await browser.mint([mintIban])).tokens!;
  const child = (await browser.mintChild(parent!, 'kept', 'kept', EDITOR_SCOPE))!;
  await browser.commitDraft(child);

  clock += VAULT_POLICY.draftMs + 1;
  const after = (await api.resolve({ token: child })).body as { kind: string };
  assert.equal(after.kind, 'value');
});

test('a child of a token the vault does not hold is refused, not orphaned', async () => {
  const { browser } = await wire();
  const stranger = (await import('../src/lib/tokens.ts')).mintToken('PERSON');
  assert.equal(await browser.mintChild(stranger, 'x', 'x', EDITOR_SCOPE), null);
});

test('updating something that is not a draft changes nothing', async () => {
  const { browser } = await wire();
  const [committed] = (await browser.mint([mintIban])).tokens!;
  assert.equal(await browser.updateDraft(committed!, 'nope', 'nope'), false);
});

// --- the whole journey: prose with values in it, and back (SPEC §7, §8.10) ---

test('a sentence copied from NATIVE reveals identically on TRUSTED', async () => {
  const { browser, api } = await wire();

  // 1. NATIVE: scan a sentence holding three values, and copy all of it.
  const doc = domFrom(
    '<p id="p">Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7, ' +
      'Mail anna.meier@example.org — bitte prüfen.</p>',
  );
  const { registry } = await runPipeline(doc.body, detector, { locale: 'de-CH' });
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('#p')!);
  const original = range.toString();

  const minter = createRemoteMinter(BROWSER_SCOPE, (specs) => browser.mint(specs));
  const { hits } = collectHits([range], registry);
  assert.ok((await minter.ensure(hits)).ok);
  const clipboard = planCopy([range], original, registry, minter)!;

  // 2. The clipboard: prose intact, every value gone.
  assert.equal(clipboard.ready, true);
  assert.ok(clipboard.text.startsWith('Kunde ANM1-PERSON-'));
  assert.ok(clipboard.text.includes(', IBAN ANM1-IBAN-'));
  assert.ok(clipboard.text.endsWith(' — bitte prüfen.'), 'the prose is carried through');
  for (const secret of ['Anna Meier', 'CH93', 'anna.meier@example.org']) {
    assert.ok(!clipboard.text.includes(secret), `${secret} must not survive the copy`);
  }

  // 3. TRUSTED: paste it into a field.
  const trusted = domFrom('<input id="f">');
  const surface = fakeSurface();
  const revealer = createRevealer(trusted, { scopeId: EDITOR_SCOPE, surface });
  const field = trusted.querySelector<HTMLInputElement>('#f')!;
  firePaste(trusted, field, clipboard.text);

  assert.equal(field.value, clipboard.text, 'the field holds prose and tokens, never values');
  const mount = surface.lastMount!;
  assert.equal(mount.mode, 'reveal', 'three spans is not an editable case');

  // 4. The frame resolves what the field holds, and the line comes back whole.
  const answers = new Map<string, Resolution | null>();
  for (const match of scanTokens(mount.token)) {
    const reply = (await api.resolve({ token: match.token })).body as Resolution;
    answers.set(match.token, reply);
  }
  const rendered = revealSegments(mount.token, answers)
    .map((s) => s.text)
    .join('');

  assert.equal(rendered, original, 'what the user reads is what they copied');
  revealer.detach();
});

test('a value repeated in one sentence is one record and reads back in both places', async () => {
  const { browser, api } = await wire();
  const doc = domFrom(
    '<p id="p">Von CH93 0076 2011 6238 5295 7 nach CH93 0076 2011 6238 5295 7.</p>',
  );
  const { registry } = await runPipeline(doc.body, detector, { locale: 'de-CH' });
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('#p')!);
  const original = range.toString();

  const minter = createRemoteMinter(BROWSER_SCOPE, (specs) => browser.mint(specs));
  await minter.ensure(collectHits([range], registry).hits);
  const clipboard = planCopy([range], original, registry, minter)!;

  const tokens = scanTokens(clipboard.text);
  assert.equal(tokens.length, 2, 'two occurrences');
  assert.equal(tokens[0]!.token, tokens[1]!.token, 'one value, one token (SPEC §5)');

  const answers = new Map<string, Resolution | null>([
    [tokens[0]!.token, (await api.resolve({ token: tokens[0]!.token })).body as Resolution],
  ]);
  assert.equal(revealSegments(clipboard.text, answers).map((s) => s.text).join(''), original);
});

test('a revoked value in the middle of a sentence does not take the sentence with it', async () => {
  const { browser, api } = await wire();
  const doc = domFrom('<p id="p">Kunde Anna Meier, IBAN CH93 0076 2011 6238 5295 7.</p>');
  const { registry } = await runPipeline(doc.body, detector, { locale: 'de-CH' });
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('#p')!);

  const minter = createRemoteMinter(BROWSER_SCOPE, (specs) => browser.mint(specs));
  await minter.ensure(collectHits([range], registry).hits);
  const clipboard = planCopy([range], range.toString(), registry, minter)!;

  const [first, second] = scanTokens(clipboard.text);
  api.revoke(first!.token);

  const answers = new Map<string, Resolution | null>();
  for (const t of [first!, second!]) {
    answers.set(t.token, (await api.resolve({ token: t.token })).body as Resolution);
  }
  const segments = revealSegments(clipboard.text, answers);

  assert.ok(segments.some((s) => s.kind === 'dead' && /revoked/.test(s.text)));
  assert.ok(
    segments.some((s) => s.kind === 'value' && s.text.startsWith('CH93')),
    'the IBAN beside it still reads',
  );
});
