/** Shared vocabulary. SPEC §3.3, §5, §6. */

/**
 * Detection classes. `UNKNOWN` is a bare `data-sensitive` with no value (SPEC §3.4).
 * `SECRET` is credential material — passwords, API keys, private keys. Tier A only:
 * no reserved range exists to format-preserve against (SPEC §6.5).
 *
 * This list is part of the token format and is duplicated in the VS Code
 * extension. Change both together.
 */
export const CLASSES = [
  'PERSON', 'IBAN', 'CARD', 'AHV', 'PHONE', 'EMAIL', 'ADDR', 'ORG', 'SECRET', 'UNKNOWN',
] as const;
export type Cls = (typeof CLASSES)[number];

export function isCls(v: string): v is Cls {
  return (CLASSES as readonly string[]).includes(v);
}

/** Which layer produced a span. Also the merge precedence order (SPEC §3.3). */
export type Origin = 'annotation' | 'rule' | 'model';

const PRECEDENCE: Record<Origin, number> = { annotation: 3, rule: 2, model: 1 };
export function precedenceOf(o: Origin): number {
  return PRECEDENCE[o];
}

/** A span in chunk coordinates: UTF-16 code units over NFC text (SPEC §3.2). */
export interface Span {
  start: number;
  end: number;
  cls: Cls;
  origin: Origin;
  /** Canonical form; its digest is the spanId (SPEC §5.1). Filled by the detector. */
  normalized?: string;
}

/** Host trust class (SPEC §1). */
export type HostClass = 'NATIVE' | 'TRUSTED' | 'UNTRUSTED';
