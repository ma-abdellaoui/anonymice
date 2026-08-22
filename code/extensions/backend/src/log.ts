/**
 * Structured logging, with one rule that outranks every other consideration:
 * **no page text is ever logged.** The whole reason this service is deployed
 * inside the vault's trust boundary (SPEC §3.1) is that chunk text is the
 * sensitive material; a debug line that echoes a chunk moves that material into
 * a log aggregator, which is usually outside the boundary and retained far
 * longer.
 *
 * So the fields are counts, versions, ids and durations. `hash` is safe (it is
 * already on the wire and is not reversible); `text`, `spans` and `normalized`
 * are not, and `assertNoPlaintext` fails a test rather than trusting reviewers
 * to keep noticing.
 */
import type { LogLevel } from './config.ts';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Field names that would carry plaintext or derived plaintext into a log sink. */
const FORBIDDEN = new Set(['text', 'chunks', 'spans', 'normalized', 'value', 'body', 'token', 'authorization']);

export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(base: Fields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injected so tests can read what was written without capturing stdout. */
  sink?: (line: string) => void;
  now?: () => number;
}

export function createLogger(opts: LoggerOptions = {}, base: Fields = {}): Logger {
  const level = opts.level ?? 'info';
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => Date.now());

  function emit(at: LogLevel, event: string, fields?: Fields): void {
    if (RANK[at] < RANK[level]) return;
    const record: Record<string, unknown> = {
      ts: new Date(now()).toISOString(),
      level: at,
      event,
      ...base,
      ...assertNoPlaintext(fields ?? {}),
    };
    sink(JSON.stringify(record));
  }

  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (extra) => createLogger(opts, { ...base, ...extra }),
  };
}

/**
 * Throws on a field name that could carry page text. A throw is the right
 * response: a log line is not worth shipping if the alternative is shipping the
 * data the service exists to contain.
 */
export function assertNoPlaintext(fields: Fields): Fields {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN.has(key)) throw new Error(`refusing to log field ${JSON.stringify(key)}: it may carry page text`);
  }
  return fields;
}
