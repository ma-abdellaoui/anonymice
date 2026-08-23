import type { HttpMethod } from "@/lib/http/client";

/** What a previous call produced, so the next one can be filled in from it. */
export interface ConsoleContext {
  sessionId: string;
  subjectId: string;
  encodedTexts: string[];
  sampleText: string;
}

export interface PathParam {
  name: string;
  /** Which piece of the context prefills it. */
  from: "sessionId" | "subjectId";
}

export interface EndpointSpec {
  id: string;
  method: HttpMethod;
  /** Path template, with `{name}` for anything in `params`. */
  path: string;
  summary: string;
  /** Why you would reach for it, in one sentence. */
  when: string;
  params?: PathParam[];
  body?: (context: ConsoleContext) => Record<string, unknown>;
  /** Whether the call destroys something and so needs confirming. */
  destructive?: boolean;
  /** The key permission this route requires, when it takes one of its own. */
  grant?: "allow_pii_decode" | "allow_pii_search";
}

export const SAMPLE_TEXT = "Ada Lovelace emailed ada@example.com about IBAN CH93 0076 2011 6238 5295 7.";

export const ENDPOINTS: readonly EndpointSpec[] = [
  {
    id: "permissions",
    method: "GET",
    path: "/pii/permissions",
    summary: "What this key is allowed to do",
    when: "Start here. Decode and search are separate grants, so this tells you which of the calls below will answer and which will refuse.",
  },
  {
    id: "detect",
    method: "POST",
    path: "/pii/detect",
    summary: "Find the PII without changing anything",
    when: "Use it to see what the two detection stages find, and which stage found each span, before you commit to encoding.",
    body: (context) => ({ texts: [context.sampleText], language: "en" }),
  },
  {
    id: "encode",
    method: "POST",
    path: "/pii/encode",
    summary: "Swap values for tokens and remember the mapping",
    when: "The call everything else hangs off. It returns a session_id, and the tokens stay resolvable until the session or the subject is revoked.",
    body: (context) => ({
      texts: [context.sampleText],
      language: "en",
      scope_type: "key",
      ...(context.subjectId === "" ? {} : { subject_id: context.subjectId }),
    }),
  },
  {
    id: "decode",
    method: "POST",
    path: "/pii/decode",
    summary: "Put the real values back",
    when: "Run encode first: this is prefilled with what it returned. It hands back the values, so it needs the decode grant.",
    grant: "allow_pii_decode",
    body: (context) => ({ texts: context.encodedTexts, session_id: context.sessionId }),
  },
  {
    id: "session-get",
    method: "GET",
    path: "/pii/session/{session_id}",
    summary: "List the tokens one encode minted",
    when: "Metadata only: which tokens exist, of which entity type, and when they expire. The values are not in the answer.",
    params: [{ name: "session_id", from: "sessionId" }],
  },
  {
    id: "search",
    method: "POST",
    path: "/pii/search",
    summary: "Find the token for a value you already know",
    when: "The support case: someone gives you a name or an IBAN and you need the token it became. Its own grant, separate from decode, because it reaches across sessions.",
    grant: "allow_pii_search",
    body: () => ({ query: "ada@example.com", mode: "normalized", scope_type: "key" }),
  },
  {
    id: "subject-get",
    method: "GET",
    path: "/pii/subject/{subject_id}",
    summary: "Export everything held about one person",
    when: "A subject access request. Encode with a subject_id first, otherwise there is nothing filed under one.",
    grant: "allow_pii_decode",
    params: [{ name: "subject_id", from: "subjectId" }],
  },
  {
    id: "session-delete",
    method: "DELETE",
    path: "/pii/session/{session_id}",
    summary: "Revoke one session's tokens",
    when: "After this, decode on those tokens returns them unchanged, because the mapping is gone rather than hidden.",
    destructive: true,
    params: [{ name: "session_id", from: "sessionId" }],
  },
  {
    id: "subject-delete",
    method: "DELETE",
    path: "/pii/subject/{subject_id}",
    summary: "Erase everything held about one person",
    when: "The right to erasure, across every session that person's data appeared in.",
    destructive: true,
    params: [{ name: "subject_id", from: "subjectId" }],
  },
  {
    id: "activity",
    method: "GET",
    path: "/pii/activity",
    summary: "What the PII layer did, recently",
    when: "The same feed the PII Activity page reads. Add ?request_id= to narrow it to one completion, or read /pii/activity/stream for a live tail.",
  },
];
