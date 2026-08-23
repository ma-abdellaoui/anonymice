import type { FlowSegment, VaultEntry } from "./flowTypes";

import type { PiiPlacement } from "@/components/networking";

interface Located {
  start: number;
  end: number;
  token: string;
  entityType: string;
  detector: string;
  score: number;
}

/**
 * Drop any span that starts before the previous one ended.
 *
 * The engine resolves overlaps before it encodes, so this should never fire on
 * its output. It exists because splicing an overlapping pair would render text
 * that was never sent, and showing the wrong thing is worse than showing less.
 */
const withoutOverlaps = (located: Located[]): Located[] =>
  [...located]
    .sort((a, b) => a.start - b.start)
    .reduce<Located[]>((kept, span) => {
      const previous = kept.at(-1);
      return previous && span.start < previous.end ? kept : [...kept, span];
    }, []);

/** Cut `source` into plain runs and the located entities between them. */
const cut = (source: string, located: Located[], valueFor: (span: Located) => string): FlowSegment[] => {
  const ordered = withoutOverlaps(located);
  const pieces = ordered.flatMap<FlowSegment>((span, index) => {
    const lead = source.slice(index === 0 ? 0 : ordered[index - 1].end, span.start);
    const entity: FlowSegment = {
      kind: "entity",
      value: valueFor(span),
      token: span.token,
      entityType: span.entityType,
      detector: span.detector,
      score: span.score,
    };
    return lead ? [{ kind: "plain", text: lead }, entity] : [entity];
  });
  const tail = source.slice(ordered.at(-1)?.end ?? 0);
  return tail ? [...pieces, { kind: "plain", text: tail }] : pieces;
};

const inFirstText = (placements: PiiPlacement[]): Located[] =>
  placements
    .filter((placement) => placement.text_index === 0)
    .map((placement) => ({
      start: placement.start,
      end: placement.end,
      token: placement.token,
      entityType: placement.entity_type,
      detector: placement.detector,
      score: placement.score,
    }));

/** The prompt cut into plain runs and the entities that were tokenized. */
export const segmentPrompt = (prompt: string, placements: PiiPlacement[]): FlowSegment[] =>
  cut(prompt, inFirstText(placements), (span) => prompt.slice(span.start, span.end));

/** The distinct token-to-value pairs a run minted, in the order they were first used. */
export const vaultFrom = (prompt: string, placements: PiiPlacement[]): VaultEntry[] => {
  const seen = new Map<string, VaultEntry>();
  for (const span of inFirstText(placements)) {
    if (seen.has(span.token)) continue;
    const entry: VaultEntry = {
      token: span.token,
      value: prompt.slice(span.start, span.end),
      entityType: span.entityType,
      detector: span.detector,
    };
    seen.set(span.token, entry);
  }
  return [...seen.values()];
};

/**
 * The reply cut around the tokens it actually contains.
 *
 * Matched literally against tokens we minted rather than by re-parsing the
 * grammar, so a token the model distorted stays plain text here. That is the
 * same outcome decode gives it, and inventing a match would put the wrong
 * person's name on screen.
 */
export const segmentReply = (reply: string, vault: VaultEntry[]): FlowSegment[] => {
  const values = new Map(vault.map((entry) => [entry.token, entry.value]));
  const located = vault.flatMap<Located>((entry) => {
    const found: Located[] = [];
    for (let at = reply.indexOf(entry.token); at !== -1; at = reply.indexOf(entry.token, at + entry.token.length)) {
      const occurrence: Located = {
        start: at,
        end: at + entry.token.length,
        token: entry.token,
        entityType: entry.entityType,
        detector: entry.detector,
        score: 1,
      };
      found.push(occurrence);
    }
    return found;
  });
  return cut(reply, located, (span) => values.get(span.token) ?? span.token);
};
