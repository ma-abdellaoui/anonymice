/**
 * The footgun that cost a real Confluence session — SPEC §1, ENDPOINTS.md §2.
 *
 * `build:qa --trusted=*.atlassian.net` baked the host, the extension registered
 * on it, and then the first policy pull (mock, one minute later) replaced the
 * list with the two fixture hosts and silently *unregistered* it. From the page
 * that is indistinguishable from the extension being broken: no content script
 * runs, so nothing can log.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchPatternsFor } from '../src/lib/policy.ts';

const lists = (native: string[], trusted: string[]) => ({ native, trusted, activated: [] });

test('a pulled list that omits a baked host drops it from the match patterns', () => {
  const baked = lists([], ['*.atlassian.net']);
  const pulled = lists([], ['trusted.anonymice.test']);

  assert.deepEqual(matchPatternsFor(baked, 'TRUSTED'), ['*://*.atlassian.net/*']);
  assert.deepEqual(matchPatternsFor(pulled, 'TRUSTED'), ['*://trusted.anonymice.test/*']);
  assert.ok(
    !matchPatternsFor(pulled, 'TRUSTED').includes('*://*.atlassian.net/*'),
    'this is the silent unregistration',
  );
});

test('the wildcard host pattern is the shape Chrome needs for a subdomain', () => {
  // `anonymice.atlassian.net` must match, or the build is pointed at nothing.
  assert.deepEqual(matchPatternsFor(lists([], ['*.atlassian.net']), 'TRUSTED'), [
    '*://*.atlassian.net/*',
  ]);
});

test('TRUSTED-only patterns exclude NATIVE hosts, so the gate stays off NATIVE', () => {
  const both = lists(['crm.internal'], ['*.atlassian.net']);
  assert.deepEqual(matchPatternsFor(both, 'TRUSTED'), ['*://*.atlassian.net/*']);
  assert.deepEqual(matchPatternsFor(both, 'NATIVE'), ['*://crm.internal/*']);
  assert.equal(matchPatternsFor(both).length, 2, 'and both together for the content script');
});
