/** A run of the pipeline, cut into pieces that can be shown changing. */
export type FlowSegment =
  | { kind: "plain"; text: string }
  | {
      kind: "entity";
      value: string;
      token: string;
      entityType: string;
      detector: string;
      score: number;
    };

export interface VaultEntry {
  token: string;
  value: string;
  entityType: string;
  detector: string;
}

export interface FlowTimings {
  encode: number;
  provider: number;
  decode: number;
}

export interface FlowRun {
  prompt: string;
  promptSegments: FlowSegment[];
  encodedPrompt: string;
  vault: VaultEntry[];
  providerReply: string;
  replySegments: FlowSegment[];
  decodedReply: string;
  sessionId: string;
  model: string;
  nerStageRan: boolean;
  timings: FlowTimings;
}

export const BEATS = ["typed", "detect", "encode", "cross", "reply", "decode"] as const;
export type Beat = (typeof BEATS)[number];

export const BEAT_LABELS: Record<Beat, string> = {
  typed: "You type",
  detect: "We detect",
  encode: "We encode",
  cross: "It crosses",
  reply: "They answer",
  decode: "We decode",
};

export const BEAT_CAPTIONS: Record<Beat, string> = {
  typed: "The prompt as it was written, still holding real values",
  detect: "Two stages find the sensitive spans: patterns and checksums first, the model only for what patterns cannot catch",
  encode: "Each value becomes a typed token. The value itself stays here, on this side of the boundary",
  cross: "Only the tokenized prompt leaves. The provider never receives a real value",
  reply: "The provider answers in the same tokens it was given, because the token reads as a noun it can reason about",
  decode: "The tokens resolve back out of the vault, and you get your own data returned to you",
};

/** Which side of the trust boundary a beat is happening on. */
export const BEAT_SIDE: Record<Beat, "inside" | "crossing" | "outside"> = {
  typed: "inside",
  detect: "inside",
  encode: "inside",
  cross: "crossing",
  reply: "outside",
  decode: "inside",
};
