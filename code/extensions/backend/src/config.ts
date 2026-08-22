/**
 * Startup configuration — every knob, in one place, resolved once.
 *
 * Two of these are security decisions rather than preferences, and both fail
 * loudly rather than defaulting to something convenient:
 *
 *  - **There is no default credential.** The service sees raw page text, so it
 *    sits inside the vault's trust boundary (SPEC §3.1). A baked-in bearer token
 *    would put that boundary one forgotten env var away from being no boundary
 *    at all, so an unset `DETECT_TOKEN` refuses to start. `--dev` is the only
 *    way to get `dev-token`, and it also pins the bind address to loopback.
 *  - **The bind address defaults to loopback.** Reaching the network is an
 *    explicit act (`HOST=0.0.0.0`), and one that warns about the TLS terminator
 *    it implies.
 */
import { isAbsolute, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Config {
  host: string;
  port: number;
  /**
   * Accepted bearer credentials, current first. More than one entry is how a
   * rotation lands without a window where in-flight clients are rejected
   * (ENDPOINTS.md §4): serve both, push the new one, drop the old one.
   */
  tokens: string[];
  policyFile: string;
  /** Bounded LRU of detection results; the only unbounded growth path there is. */
  cacheMaxEntries: number;
  /**
   * Hard ceiling on a request body, well above `LIMITS.maxTotalChars` so it only
   * catches bodies that never intended to respect the caps. Over it is a `413`,
   * not a `400`: `413` is the client's re-split signal (SPEC §3.2).
   */
  maxBodyBytes: number;
  /**
   * Origins allowed to make a browser request. Empty means the default policy:
   * any `chrome-extension://` origin (the service worker) plus loopback (the dev
   * harness). A wildcard is never sent.
   */
  allowedOrigins: string[];
  logLevel: LogLevel;
  dev: boolean;
}

export class ConfigError extends Error {}

export interface ConfigInput {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  cwd?: string;
}

export function loadConfig(input: ConfigInput = {}): Config {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  const cwd = input.cwd ?? process.cwd();
  const dev = argv.includes('--dev');

  const tokens = resolveTokens(env, dev);
  const port = intOr(env.PORT, 8788, 'PORT');
  const host = dev ? '127.0.0.1' : (env.HOST ?? '127.0.0.1');

  const policyFile = env.POLICY_FILE
    ? (isAbsolute(env.POLICY_FILE) ? env.POLICY_FILE : resolve(cwd, env.POLICY_FILE))
    : new URL('../policy.json', import.meta.url).pathname;

  return {
    host,
    port,
    tokens,
    policyFile,
    cacheMaxEntries: intOr(env.CACHE_MAX_ENTRIES, 5_000, 'CACHE_MAX_ENTRIES'),
    maxBodyBytes: intOr(env.MAX_BODY_BYTES, 1_048_576, 'MAX_BODY_BYTES'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: logLevelOf(env.LOG_LEVEL ?? 'info'),
    dev,
  };
}

function resolveTokens(env: NodeJS.ProcessEnv, dev: boolean): string[] {
  const current = env.DETECT_TOKEN?.trim();
  const previous = env.DETECT_TOKEN_PREVIOUS?.trim();
  if (!current) {
    if (dev) return ['dev-token'];
    throw new ConfigError(
      'DETECT_TOKEN is not set. This service receives raw page text and must not run ' +
        'with a default credential — set DETECT_TOKEN, or pass --dev for a loopback-only ' +
        'server with the well-known `dev-token`.',
    );
  }
  if (current.length < 16 && !dev) {
    throw new ConfigError(`DETECT_TOKEN is ${current.length} characters; use at least 16.`);
  }
  return previous && previous !== current ? [current, previous] : [current];
}

function intOr(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

function logLevelOf(raw: string): LogLevel {
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];
  if ((levels as string[]).includes(raw)) return raw as LogLevel;
  throw new ConfigError(`LOG_LEVEL must be one of ${levels.join(' | ')}, got ${JSON.stringify(raw)}`);
}

/** True for the loopback interfaces — the only ones that need no TLS terminator. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
