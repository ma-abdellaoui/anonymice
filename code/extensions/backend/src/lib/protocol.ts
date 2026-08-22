/** The /v1/detect wire contract — SPEC §3.2. Shared by client and mock backend. */
import type { Cls, Origin } from './types.ts';

export interface DetectHint {
  start: number;
  end: number;
  cls: Cls;
  origin: 'annotation';
}

export interface DetectChunkRequest {
  id: string;
  hash: string;
  /** NFC-normalised. Offsets are UTF-16 code units into this string. */
  text: string;
  hints?: DetectHint[];
}

export interface DetectRequest {
  policyVersion: string;
  locale: string;
  hostClass: 'native' | 'trusted' | 'untrusted';
  chunks: DetectChunkRequest[];
}

export interface DetectSpan {
  start: number;
  end: number;
  cls: Cls;
  normalized: string;
  origin: Origin;
  /** Advisory subject grouping. Never consulted when minting or resolving (SPEC §5.1). */
  subjectHint?: string;
}

export interface DetectChunkResponse {
  id: string;
  hash: string;
  spans: DetectSpan[];
}

export interface DetectResponse {
  modelVersion: string;
  policyVersion: string;
  chunks: DetectChunkResponse[];
}

/** Caps that make the client re-split on 413 (SPEC §3.2). */
export const LIMITS = {
  maxChunkChars: 4000,
  maxChunks: 64,
  maxTotalChars: 64_000,
} as const;

export function cacheKey(hash: string, modelVersion: string, policyVersion: string): string {
  return `${hash}|${modelVersion}|${policyVersion}`;
}
