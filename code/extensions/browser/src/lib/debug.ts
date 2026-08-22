/**
 * Loud diagnostics — SPEC §10.8's stand-in until the pill exists.
 *
 * A destination's own console is not a quiet place. Confluence logs hundreds of
 * lines before we run, so a `console.info` from us is invisible in practice —
 * which meant the first real-world test could not tell "the gate decided not to
 * act" from "the gate never loaded". Both look like nothing happening.
 *
 * So every decision this extension makes on a gated page gets a banner with
 * blank lines around it. Ugly on purpose: it is a debugging surface, off unless
 * the policy asks for it.
 */

const BANNER = '='.repeat(72);
const PAD = '\n\n\n';

let enabled = false;

export function setDebug(on: boolean): void {
  enabled = on;
}

export function isDebug(): boolean {
  return enabled;
}

/**
 * A headline nobody can miss. `rows` are printed as aligned `key : value`, which
 * is what makes a wrong answer obvious next to a right one.
 */
export function banner(title: string, rows: Record<string, unknown> = {}): void {
  if (!enabled) return;
  const keys = Object.keys(rows);
  const width = keys.reduce((max, key) => Math.max(max, key.length), 0);
  const lines = keys.map((key) => `  ${key.padEnd(width)} : ${format(rows[key])}`);

  // One call, not many: interleaved logging from the page would otherwise split
  // the block apart and undo the whole point of it.
  console.log(
    `${PAD}${BANNER}\n  ANONYMICE — ${title}\n${BANNER}\n${lines.join('\n')}\n${BANNER}${PAD}`,
  );
}

/** A single line, still prefixed so it can be filtered on in DevTools. */
export function note(message: string, detail?: unknown): void {
  if (!enabled) return;
  if (detail === undefined) console.log(`ANONYMICE · ${message}`);
  else console.log(`ANONYMICE · ${message}`, detail);
}

/**
 * Always printed, debug or not. A gate that failed to install is the one thing
 * a user must not have to opt in to hear about.
 */
export function alarm(message: string, detail?: unknown): void {
  console.error(
    `${PAD}${BANNER}\n  ANONYMICE — ${message}\n${BANNER}${PAD}`,
    detail ?? '',
  );
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (value === null || value === undefined) return '(unset)';
  return JSON.stringify(value);
}
