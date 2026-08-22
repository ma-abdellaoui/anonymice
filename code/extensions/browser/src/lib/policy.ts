/**
 * Host classification — SPEC §1.
 *
 * The list is distributed via chrome.storage.managed and is not user-editable.
 * Classification decides *whether a content script exists on that host at all*,
 * which is why it lives here and not behind an early return in the page.
 */
import type { HostClass } from './types.ts';

export interface PolicyLists {
  native: string[];
  trusted: string[];
  /** Untrusted hosts the user has activated for the reveal path (SPEC §1). */
  activated?: string[];
}

export interface Policy extends PolicyLists {
  policyVersion: string;
  locale: string;
  detectEndpoint: string;
  detectToken: string;
  /**
   * Where the refreshable copy of the lists is served (`GET /v1/policy`).
   * Empty disables the pull entirely and the lists are whatever the
   * administrator set locally — see docs/extensions/browser/ENDPOINTS.md §2.
   */
  policyEndpoint: string;
  /** How often the worker re-pulls. Chrome's alarm floor is 1 minute. */
  policyRefreshMinutes: number;
  /** SPEC §1: off | readonly | full. Only `off` is implemented today. */
  scanTrusted: 'off' | 'readonly' | 'full';
  /** `overlay` forces the fallback painter, for engines or QA runs where the
   *  Custom Highlight API is unavailable or suspect (SPEC §4). */
  painter: 'auto' | 'overlay';
}

export const DEFAULT_POLICY: Policy = {
  policyVersion: '2026-08-01',
  locale: 'de-CH',
  detectEndpoint: 'http://localhost:8788/v1/detect',
  detectToken: 'dev-token',
  policyEndpoint: '',
  policyRefreshMinutes: 60,
  native: [],
  trusted: [],
  activated: [],
  scanTrusted: 'off',
  painter: 'auto',
};

export interface PolicySources {
  /** Compiled into a QA build. Lowest precedence; absent from shipped builds. */
  baked?: Partial<Policy> | null;
  /**
   * The sanitised body of `GET /v1/policy`. Above the baked default because a
   * pull is how the lists stay current between managed-policy pushes; below
   * `local` because `local` is only reachable from the extension's own devtools
   * and is the break-glass a developer needs to keep (ENDPOINTS.md §2.4).
   */
  remote?: Partial<Policy> | null;
  /** chrome.storage.local — the developer override. */
  local?: Partial<Policy> | null;
  /** chrome.storage.managed — administrator policy, and authoritative (SPEC §1). */
  managed?: Partial<Policy> | null;
}

/**
 * Resolution order, lowest to highest: defaults, baked QA policy, pulled remote
 * policy, local storage, managed policy. Managed still wins outright — it is the
 * enrollment and the root of trust, and the pull is a delegation of it, not a
 * replacement (SPEC §1, ENDPOINTS.md §2.4).
 */
export function resolvePolicy(sources: PolicySources): Policy {
  return {
    ...DEFAULT_POLICY,
    ...(sources.baked ?? {}),
    ...(sources.remote ?? {}),
    ...(sources.local ?? {}),
    ...(sources.managed ?? {}),
  };
}

/** `example.org` matches that host exactly; `*.example.org` matches subdomains. */
export function matchesHost(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === p;
}

export function classifyHost(host: string, lists: PolicyLists): HostClass {
  if (lists.native.some((p) => matchesHost(host, p))) return 'NATIVE';
  if (lists.trusted.some((p) => matchesHost(host, p))) return 'TRUSTED';
  return 'UNTRUSTED';
}

/** Content-script match patterns for the classes we actually register on. */
export function matchPatternsFor(lists: PolicyLists): string[] {
  // Chrome reads a host without a wildcard as an exact host, and `*.example.org`
  // as "that host and its subdomains" — the same shape covers both list forms.
  return [...lists.native, ...lists.trusted].map((p) => `*://${p}/*`);
}

/**
 * Keys `GET /v1/policy` is allowed to speak to. Everything else in a response
 * body is dropped rather than merged, so a new field on the server cannot start
 * steering the client before the client knows what it means.
 *
 * Three deliberate omissions (ENDPOINTS.md §2.4):
 *  - `policyEndpoint`, so a response cannot redirect the next pull elsewhere;
 *  - `activated`, because an activated `UNTRUSTED` host is the user's own
 *    consent (SPEC §1) and is not the server's to grant;
 *  - `painter`, a local debugging knob with no business crossing the network.
 */
const REMOTE_KEYS = [
  'policyVersion',
  'locale',
  'native',
  'trusted',
  'scanTrusted',
  'detectEndpoint',
  'detectToken',
] as const;

/**
 * Protocol fields that belong to the response envelope rather than the policy.
 * They are read elsewhere (or by nobody), and must not be reported as junk —
 * a rejection list that cries wolf stops being read.
 */
const ENVELOPE_KEYS = new Set(['maxAgeSeconds', 'issuedAt']);

/** Bounds the registration cost of a bad or hostile list. */
export const MAX_HOSTS = 512;

export interface SanitizeResult {
  policy: Partial<Policy>;
  /** Every value dropped, with the reason. Surfaced so a silent list is loud. */
  rejected: string[];
}

/**
 * `example.org` or `*.example.org` — a hostname, nothing else. A pattern is
 * interpolated straight into a `*://<pattern>/*` match, so a stray `*`, path or
 * port there is not a cosmetic problem: `*` alone would register the extension
 * on every site there is.
 */
export function isValidHostPattern(pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p || p.length > 253) return false;
  const bare = p.startsWith('*.') ? p.slice(2) : p;
  if (!bare || bare.includes('*')) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(bare);
}

function sanitizeHosts(raw: unknown, field: string, rejected: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    rejected.push(`${field}: not an array`);
    return undefined;
  }
  const kept: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isValidHostPattern(entry)) {
      rejected.push(`${field}: ${JSON.stringify(entry)} is not a host pattern`);
      continue;
    }
    if (kept.length >= MAX_HOSTS) {
      rejected.push(`${field}: over ${MAX_HOSTS} entries, tail dropped`);
      break;
    }
    kept.push(entry.trim().toLowerCase());
  }
  return kept;
}

/**
 * Reduce a `GET /v1/policy` body to the part the client is willing to act on.
 *
 * `pin` is the locally-configured detect endpoint. A pulled `detectEndpoint`
 * may change the path but never the origin: the pull decides *where we scan*,
 * and it must not also be able to decide *where the page text goes*. Moving the
 * detector is a managed-policy change, deliberately.
 */
export function sanitizeRemotePolicy(body: unknown, pin: string): SanitizeResult {
  const rejected: string[] = [];
  const policy: Partial<Policy> = {};
  if (!body || typeof body !== 'object') return { policy, rejected: ['body: not an object'] };
  const raw = body as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (!(REMOTE_KEYS as readonly string[]).includes(key)) rejected.push(`${key}: not a remote-settable key`);
  }

  const native = sanitizeHosts(raw.native, 'native', rejected);
  if (native) policy.native = native;
  const trusted = sanitizeHosts(raw.trusted, 'trusted', rejected);
  if (trusted) policy.trusted = trusted;

  for (const key of ['policyVersion', 'locale'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) policy[key] = raw[key] as string;
    else if (raw[key] !== undefined) rejected.push(`${key}: not a non-empty string`);
  }

  if (raw.scanTrusted !== undefined) {
    if (raw.scanTrusted === 'off' || raw.scanTrusted === 'readonly' || raw.scanTrusted === 'full') {
      policy.scanTrusted = raw.scanTrusted;
    } else {
      rejected.push(`scanTrusted: ${JSON.stringify(raw.scanTrusted)} is not off|readonly|full`);
    }
  }

  if (typeof raw.detectToken === 'string' && raw.detectToken) policy.detectToken = raw.detectToken;
  else if (raw.detectToken !== undefined) rejected.push('detectToken: not a non-empty string');

  if (raw.detectEndpoint !== undefined) {
    if (typeof raw.detectEndpoint === 'string' && sameOrigin(raw.detectEndpoint, pin)) {
      policy.detectEndpoint = raw.detectEndpoint;
    } else {
      rejected.push(`detectEndpoint: ${JSON.stringify(raw.detectEndpoint)} is off the configured origin`);
    }
  }

  return { policy, rejected };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
