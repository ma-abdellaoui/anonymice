import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, globToRegExp, mayResolveToProcess, mayReveal, mayScan } from '../src/lib/policy.ts';
import type { ResourceRule } from '../src/lib/policy.ts';

const RULES: ResourceRule[] = [
  { glob: 'fixtures/public/*.csv', class: 'UNTRUSTED' },
  { glob: 'fixtures/**/*.csv', class: 'NATIVE' },
  { glob: '.env', class: 'TRUSTED' },
  { glob: 'deploy/**', class: 'TRUSTED' },
];

test('unmatched paths are UNTRUSTED', () => {
  assert.equal(classify('src/index.ts', RULES), 'UNTRUSTED');
  assert.equal(classify('README.md', []), 'UNTRUSTED');
});

test('first matching rule wins, so a narrow rule can sit above a broad one', () => {
  assert.equal(classify('fixtures/public/list.csv', RULES), 'UNTRUSTED');
  assert.equal(classify('fixtures/customers/list.csv', RULES), 'NATIVE');
});

test('globs', () => {
  assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'));
  assert.ok(globToRegExp('**/*.ts').test('c.ts'), '** must match zero segments');
  assert.ok(!globToRegExp('*.ts').test('a/b.ts'), 'single star does not cross /');
  assert.ok(globToRegExp('deploy/**').test('deploy/k8s/secret.yaml'));
  assert.ok(globToRegExp('a?c.ts').test('abc.ts'));
  assert.ok(!globToRegExp('file.ts').test('filexts'), 'dot is literal');
});

test('leading ./ and backslashes normalise', () => {
  assert.equal(classify('./.env', RULES), 'TRUSTED');
  assert.equal(classify('deploy\\k8s\\x.yaml', RULES), 'TRUSTED');
});

test('scanning requires a trusted workspace and a classified resource (SPEC §5.1, §5.3)', () => {
  assert.ok(mayScan('NATIVE', true));
  assert.ok(!mayScan('NATIVE', false), 'restricted mode sends nothing off the machine');
  assert.ok(!mayScan('UNTRUSTED', true), 'an unclassified file is never chunked');
});

test('only TRUSTED resolves into a process, and never in restricted mode (SPEC §9)', () => {
  assert.ok(mayResolveToProcess('TRUSTED', true));
  assert.ok(!mayResolveToProcess('NATIVE', true));
  assert.ok(!mayResolveToProcess('TRUSTED', false));
});

test('reveal is opt-in on UNTRUSTED, on by default elsewhere (SPEC §3)', () => {
  assert.ok(!mayReveal('UNTRUSTED', false));
  assert.ok(mayReveal('UNTRUSTED', true));
  assert.ok(mayReveal('NATIVE', false));
});
