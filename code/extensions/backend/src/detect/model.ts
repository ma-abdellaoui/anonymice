/**
 * The model pass — SPEC §3.3's probabilistic layer, behind an interface.
 *
 * What ships here is a **gazetteer**, not an LLM: given names plus a capitalised
 * surname, and a short ORG suffix list. It is deterministic, needs no credential
 * and no network, and it is the pass the eval scores.
 *
 * The seam is the point. An LLM implementation of `ModelPass` drops in without
 * touching the engine, the cache, the routes or the wire format — but it has to
 * meet three constraints that the interface alone will not enforce:
 *
 *  1. **Determinism (SPEC §3.2).** Same text and same versions ⇒ same spans,
 *     byte for byte, because `spanId` digests and both caches depend on it.
 *     Temperature zero is not determinism; a per-`(hash, version)` memo is. The
 *     engine's cache provides that within a process, so an LLM pass needs a
 *     durable one behind it to hold the property across restarts and replicas.
 *  2. **No confidence on the wire.** The pass decides its own bar and returns
 *     only spans it stands behind. A score reaching the client would relocate
 *     the same decision into the extension and give two authorities two answers.
 *  3. **Offsets in UTF-16 code units** over the text as received. A model that
 *     reports character positions, token positions or byte offsets has to be
 *     converted here — the client will not do it (SPEC §3.2).
 *
 * A pass that cannot answer must **throw**. Returning no spans is a lie the
 * product cannot tell: it reads as "nothing sensitive here" (ENDPOINTS.md §3).
 */
import { normalizeValue } from '../lib/normalize.ts';
import type { DetectSpan } from '../lib/protocol.ts';

export interface ModelPass {
  /** Part of `modelVersion` on the wire; bumping it invalidates every cache. */
  readonly version: string;
  detect(text: string, locale: string): Promise<DetectSpan[]>;
}

const GIVEN_NAMES = [
  'Anna', 'Andrea', 'Beat', 'Claudia', 'Daniel', 'Elena', 'Felix', 'Hans', 'Julia', 'Luca',
  'Marco', 'Maria', 'Martin', 'Nadia', 'Nicole', 'Peter', 'Sarah', 'Stefan', 'Thomas', 'Ursula',
];
const ORG_SUFFIXES = ['AG', 'GmbH', 'SA', 'Sàrl', 'Ltd', 'Holding'];

const NAME_RE = new RegExp(
  `\\b(${GIVEN_NAMES.join('|')})\\s+([A-Z\\u00C0-\\u00DE][\\p{L}'\\u2019-]+)\\b`,
  'gu',
);
const ORG_RE = new RegExp(
  `\\b([A-Z][\\p{L}&.-]*(?:\\s+[A-Z][\\p{L}&.-]*){0,3})\\s+(${ORG_SUFFIXES.join('|')})\\b`,
  'gu',
);

export class GazetteerModelPass implements ModelPass {
  readonly version = 'gazetteer-1';

  async detect(text: string): Promise<DetectSpan[]> {
    const spans: DetectSpan[] = [];
    for (const [re, cls] of [[NAME_RE, 'PERSON'], [ORG_RE, 'ORG']] as const) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue;
        spans.push({
          start: m.index,
          end: m.index + m[0].length,
          cls,
          normalized: normalizeValue(cls, m[0]),
          origin: 'model',
        });
      }
    }
    return spans;
  }
}

/** A pass that always fails, for exercising the failure path (see `engine.ts`). */
export class UnavailableModelPass implements ModelPass {
  readonly version = 'unavailable';

  async detect(): Promise<DetectSpan[]> {
    throw new Error('model pass unavailable');
  }
}
