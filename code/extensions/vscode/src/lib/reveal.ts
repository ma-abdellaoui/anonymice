/**
 * Inline reveal — SPEC §7.1, §7.2.
 *
 * Pure: takes text plus vault resolutions and returns offset-based descriptors.
 * The `vscode` adapter turns offsets into Ranges. Keeping this side free of the
 * editor API is what lets the reveal rules be tested without a VS Code runtime.
 */
import { scanTokens } from './tokens.ts';
import type { RevealMode } from './types.ts';
import type { Resolution } from './vault.ts';

export interface RevealDescriptor {
  /** Offsets of the token in the source text. */
  start: number;
  end: number;
  token: string;
  /** Text to render as an inline attachment. Never written into the document. */
  contentText: string;
  /** `substitute` only: the token's own characters are hidden (SPEC §7.2). */
  hide: boolean;
  /** Rendered in a dimmed style — this is an explanation, not a value. */
  muted: boolean;
  /**
   * A value that cannot be rendered inline at all: it has newlines, so
   * `contentText` would silently drop them (SPEC §7.1). The caller offers the
   * webview instead of lying about the value.
   */
  webviewOnly: boolean;
}

const DATE = new Intl.DateTimeFormat('en-CH', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The §6.7 legibility table. A resolution failure must state class, age and
 * origin — never a bare "unknown".
 */
export function describeResolution(r: Resolution): { text: string; muted: boolean } {
  switch (r.kind) {
    case 'value':
      return r.expiringSoon
        ? { text: `${r.value}  (expires ${DATE.format(r.expiresAt)})`, muted: false }
        : { text: r.value, muted: false };
    case 'tombstone': {
      const t = r.tombstone;
      const when = DATE.format(t.endedAt);
      const from = t.sourceScope ? ` from ${t.sourceScope}` : '';
      return t.state === 'revoked'
        ? { text: `${t.cls} token${from} — revoked ${when}`, muted: true }
        : { text: `${t.cls} token${from} — expired ${when}`, muted: true };
    }
    case 'foreign':
      return { text: `a ${r.cls} token from another vault or profile`, muted: true };
    case 'damaged':
      return {
        text: r.cls
          ? `a damaged ${r.cls} token — it may have been truncated`
          : 'a damaged token — it may have been truncated',
        muted: true,
      };
    case 'none':
      return { text: '', muted: true };
  }
}

export interface RevealOptions {
  mode: RevealMode;
  /** Global hide, for screen sharing (SPEC §7.1). */
  hidden: boolean;
}

/**
 * `annotate` leaves the token in place and renders the value after it, so
 * columns, find and every LSP position stay exactly what the buffer says.
 * `substitute` hides the token and renders in its place — WYSIWYG, and the
 * caret then operates on geometry the user cannot see (SPEC §7.2).
 */
export function planReveal(
  source: string,
  resolve: (token: string) => Resolution,
  opts: RevealOptions,
): RevealDescriptor[] {
  if (opts.mode === 'off' || opts.hidden) return [];

  const out: RevealDescriptor[] = [];
  for (const m of scanTokens(source)) {
    const r = resolve(m.token);
    if (r.kind === 'none') continue;
    const { text, muted } = describeResolution(r);
    if (text === '') continue;

    const multiline = /[\r\n]/.test(text);
    // A hidden token with nothing rendered in its place would erase the line, so
    // substitute degrades to annotate for anything it cannot draw.
    const hide = opts.mode === 'substitute' && !multiline && !muted;

    out.push({
      start: m.start,
      end: m.end,
      token: m.token,
      contentText: multiline ? `${r.kind === 'value' ? r.cls : 'value'} — open to view` : text,
      hide,
      muted,
      webviewOnly: multiline,
    });
  }
  return out;
}
