/**
 * Runs one async task at a time, collapsing everything that arrives while it is
 * busy into a single follow-up run.
 *
 * The service worker boots from five places — module load, onInstalled,
 * onStartup, a storage change and the refresh alarm — and several of them fire
 * together. Two concurrent boots both unregister the content script and then
 * both register it, and the loser gets `Duplicate script ID`. Serialising is the
 * fix; collapsing keeps a burst of storage events from queueing five identical
 * re-registrations behind it.
 */
export interface Serializer<M> {
  /** Resolves when the run that covers this request has finished. */
  run(mode: M): Promise<void>;
  readonly busy: boolean;
}

export function createSerializer<M>(
  task: (mode: M) => Promise<void>,
  /** Combines a queued request with a newer one — e.g. refresh outranks cached. */
  merge: (queued: M, incoming: M) => M,
): Serializer<M> {
  let inFlight: Promise<void> | null = null;
  let queued: { mode: M } | null = null;

  const start = (mode: M): Promise<void> => {
    const running = (async () => {
      try {
        await task(mode);
      } finally {
        inFlight = null;
        const next = queued;
        queued = null;
        if (next) void start(next.mode);
      }
    })();
    inFlight = running;
    return running;
  };

  return {
    run(mode: M): Promise<void> {
      if (!inFlight) return start(mode);
      queued = { mode: queued ? merge(queued.mode, mode) : mode };
      return inFlight;
    },
    get busy(): boolean {
      return inFlight !== null;
    },
  };
}
