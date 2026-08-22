/**
 * What this server is willing to *publish* — the mirror image of the client's
 * `sanitizeRemotePolicy` (ENDPOINTS.md §2.5).
 *
 * The client already refuses everything below, so why do it again on the way
 * out? Because a rejection on the client is a host that quietly stops being
 * protected, discovered — if at all — in a diagnostics dump on someone's laptop.
 * Catching it here puts the error next to the file that caused it, at the moment
 * an operator edits that file, which is the only place it can actually be fixed.
 *
 * Host-pattern validity is not re-implemented: `isValidHostPattern` and
 * `MAX_HOSTS` are the client's own, vendored under `src/lib/` and diffed by
 * `npm run parity`. A server and a client that disagree about what a hostname is
 * would produce exactly the silent shortening this is here to prevent.
 */
import { isValidHostPattern, MAX_HOSTS } from '../lib/policy.ts';

/** The fields `GET /v1/policy` may state. Everything else is dropped. */
export interface ServedPolicy {
  policyVersion?: string;
  locale?: string;
  native?: string[];
  trusted?: string[];
  scanTrusted?: 'off' | 'readonly' | 'full';
  detectEndpoint?: string;
  detectToken?: string;
  maxAgeSeconds?: number;
}

export interface SanitizedPolicy {
  policy: ServedPolicy;
  /** Everything dropped, with its reason. Logged at load; never silent. */
  rejected: string[];
}

/**
 * Keys a response may not carry, each for a reason the client also enforces
 * (ENDPOINTS.md §2.4). Serving them would be harmless — the client drops them —
 * but it would fill the client's `rejected` list with noise, and a rejection
 * list that cries wolf stops being read.
 */
const REFUSED = new Set(['policyEndpoint', 'activated', 'painter']);

const ALLOWED = new Set([
  'policyVersion', 'locale', 'native', 'trusted', 'scanTrusted', 'detectEndpoint', 'detectToken', 'maxAgeSeconds',
]);

export function sanitizeServedPolicy(raw: unknown): SanitizedPolicy {
  const rejected: string[] = [];
  const policy: ServedPolicy = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy, rejected: ['body: not a JSON object'] };
  }
  const source = raw as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    if (REFUSED.has(key)) rejected.push(`${key}: not the policy server's to state (ENDPOINTS.md §2.4)`);
    else if (!ALLOWED.has(key)) rejected.push(`${key}: unknown key, the client would drop it`);
  }

  for (const key of ['policyVersion', 'locale', 'detectToken'] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value) policy[key] = value;
    else rejected.push(`${key}: not a non-empty string`);
  }

  const native = sanitizeHosts(source.native, 'native', rejected);
  if (native) policy.native = native;
  const trusted = sanitizeHosts(source.trusted, 'trusted', rejected);
  if (trusted) policy.trusted = trusted;

  if (source.scanTrusted !== undefined) {
    if (source.scanTrusted === 'off' || source.scanTrusted === 'readonly' || source.scanTrusted === 'full') {
      policy.scanTrusted = source.scanTrusted;
    } else {
      rejected.push(`scanTrusted: ${JSON.stringify(source.scanTrusted)} is not off|readonly|full`);
    }
  }

  if (source.detectEndpoint !== undefined) {
    // The client pins the origin to its managed policy and will refuse anything
    // else (ENDPOINTS.md §2.4), so only a path is ever useful here. Serving an
    // absolute URL is allowed — it may match the pin — but a relative path is
    // the form that cannot be wrong.
    if (typeof source.detectEndpoint === 'string' && source.detectEndpoint) policy.detectEndpoint = source.detectEndpoint;
    else rejected.push('detectEndpoint: not a non-empty string');
  }

  if (source.maxAgeSeconds !== undefined) {
    const n = source.maxAgeSeconds;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) policy.maxAgeSeconds = Math.floor(n);
    else rejected.push('maxAgeSeconds: not a non-negative number');
  }

  return { policy, rejected };
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
