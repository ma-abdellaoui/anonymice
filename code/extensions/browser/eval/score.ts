/**
 * Scoring — SPEC §9. Precision and recall per class and per origin, strict and
 * lenient, so a regression says *which* layer moved.
 */
import type { Cls, Origin } from '../src/lib/types.ts';

export interface Scored {
  start: number;
  end: number;
  cls: Cls;
  origin?: Origin;
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Report {
  strict: Counts;
  /** Same class, any overlap — separates "found it, wrong extent" from "missed it". */
  lenient: Counts;
  perClass: Record<string, Counts>;
  perOrigin: Record<string, Counts>;
  missed: Scored[];
  spurious: Scored[];
}

const empty = (): Counts => ({ tp: 0, fp: 0, fn: 0 });

export function precision(c: Counts): number {
  return c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
}
export function recall(c: Counts): number {
  return c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
}
export function f1(c: Counts): number {
  const p = precision(c);
  const r = recall(c);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function score(expected: Scored[], predicted: Scored[]): Report {
  const report: Report = {
    strict: empty(),
    lenient: empty(),
    perClass: {},
    perOrigin: {},
    missed: [],
    spurious: [],
  };
  const bucket = (map: Record<string, Counts>, key: string): Counts =>
    (map[key] ??= empty());

  const takenStrict = new Set<number>();
  const takenLenient = new Set<number>();

  for (const want of expected) {
    const strictAt = predicted.findIndex(
      (p, i) => !takenStrict.has(i) && p.cls === want.cls && p.start === want.start && p.end === want.end,
    );
    const lenientAt = predicted.findIndex(
      (p, i) => !takenLenient.has(i) && p.cls === want.cls && p.start < want.end && want.start < p.end,
    );

    const cls = bucket(report.perClass, want.cls);
    if (strictAt >= 0) {
      takenStrict.add(strictAt);
      report.strict.tp++;
      cls.tp++;
      const origin = predicted[strictAt]?.origin ?? 'unknown';
      bucket(report.perOrigin, origin).tp++;
    } else {
      report.strict.fn++;
      cls.fn++;
      report.missed.push(want);
    }

    if (lenientAt >= 0) {
      takenLenient.add(lenientAt);
      report.lenient.tp++;
    } else {
      report.lenient.fn++;
    }
  }

  predicted.forEach((p, i) => {
    if (takenStrict.has(i)) return;
    report.strict.fp++;
    bucket(report.perClass, p.cls).fp++;
    bucket(report.perOrigin, p.origin ?? 'unknown').fp++;
    report.spurious.push(p);
  });
  predicted.forEach((_, i) => {
    if (!takenLenient.has(i)) report.lenient.fp++;
  });

  return report;
}

export function mergeReports(reports: Report[]): Report {
  const out: Report = {
    strict: empty(),
    lenient: empty(),
    perClass: {},
    perOrigin: {},
    missed: [],
    spurious: [],
  };
  for (const r of reports) {
    for (const k of ['tp', 'fp', 'fn'] as const) {
      out.strict[k] += r.strict[k];
      out.lenient[k] += r.lenient[k];
    }
    for (const [cls, c] of Object.entries(r.perClass)) {
      const target = (out.perClass[cls] ??= empty());
      for (const k of ['tp', 'fp', 'fn'] as const) target[k] += c[k];
    }
    for (const [origin, c] of Object.entries(r.perOrigin)) {
      const target = (out.perOrigin[origin] ??= empty());
      for (const k of ['tp', 'fp', 'fn'] as const) target[k] += c[k];
    }
    out.missed.push(...r.missed);
    out.spurious.push(...r.spurious);
  }
  return out;
}
