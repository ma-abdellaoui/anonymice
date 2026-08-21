// Destination classification. See docs/USER_FLOWS.md §0.1.
//
// NOT a geography list. A Swiss region of a foreign provider fails the test,
// so .ch TLDs and IP geolocation are deliberately not inputs. This is a trust
// list curated by control, distributed via chrome.storage.managed — a trust
// list a user can edit is not a trust list.

export const CLASS = Object.freeze({
  TRUSTED: 'trusted',       // plaintext passes, no interception
  TOKENIZING: 'tokenizing', // full chokepoint + adapter
  UNKNOWN: 'unknown'        // extension does not activate; gateway is the backstop
});

const DEFAULTS = {
  trusted: ['vault.ourco.ch', 'intranet.ourco.ch', 'gateway.ourco.ch'],
  tokenizing: ['ourco.atlassian.net', 'api.atlassian.com', 'llm.ourco.ch'],
  vaultUrl: 'https://vault.ourco.ch',

  // Per-destination rendering. LLM paths get format-preserving surrogates so
  // the model can still reason; human-readable products get visible tokens so
  // a reader without the extension knows the value is not real.
  style: {
    'llm.ourco.ch': 'surrogate',
    '*': 'opaque'
  },

  // Operational identity vs. content identity: fields the service needs for
  // itself (login mail, mention handle, assignee) pass through untouched.
  // Matched against a JSON path within the request body.
  passthrough: {
    'ourco.atlassian.net': ['$.accountId', '$.author.email', '$.mention.id'],
    'api.atlassian.com': ['$.accountId']
  },

  // Typeahead / unfurl endpoints leak plaintext earlier and more often than
  // the document body does. Blocked here; a real deployment routes them to the
  // local directory instead.
  blockedPaths: {
    'ourco.atlassian.net': ['/wiki/rest/api/search/user', '/gateway/api/unfurl']
  }
};

let cache = null;

export async function load() {
  if (cache) return cache;
  let managed = {};
  try {
    managed = await chrome.storage.managed.get(null) || {};
  } catch { /* no enterprise policy present — dev default */ }
  cache = { ...DEFAULTS, ...managed };
  return cache;
}

export function invalidate() { cache = null; }

function hostOf(url) {
  try { return new URL(url, location?.href ?? undefined).hostname; } catch { return null; }
}

function matches(host, list) {
  return list.some((p) => host === p || host.endsWith('.' + p));
}

// Decisions are PER REQUEST, not per tab: a trusted page can still ship
// content to a foreign analytics or error-reporting endpoint.
export function classifyUrl(url, policy) {
  const host = hostOf(url);
  if (!host) return CLASS.UNKNOWN;
  if (matches(host, policy.trusted)) return CLASS.TRUSTED;
  if (matches(host, policy.tokenizing)) return CLASS.TOKENIZING;
  return CLASS.UNKNOWN;
}

export function styleFor(url, policy) {
  const host = hostOf(url);
  return policy.style[host] ?? policy.style['*'] ?? 'opaque';
}

export function isBlocked(url, policy) {
  const host = hostOf(url);
  const paths = policy.blockedPaths[host];
  if (!paths) return false;
  try {
    const p = new URL(url, location?.href ?? undefined).pathname;
    return paths.some((b) => p.startsWith(b));
  } catch { return false; }
}

export function passthroughPaths(url, policy) {
  return policy.passthrough[hostOf(url)] ?? [];
}
