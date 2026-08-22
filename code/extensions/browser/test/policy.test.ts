import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyHost,
  isValidHostPattern,
  matchesHost,
  matchPatternsFor,
  MAX_HOSTS,
  resolvePolicy,
  sanitizeRemotePolicy,
} from '../src/lib/policy.ts';

const lists = { native: ['crm.internal.example', '*.clinic.example'], trusted: ['docs.partner.example'] };

test('everything not listed is UNTRUSTED (SPEC §1)', () => {
  assert.equal(classifyHost('crm.internal.example', lists), 'NATIVE');
  assert.equal(classifyHost('records.clinic.example', lists), 'NATIVE');
  assert.equal(classifyHost('clinic.example', lists), 'NATIVE');
  assert.equal(classifyHost('docs.partner.example', lists), 'TRUSTED');
  assert.equal(classifyHost('chat.somewhere.example', lists), 'UNTRUSTED');
});

test('a wildcard never leaks past the dot boundary', () => {
  assert.ok(matchesHost('a.b.clinic.example', '*.clinic.example'));
  assert.ok(!matchesHost('evilclinic.example', '*.clinic.example'));
  assert.ok(!matchesHost('clinic.example.attacker.test', '*.clinic.example'));
});

test('an exact pattern does not match subdomains', () => {
  assert.ok(!matchesHost('sub.crm.internal.example', 'crm.internal.example'));
});

test('managed policy outranks storage and the baked QA default (SPEC §1)', () => {
  const resolved = resolvePolicy({
    baked: { native: ['localhost'], detectToken: 'dev-token' },
    local: { native: ['staging.example'], locale: 'fr-CH' },
    managed: { native: ['crm.internal.example'] },
  });
  assert.deepEqual(resolved.native, ['crm.internal.example'], 'the administrator has the last word');
  assert.equal(resolved.locale, 'fr-CH', 'unopposed local keys still apply');
  assert.equal(resolved.detectToken, 'dev-token', 'baked value survives where nothing overrides it');
  assert.equal(resolved.scanTrusted, 'off', 'untouched keys keep their default');
});

test('a shipped build with no sources at all lists no hosts', () => {
  const resolved = resolvePolicy({});
  assert.deepEqual([resolved.native, resolved.trusted], [[], []]);
  assert.equal(matchPatternsFor(resolved).length, 0, 'nothing to register, so nothing is touched');
});

test('a pulled list is a delegation of the managed one, not a replacement (ENDPOINTS.md §2.4)', () => {
  const resolved = resolvePolicy({
    baked: { native: ['localhost'] },
    remote: { native: ['crm.internal.example'], trusted: ['docs.partner.example'], locale: 'it-CH' },
    managed: { native: ['only.this.example'] },
  });
  assert.deepEqual(resolved.native, ['only.this.example'], 'an administrator who states the list still wins');
  assert.deepEqual(resolved.trusted, ['docs.partner.example'], 'and the pull fills what they left open');
  assert.equal(resolved.locale, 'it-CH');
});

test('the developer override still outranks the pull', () => {
  const resolved = resolvePolicy({
    remote: { native: ['crm.internal.example'] },
    local: { native: ['staging.example'] },
  });
  assert.deepEqual(resolved.native, ['staging.example'], 'reachable only from the extension devtools, and needed there');
});

test('nothing that is not a hostname becomes a match pattern', () => {
  for (const good of ['example.org', '*.example.org', 'localhost', 'a-b.c.example', 'native.anonymice.test']) {
    assert.ok(isValidHostPattern(good), good);
  }
  for (const bad of ['*', '*.', '', '*.*.example', 'http://example.org', 'example.org/x', 'example.org:8080', 'a b', '-x.example', 'x-.example']) {
    assert.ok(!isValidHostPattern(bad), bad);
  }
});

test('a hostile list cannot smuggle <all_urls> past registration', () => {
  const { policy, rejected } = sanitizeRemotePolicy({ native: ['*'] }, 'https://d.example/v1/detect');
  assert.deepEqual(policy.native, []);
  assert.equal(rejected.length, 1);
  assert.equal(matchPatternsFor({ native: policy.native ?? [], trusted: [] }).length, 0);
});

test('an oversized list is truncated, and says so', () => {
  const many = Array.from({ length: MAX_HOSTS + 5 }, (_, i) => `h${i}.example`);
  const { policy, rejected } = sanitizeRemotePolicy({ native: many }, 'https://d.example/v1/detect');
  assert.equal(policy.native?.length, MAX_HOSTS);
  assert.match(rejected.join(' '), /tail dropped/);
});

test('a body that is not a policy at all merges nothing', () => {
  for (const junk of [null, 'nope', 42, []]) {
    const { policy } = sanitizeRemotePolicy(junk, 'https://d.example/v1/detect');
    assert.deepEqual(policy.native, undefined);
  }
});
