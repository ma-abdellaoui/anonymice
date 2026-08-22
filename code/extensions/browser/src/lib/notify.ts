/**
 * When to raise a notification, and what it says — SPEC §5 / issue #6.
 *
 * Pure, because the interesting part is not the Chrome API call but knowing when
 * *not* to fire. A scan runs on every mutation, so the naive version notifies on
 * every keystroke of a live-updating page and trains the user to dismiss us.
 */

export interface ScanSummary {
  /** Distinct values — one entry is one real value, however often it appears. */
  values: number;
  /** Painted occurrences. */
  occurrences: number;
  /** Detection failed; the badge says so and this is not a "found" event. */
  unscanned: boolean;
  byClass: Record<string, number>;
  /** Page URL, so a navigation is distinguishable from a re-scan. */
  url: string;
}

/** What was last announced for a tab. */
export interface Notified {
  url: string;
  values: number;
}

export interface NotificationPlan {
  title: string;
  message: string;
  /** Per-class breakdown, shown as the notification's context line. */
  contextMessage: string;
  /** Carried back so the caller can record what it announced. */
  notified: Notified;
}

/**
 * Announce a page once, and again only when it genuinely has more to say:
 * a different page, or more values than were announced last time. A count that
 * stays put or falls is a re-scan of what the user already knows about.
 */
export function planNotification(previous: Notified | null, next: ScanSummary): NotificationPlan | null {
  if (next.unscanned || next.values === 0) return null;
  if (previous && previous.url === next.url && next.values <= previous.values) return null;

  const host = hostOf(next.url);
  const found = previous && previous.url === next.url ? next.values - previous.values : next.values;
  const isUpdate = previous !== null && previous.url === next.url;

  return {
    title: isUpdate ? `${plural(found, 'more sensitive value')} on this page` : 'Sensitive data on this page',
    message: isUpdate
      ? `${plural(next.values, 'value')} now highlighted on ${host}.`
      : `${plural(next.values, 'sensitive value')} in ${plural(next.occurrences, 'place')} on ${host}.`,
    contextMessage: breakdown(next.byClass),
    notified: { url: next.url, values: next.values },
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "4 IBAN · 3 PERSON · 1 AHV", commonest first, so the line stays short. */
export function breakdown(byClass: Record<string, number>): string {
  return Object.entries(byClass)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`)
    .join(' · ');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'this page';
  }
}
