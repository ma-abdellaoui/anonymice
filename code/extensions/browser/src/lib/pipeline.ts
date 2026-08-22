/**
 * The detection pipeline of SPEC §2, as one function shared by the content
 * script and the eval harness. Whoever calls it supplies the `Detector`, so the
 * eval can run the backend in-process while the extension goes through the
 * service worker — the same code path scores and ships.
 */
import { annotationSpans } from './annotations.ts';
import { chunkHash } from './digest.ts';
import { toWireText } from './normalize.ts';
import { currentTextOf, projectSubtree, type ProjectOptions } from './project.ts';
import type { DetectChunkRequest, DetectHint, DetectResponse } from './protocol.ts';
import { SpanRegistry } from './registry.ts';
import { mergeSpans } from './spans.ts';
import type { Span } from './types.ts';

export interface Detector {
  detect(chunks: DetectChunkRequest[]): Promise<DetectResponse | null>;
}

export interface PipelineOptions extends ProjectOptions {
  locale?: string;
  registry?: SpanRegistry;
}

export interface PipelineResult {
  registry: SpanRegistry;
  chunks: number;
  /** Chunks whose text changed while the request was in flight (SPEC §3.2). */
  stale: number;
  /** True when detection failed and the page must report "not scanned" (SPEC §3.2). */
  unscanned: boolean;
}

export async function runPipeline(
  root: Element,
  detector: Detector,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const registry = opts.registry ?? new SpanRegistry();
  const country = opts.locale?.split('-')[1];
  const chunks = projectSubtree(root, opts);
  if (chunks.length === 0) return { registry, chunks: 0, stale: 0, unscanned: false };

  const annotations = new Map<string, Span[]>();
  const requests: DetectChunkRequest[] = [];
  for (const chunk of chunks) {
    const spans = annotationSpans(chunk);
    annotations.set(chunk.id, spans);
    requests.push({
      id: chunk.id,
      hash: await chunkHash(chunk.text),
      text: toWireText(chunk.text),
      ...(spans.length ? { hints: spans.map(toHint) } : {}),
    });
  }

  const response = await detector.detect(requests);
  let stale = 0;

  // A failed detection is "not scanned", and says so (SPEC §3.2). Annotations
  // are still applied: they are DOM facts, not guesses, and the layers are additive.
  const responses = response?.chunks ?? [];
  const detected = new Map(responses.map((c) => [c.id, c]));

  for (const chunk of chunks) {
    const fromBackend = detected.get(chunk.id);
    if (response && fromBackend) {
      // Staleness guard: re-read the DOM before painting, discard if the text moved.
      const current = currentTextOf(chunk, opts);
      if (current === null || (await chunkHash(toWireText(current))) !== fromBackend.hash) {
        stale++;
        continue;
      }
    }
    const spans = mergeSpans([
      ...(annotations.get(chunk.id) ?? []),
      ...(fromBackend?.spans ?? []),
    ]);
    for (const span of spans) await registry.add(chunk, span, country);
  }

  return { registry, chunks: chunks.length, stale, unscanned: response === null };
}

function toHint(span: Span): DetectHint {
  return { start: span.start, end: span.end, cls: span.cls, origin: 'annotation' };
}
