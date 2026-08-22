/**
 * Eval harness — SPEC §9. The gate lands before the code it gates.
 *
 * Every page is scored twice, annotated and stripped: stripping may lower
 * precision but must not lower recall below the gate, and no annotation may
 * remove a span the other layers found (SPEC §3.4).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectChunk, MODEL_VERSION } from '../mock/rules.ts';
import { runPipeline, type Detector } from '../src/lib/pipeline.ts';
import type { DetectChunkRequest, DetectResponse } from '../src/lib/protocol.ts';
import type { Cls } from '../src/lib/types.ts';
import { loadFixture, stripAnnotations } from './dom.ts';
import { flatten, locate, rangeToFlat, type Flat } from './flatten.ts';
import { f1, mergeReports, precision, recall, score, type Report, type Scored } from './score.ts';

const CORPUS = new URL('./corpus/', import.meta.url).pathname;
const GATE = JSON.parse(readFileSync(new URL('./gate.json', import.meta.url), 'utf8')) as Gate;

interface Gate {
  strict: { precision: number; recall: number };
  lenient: { precision: number; recall: number };
  perClass: Record<string, { recall: number }>;
  stripped: { strict: { recall: number } };
}

interface Truth {
  locale?: string;
  spans: Array<{ cls: Cls; value: string; nth?: number }>;
}

/** In-process backend: deterministic, so a repeat run must score identically. */
function inProcessDetector(locale: string): Detector {
  return {
    async detect(chunks: DetectChunkRequest[]): Promise<DetectResponse> {
      return {
        modelVersion: MODEL_VERSION,
        policyVersion: 'eval',
        chunks: chunks.map((c) => ({ id: c.id, hash: c.hash, spans: detectChunk(c.text, locale) })),
      };
    },
  };
}

async function scorePage(path: string, truth: Truth, strip: boolean): Promise<{ report: Report; predicted: Scored[] }> {
  const { document } = loadFixture(path);
  if (strip) stripAnnotations(document);

  const locale = truth.locale ?? 'de-CH';
  const { registry } = await runPipeline(document.body, inProcessDetector(locale), { locale });

  const flat = flatten(document);
  const predicted: Scored[] = [];
  for (const entry of registry.entries()) {
    for (const range of entry.ranges) {
      const at = rangeToFlat(flat, range);
      if (at) predicted.push({ ...at, cls: entry.cls, origin: entry.origin });
    }
  }
  predicted.sort((a, b) => a.start - b.start);

  const expected = resolveTruth(flat, truth, path);
  return { report: score(expected, predicted), predicted };
}

function resolveTruth(flat: Flat, truth: Truth, path: string): Scored[] {
  const out: Scored[] = [];
  for (const want of truth.spans) {
    const at = locate(flat, want.value, want.nth ?? 1);
    if (!at) {
      throw new Error(`${basename(path)}: ground truth "${want.value}" not found in page text`);
    }
    out.push({ ...at, cls: want.cls });
  }
  return out;
}

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + '%';
}

function line(label: string, c: { tp: number; fp: number; fn: number }): string {
  return `${label.padEnd(22)} P ${pct(precision(c))}  R ${pct(recall(c))}  F1 ${pct(f1(c))}  (tp ${c.tp}, fp ${c.fp}, fn ${c.fn})`;
}

async function main(): Promise<void> {
  const pages = readdirSync(CORPUS).filter((f) => f.endsWith('.spans.json')).sort();

  // An empty corpus scores 1.0 on every metric by definition. Passing on that
  // would be the harness lying: no corpus is a failure, not a clean run.
  if (pages.length === 0) {
    console.error(
      'no corpus: eval/corpus/ holds no <name>.html + <name>.spans.json pairs.\n' +
      'The gate cannot pass without pages to score — add fixtures before trusting a green run.',
    );
    process.exitCode = 1;
    return;
  }
  const annotated: Report[] = [];
  const stripped: Report[] = [];
  const failures: string[] = [];

  console.log('anonymice detection eval — SPEC §9\n');

  for (const file of pages) {
    const truth = JSON.parse(readFileSync(join(CORPUS, file), 'utf8')) as Truth;
    const html = join(CORPUS, file.replace('.spans.json', '.html'));

    const withAnn = await scorePage(html, truth, false);
    const without = await scorePage(html, truth, true);
    annotated.push(withAnn.report);
    stripped.push(without.report);

    console.log(line(basename(html, '.html'), withAnn.report.strict));
    for (const miss of withAnn.report.missed) console.log(`    missed    ${miss.cls} @${miss.start}-${miss.end}`);
    for (const spur of withAnn.report.spurious) console.log(`    spurious  ${spur.cls} @${spur.start}-${spur.end} (${spur.origin})`);

    // No annotation may remove a span the other layers found (SPEC §3.4).
    for (const bare of without.predicted) {
      const covered = withAnn.predicted.some((p) => p.start < bare.end && bare.start < p.end);
      if (!covered) {
        failures.push(`${basename(html)}: annotation removed a span at ${bare.start}-${bare.end} (${bare.cls})`);
      }
    }

    // Determinism: the same page scored twice must be identical (SPEC §3.2).
    const repeat = await scorePage(html, truth, false);
    if (JSON.stringify(repeat.predicted) !== JSON.stringify(withAnn.predicted)) {
      failures.push(`${basename(html)}: detection is not deterministic across runs`);
    }
  }

  const all = mergeReports(annotated);
  const bare = mergeReports(stripped);

  console.log('\n' + line('TOTAL strict', all.strict));
  console.log(line('TOTAL lenient', all.lenient));
  console.log(line('TOTAL stripped', bare.strict));

  console.log('\nper class');
  for (const [cls, c] of Object.entries(all.perClass).sort()) console.log('  ' + line(cls, c));
  console.log('\nper origin');
  for (const [origin, c] of Object.entries(all.perOrigin).sort()) console.log('  ' + line(origin, c));

  const check = (what: string, actual: number, min: number) => {
    if (actual + 1e-9 < min) failures.push(`${what}: ${pct(actual).trim()} < gate ${pct(min).trim()}`);
  };
  check('strict precision', precision(all.strict), GATE.strict.precision);
  check('strict recall', recall(all.strict), GATE.strict.recall);
  check('lenient precision', precision(all.lenient), GATE.lenient.precision);
  check('lenient recall', recall(all.lenient), GATE.lenient.recall);
  check('stripped recall', recall(bare.strict), GATE.stripped.strict.recall);
  for (const [cls, want] of Object.entries(GATE.perClass)) {
    const c = all.perClass[cls];
    if (c) check(`${cls} recall`, recall(c), want.recall);
  }

  writeFileSync(
    new URL('./report.json', import.meta.url),
    JSON.stringify({ annotated: all, stripped: bare, gate: GATE, failures }, null, 2),
  );

  if (failures.length) {
    console.log('\nGATE FAILED');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nGATE PASSED');
  }
}

await main();
