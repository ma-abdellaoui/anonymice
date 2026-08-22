import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POLICY, Vault } from '../src/lib/vault.ts';
import type { VaultPolicy } from '../src/lib/vault.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

class Clock {
  t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

async function open(policy: Partial<VaultPolicy> = {}): Promise<{ v: Vault; c: Clock }> {
  const c = new Clock();
  const v = await Vault.open(Vault.newKey(), undefined, { ...DEFAULT_POLICY, ...policy }, c.now);
  return { v, c };
}

const ANNA = { cls: 'PERSON' as const, value: 'Anna Meier', normalized: 'anna meier' };

test('same value and same scope reuse one token', async () => {
  const { v } = await open();
  const a = await v.mint({ ...ANNA, scopeId: 'git@github.com:acme/app' });
  const b = await v.mint({ ...ANNA, scopeId: 'git@github.com:acme/app' });
  assert.equal(a, b);
});

test('same value in a different scope gets a different token (SPEC §6.3)', async () => {
  const { v } = await open();
  const a = await v.mint({ ...ANNA, scopeId: 'scope-a' });
  const b = await v.mint({ ...ANNA, scopeId: 'scope-b' });
  assert.notEqual(a, b, 'globally stable tokens would let destinations correlate a subject');
  assert.equal(v.resolve(a).kind, 'value');
  assert.equal(v.resolve(b).kind, 'value');
});

test('two formattings of one value collapse onto one record', async () => {
  const { v } = await open();
  const a = await v.mint({ cls: 'IBAN', value: 'CH93 0076 2011 6238 5295 7', normalized: 'CH9300762011623852957', scopeId: 's' });
  const b = await v.mint({ cls: 'IBAN', value: 'CH9300762011623852957', normalized: 'CH9300762011623852957', scopeId: 's' });
  assert.equal(a, b, 'identity is the normalized form, not the formatting');
});

test('the token is not derived from the plaintext', async () => {
  const { v: v1 } = await open();
  const { v: v2 } = await open();
  const a = await v1.mint({ ...ANNA, scopeId: 's' });
  const b = await v2.mint({ ...ANNA, scopeId: 's' });
  assert.notEqual(a, b, 'same value in two vaults must not produce the same token (SPEC §6.3)');
});

test('an alias goes stale after T_idle and a fresh one is issued', async () => {
  const { v, c } = await open({ idleMs: 12 * HOUR });
  const a = await v.mint({ ...ANNA, scopeId: 's' });
  c.advance(13 * HOUR);
  const b = await v.mint({ ...ANNA, scopeId: 's' });
  assert.notEqual(a, b);
});

test('an alias is retired at T_max even while in use', async () => {
  const { v, c } = await open({ idleMs: 12 * HOUR, maxMs: 7 * DAY });
  const a = await v.mint({ ...ANNA, scopeId: 's' });
  // Keep it in continuous use — idle never reaches T_idle — for longer than T_max.
  for (let i = 0; i < 40; i++) {
    c.advance(6 * HOUR);
    v.resolve(a);
  }
  const b = await v.mint({ ...ANNA, scopeId: 's' });
  assert.notEqual(a, b, 'T_max is an absolute ceiling on an alias');
});

test('resolve returns the plaintext and rolls the retention clock', async () => {
  const { v, c } = await open({ retainMs: 90 * DAY });
  const t = await v.mint({ ...ANNA, scopeId: 's' });
  c.advance(80 * DAY);
  const r = v.resolve(t);
  assert.equal(r.kind, 'value');
  assert.equal(r.kind === 'value' && r.value, 'Anna Meier');
  c.advance(80 * DAY);
  assert.equal(v.resolve(t).kind, 'value', 'a token in active use must not die mid-workflow');
});

test('an abandoned token expires into a legible tombstone (SPEC §6.7)', async () => {
  const { v, c } = await open({ retainMs: 90 * DAY });
  const t = await v.mint({ ...ANNA, scopeId: 'crm.example' });
  c.advance(91 * DAY);
  const r = v.resolve(t);
  assert.equal(r.kind, 'tombstone');
  if (r.kind !== 'tombstone') return;
  assert.equal(r.tombstone.state, 'expired');
  assert.equal(r.tombstone.cls, 'PERSON');
  assert.equal(r.tombstone.sourceScope, 'crm.example');
});

test('expiry destroys the plaintext and the value index', async () => {
  const { v, c } = await open({ retainMs: 1 * DAY });
  const t = await v.mint({ ...ANNA, scopeId: 's' });
  c.advance(2 * DAY);
  v.resolve(t);
  assert.equal(Object.keys(v.state.records).length, 0, 'plaintext must be gone');
  assert.equal(Object.keys(v.state.index).length, 0, 'the value index must be gone too');
  assert.equal(Object.keys(v.state.tombstones).length, 1, 'the tombstone holds no plaintext');
});

test('a warning is raised before death, with the date', async () => {
  const { v, c } = await open({ retainMs: 90 * DAY, warnMs: 7 * DAY });
  const t = await v.mint({ ...ANNA, scopeId: 's' });
  assert.equal(v.resolve(t).kind === 'value' && (v.resolve(t) as { expiringSoon: boolean }).expiringSoon, false);
  // Let it idle to within the warning window without resolving (which would roll the clock).
  const t2 = await v.mint({ cls: 'IBAN', value: 'x', normalized: 'x', scopeId: 's' });
  c.advance(85 * DAY);
  const r = v.resolve(t2);
  assert.equal(r.kind === 'value' && r.expiringSoon, true);
});

test('revocation is immediate and kills derivatives (SPEC §8.4)', async () => {
  const { v } = await open();
  const parent = await v.mint({ ...ANNA, scopeId: 's' });
  const parentId = v.state.aliases[parent]!.valueId;
  const child = await v.mint({
    cls: 'PERSON', value: 'Anna M', normalized: 'anna m', scopeId: 's',
    parentId, userModified: true,
  });
  assert.equal(v.resolve(child).kind, 'value');
  v.revoke(parent);
  assert.equal(v.resolve(parent).kind, 'tombstone');
  assert.equal(v.resolve(child).kind, 'tombstone', 'revoke the record and every derivative dies with it');
  assert.equal((v.resolve(child) as { tombstone: { state: string } }).tombstone.state, 'revoked');
});

test('an unknown but well-formed token reads as foreign, not as a failure', async () => {
  const { v: mine } = await open();
  const { v: theirs } = await open();
  const t = await theirs.mint({ ...ANNA, scopeId: 's' });
  const r = mine.resolve(t);
  assert.equal(r.kind, 'foreign');
  assert.equal(r.kind === 'foreign' && r.cls, 'PERSON');
});

test('a mangled token reads as damaged, ordinary text as none', async () => {
  const { v } = await open();
  const t = await v.mint({ ...ANNA, scopeId: 's' });
  const bad = t.slice(0, -1) + (t.endsWith('Z') ? 'Y' : 'Z');
  assert.equal(v.resolve(bad).kind, 'damaged');
  assert.equal(v.resolve('just prose').kind, 'none');
});

test('rescope gives a second alias for one record, not a second record', async () => {
  const vault = await Vault.open(Vault.newKey());
  const source = await vault.mint({
    cls: 'IBAN',
    value: 'CH93 0076 2011 6238 5295 7',
    normalized: 'CH9300762011623852957',
    scopeId: 'source:https://crm.example',
  });

  const alias = vault.rescope(source, 'file:///ws')!;
  assert.notEqual(alias, source, 'two destinations must not correlate (SPEC §6.3)');
  assert.equal(Object.keys(vault.state.records).length, 1, 'one value, one record');

  const resolved = vault.resolve(alias);
  assert.equal(resolved.kind, 'value');
  assert.equal(resolved.kind === 'value' && resolved.value, 'CH93 0076 2011 6238 5295 7');

  assert.equal(vault.rescope(alias, 'file:///ws'), alias, 'the same destination reuses its alias');
});

test('rescoping a token this vault does not hold invents nothing', async () => {
  const vault = await Vault.open(Vault.newKey());
  assert.equal(vault.rescope('ANM1-IBAN-K3F9QW2MX7VBNC4H8', 'file:///ws'), null);
  assert.equal(Object.keys(vault.state.records).length, 0);
});

test('revoking the source kills the alias it was re-scoped into', async () => {
  const vault = await Vault.open(Vault.newKey());
  const source = await vault.mint({
    cls: 'PERSON', value: 'Anna Meier', normalized: 'anna meier', scopeId: 's1',
  });
  const alias = vault.rescope(source, 's2')!;

  assert.equal(vault.revoke(source), 2);
  assert.equal(vault.resolve(alias).kind, 'tombstone');
});
