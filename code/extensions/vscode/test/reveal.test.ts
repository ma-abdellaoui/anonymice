import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeResolution, planReveal } from '../src/lib/reveal.ts';
import { DEFAULT_POLICY, Vault } from '../src/lib/vault.ts';

async function vaultWith(cls: 'PERSON' | 'SECRET', value: string): Promise<{ v: Vault; token: string }> {
  const v = await Vault.open(Vault.newKey(), undefined, DEFAULT_POLICY);
  const token = await v.mint({ cls, value, normalized: value.toLowerCase(), scopeId: 's' });
  return { v, token };
}

test('annotate leaves the token in the buffer and renders the value beside it', async () => {
  const { v, token } = await vaultWith('SECRET', 'hunter2-prod-9f');
  const src = `DB_PASSWORD=${token}\n`;
  const plan = planReveal(src, (t) => v.resolve(t), { mode: 'annotate', hidden: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.contentText, 'hunter2-prod-9f');
  assert.equal(plan[0]!.hide, false, 'annotate must never hide buffer text');
  assert.equal(src.slice(plan[0]!.start, plan[0]!.end), token, 'offsets index the source');
});

test('substitute hides the token', async () => {
  const { v, token } = await vaultWith('SECRET', 'hunter2-prod-9f');
  const plan = planReveal(`DB_PASSWORD=${token}`, (t) => v.resolve(t), { mode: 'substitute', hidden: false });
  assert.equal(plan[0]!.hide, true);
});

test('the global hide is one switch, and off means off (SPEC §7.1)', async () => {
  const { v, token } = await vaultWith('PERSON', 'Anna Meier');
  const src = `x ${token}`;
  assert.equal(planReveal(src, (t) => v.resolve(t), { mode: 'annotate', hidden: true }).length, 0);
  assert.equal(planReveal(src, (t) => v.resolve(t), { mode: 'off', hidden: false }).length, 0);
});

test('a multi-line value is never rendered inline (SPEC §7.1)', async () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----';
  const { v, token } = await vaultWith('SECRET', pem);
  const plan = planReveal(`key = ${token}`, (t) => v.resolve(t), { mode: 'substitute', hidden: false });
  assert.equal(plan[0]!.webviewOnly, true);
  assert.equal(plan[0]!.hide, false, 'must not hide the token when it cannot draw the value');
  assert.ok(!plan[0]!.contentText.includes('\n'), 'contentText would silently drop the newlines');
});

test('an explanation is never substituted for buffer text', async () => {
  const v = await Vault.open(Vault.newKey());
  const other = await Vault.open(Vault.newKey());
  const foreign = await other.mint({ cls: 'PERSON', value: 'x', normalized: 'x', scopeId: 's' });
  const plan = planReveal(`a ${foreign}`, (t) => v.resolve(t), { mode: 'substitute', hidden: false });
  assert.equal(plan[0]!.muted, true);
  assert.equal(plan[0]!.hide, false, 'hiding a token to show "from another vault" would erase the line');
});

test('non-tokens produce no decoration', async () => {
  const v = await Vault.open(Vault.newKey());
  assert.equal(planReveal('just some code', (t) => v.resolve(t), { mode: 'annotate', hidden: false }).length, 0);
});

test('the §6.7 legibility table', () => {
  const at = Date.parse('2026-06-01T00:00:00Z');
  assert.match(
    describeResolution({ kind: 'tombstone', tombstone: { token: 'x', cls: 'IBAN', mintedAt: at, endedAt: at, state: 'expired', sourceScope: 'crm.example' } }).text,
    /IBAN token from crm\.example — expired/,
  );
  assert.match(
    describeResolution({ kind: 'tombstone', tombstone: { token: 'x', cls: 'IBAN', mintedAt: at, endedAt: at, state: 'revoked', sourceScope: '' } }).text,
    /revoked/,
  );
  assert.match(describeResolution({ kind: 'foreign', cls: 'PERSON' }).text, /another vault or profile/);
  assert.match(describeResolution({ kind: 'damaged', cls: 'IBAN' }).text, /damaged IBAN token/);
  for (const kind of ['tombstone', 'foreign', 'damaged'] as const) {
    const r = kind === 'tombstone'
      ? describeResolution({ kind, tombstone: { token: 'x', cls: 'C', mintedAt: at, endedAt: at, state: 'expired', sourceScope: '' } })
      : kind === 'foreign'
        ? describeResolution({ kind, cls: 'C' })
        : describeResolution({ kind, cls: 'C' });
    assert.equal(r.muted, true, 'an explanation must render as an explanation');
  }
});
