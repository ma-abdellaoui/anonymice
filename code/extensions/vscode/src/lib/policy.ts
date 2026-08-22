/**
 * Resource classification — SPEC §3.
 *
 * Anything unmatched is UNTRUSTED. That default is the whole safety property:
 * a file nobody classified is one we do not scan, do not send anywhere, and do
 * not reveal into.
 */
import type { ResourceClass } from './types.ts';

export interface ResourceRule {
  glob: string;
  class: ResourceClass;
}

/**
 * Minimal glob → RegExp. Supports `**`, `*` and `?` against POSIX-ish
 * workspace-relative paths. Deliberately not a dependency: the matching surface
 * is small and a silent behaviour change in a glob library would silently
 * reclassify files.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` consumes any number of leading segments, including none.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

/**
 * First matching rule wins, so an explicit narrow rule can sit above a broad
 * one. Unmatched is UNTRUSTED (SPEC §3).
 */
export function classify(relPath: string, rules: readonly ResourceRule[]): ResourceClass {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const r of rules) {
    if (globToRegExp(r.glob).test(p)) return r.class;
  }
  return 'UNTRUSTED';
}

/** Whether detection may run and content may leave the machine (SPEC §5.1). */
export function mayScan(cls: ResourceClass, workspaceTrusted: boolean): boolean {
  return workspaceTrusted && cls !== 'UNTRUSTED';
}

/** Whether tokens may be resolved into a process environment (SPEC §9). */
export function mayResolveToProcess(cls: ResourceClass, workspaceTrusted: boolean): boolean {
  return workspaceTrusted && cls === 'TRUSTED';
}

/**
 * Reveal reads the vault and renders to a decoration; it executes nothing the
 * workspace supplied, so it survives Restricted Mode (SPEC §5.3). On UNTRUSTED
 * it is opt-in per file rather than on by default (SPEC §3).
 */
export function mayReveal(cls: ResourceClass, optedIn: boolean): boolean {
  return cls === 'UNTRUSTED' ? optedIn : true;
}
