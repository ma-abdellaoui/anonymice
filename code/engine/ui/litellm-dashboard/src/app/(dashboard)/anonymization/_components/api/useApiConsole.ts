"use client";

import { useCallback, useMemo, useState } from "react";

import { ENDPOINTS, SAMPLE_TEXT, type ConsoleContext, type EndpointSpec } from "./catalogue";

import { apiClient, getProxyBaseUrl } from "@/components/networking";
import { ApiError } from "@/lib/http/client";

export interface CallResult {
  status: number;
  ms: number;
  body: unknown;
  failed: boolean;
}

export interface EndpointState {
  body: string;
  params: Record<string, string>;
  result: CallResult | null;
  running: boolean;
  edited: boolean;
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** What the next call should inherit from one that just answered. */
const learn = (context: ConsoleContext, endpoint: EndpointSpec, body: unknown): ConsoleContext => {
  if (endpoint.id !== "encode") return context;
  const answer = asRecord(body);
  const texts = Array.isArray(answer.texts) ? (answer.texts as string[]) : context.encodedTexts;
  const sessionId = typeof answer.session_id === "string" ? answer.session_id : context.sessionId;
  return { ...context, encodedTexts: texts, sessionId };
};

const fill = (path: string, params: Record<string, string>): string =>
  Object.entries(params).reduce(
    (filled, [name, value]) => filled.replace(`{${name}}`, encodeURIComponent(value) || `{${name}}`),
    path,
  );

const paramsFor = (endpoint: EndpointSpec, context: ConsoleContext): Record<string, string> =>
  Object.fromEntries((endpoint.params ?? []).map((param) => [param.name, context[param.from]]));

export interface ApiConsole {
  context: ConsoleContext;
  setSubjectId: (subjectId: string) => void;
  setSampleText: (text: string) => void;
  stateOf: (endpoint: EndpointSpec) => EndpointState;
  urlOf: (endpoint: EndpointSpec) => string;
  edit: (endpoint: EndpointSpec, body: string) => void;
  setParam: (endpoint: EndpointSpec, name: string, value: string) => void;
  reset: (endpoint: EndpointSpec) => void;
  send: (endpoint: EndpointSpec) => Promise<void>;
}

/**
 * One console over the whole /pii surface, where each answer feeds the next call.
 *
 * A card the user has not touched re-renders from what earlier calls returned,
 * so encode's session_id lands in decode and in both session routes without
 * anything being copied by hand. Once a card is edited it stops following,
 * because silently overwriting something somebody typed is worse than making
 * them press reset.
 */
export const useApiConsole = (accessToken: string | null): ApiConsole => {
  const [subjectId, setSubjectId] = useState("");
  const [sampleText, setSampleText] = useState(SAMPLE_TEXT);
  const [learned, setLearned] = useState<{ sessionId: string; encodedTexts: string[] }>({
    sessionId: "",
    encodedTexts: [],
  });
  const [states, setStates] = useState<Record<string, EndpointState>>({});

  const context = useMemo<ConsoleContext>(
    () => ({ ...learned, subjectId, sampleText }),
    [learned, subjectId, sampleText],
  );

  const stateOf = useCallback(
    (endpoint: EndpointSpec): EndpointState => {
      const held = states[endpoint.id];
      const body = endpoint.body === undefined ? "" : pretty(endpoint.body(context));
      return {
        body: held?.edited ? held.body : body,
        params: { ...paramsFor(endpoint, context), ...(held?.params ?? {}) },
        result: held?.result ?? null,
        running: held?.running ?? false,
        edited: held?.edited ?? false,
      };
    },
    [states, context],
  );

  const urlOf = useCallback(
    (endpoint: EndpointSpec): string => `${getProxyBaseUrl()}${fill(endpoint.path, stateOf(endpoint).params)}`,
    [stateOf],
  );

  const patch = useCallback((endpoint: EndpointSpec, change: Partial<EndpointState>) => {
    setStates((previous) => {
      const held = previous[endpoint.id] ?? { body: "", params: {}, result: null, running: false, edited: false };
      return { ...previous, [endpoint.id]: { ...held, ...change } };
    });
  }, []);

  const edit = useCallback(
    (endpoint: EndpointSpec, body: string) => patch(endpoint, { body, edited: true }),
    [patch],
  );

  const setParam = useCallback(
    (endpoint: EndpointSpec, name: string, value: string) =>
      setStates((previous) => {
        const held = previous[endpoint.id] ?? { body: "", params: {}, result: null, running: false, edited: false };
        return { ...previous, [endpoint.id]: { ...held, params: { ...held.params, [name]: value } } };
      }),
    [],
  );

  const reset = useCallback(
    (endpoint: EndpointSpec) => patch(endpoint, { body: "", edited: false, params: {} }),
    [patch],
  );

  const send = useCallback(
    async (endpoint: EndpointSpec): Promise<void> => {
      if (accessToken === null) return;
      const state = stateOf(endpoint);
      patch(endpoint, { running: true });
      const started = performance.now();
      try {
        const parsed = endpoint.body === undefined ? undefined : (JSON.parse(state.body) as Record<string, unknown>);
        const answer = await apiClient.requestWithHeaders<unknown>(
          endpoint.method,
          fill(endpoint.path, state.params),
          { accessToken, body: parsed },
        );
        patch(endpoint, {
          running: false,
          result: { status: answer.status, ms: performance.now() - started, body: answer.data, failed: false },
        });
        setLearned((held) => {
          const next = learn({ ...held, subjectId, sampleText }, endpoint, answer.data);
          return { sessionId: next.sessionId, encodedTexts: next.encodedTexts };
        });
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 0;
        const body = error instanceof ApiError ? error.body : String(error);
        patch(endpoint, { running: false, result: { status, ms: performance.now() - started, body, failed: true } });
      }
    },
    [accessToken, stateOf, patch, subjectId, sampleText],
  );

  return { context, setSubjectId, setSampleText, stateOf, urlOf, edit, setParam, reset, send };
};

export { ENDPOINTS };
