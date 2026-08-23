import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  piiActivityCall,
  streamPiiActivity,
  type PiiActivityEvent,
  type PiiActivityFilters,
} from "@/components/networking";

const MAX_HELD = 500;

export interface ActivityFeed {
  events: PiiActivityEvent[];
  captureEnabled: boolean;
  loading: boolean;
  error: string | null;
  following: boolean;
  setFollowing: (following: boolean) => void;
  refresh: () => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const filterKey = (filters: PiiActivityFilters): string => `${filters.surface ?? ""}:${filters.direction ?? ""}`;

const matches = (event: PiiActivityEvent, filters: PiiActivityFilters): boolean => {
  const surfaceOk = !filters.surface || event.surface === filters.surface;
  const directionOk = !filters.direction || event.direction === filters.direction;
  return surfaceOk && directionOk;
};

interface Tail {
  key: string;
  events: PiiActivityEvent[];
}

/**
 * The recent log, with a live tail merged on top of it.
 *
 * The tail is held separately rather than folded into the fetched page, so a
 * page left open next to a demo keeps what it has already shown instead of
 * losing it to a refetch that lands after the ring has rotated.
 */
export const useActivityFeed = (accessToken: string | null, filters: PiiActivityFilters): ActivityFeed => {
  const key = filterKey(filters);
  const [tail, setTail] = useState<Tail>({ key, events: [] });
  const [following, setFollowing] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["pii-activity", filters.limit, filters.surface, filters.direction, accessToken],
    queryFn: () => piiActivityCall(accessToken as string, filters),
    enabled: accessToken !== null,
  });

  useEffect(() => {
    if (accessToken === null || !following) return;
    const controller = new AbortController();
    streamPiiActivity(
      accessToken,
      (event) => {
        if (!matches(event, filters)) return;
        setTail((current) => ({
          key,
          events: (current.key === key ? [event, ...current.events] : [event]).slice(0, MAX_HELD),
        }));
      },
      controller.signal,
    ).catch((cause) => {
      if (!controller.signal.aborted) setStreamError(message(cause));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is every part of `filters` that `matches` reads; depending on the object would reopen the stream on each render
  }, [accessToken, following, key]);

  const events = useMemo(() => {
    const fetched = query.data?.events ?? [];
    const live = tail.key === key ? tail.events : [];
    const known = new Set(fetched.map((event) => event.id));
    return [...live.filter((event) => !known.has(event.id)), ...fetched].slice(0, MAX_HELD);
  }, [query.data, tail, key]);

  const refresh = useCallback(() => {
    setTail({ key, events: [] });
    void query.refetch();
  }, [query, key]);

  return {
    events,
    captureEnabled: query.data?.capture_enabled ?? false,
    loading: query.isPending,
    error: query.error ? message(query.error) : streamError,
    following,
    setFollowing,
    refresh,
  };
};
