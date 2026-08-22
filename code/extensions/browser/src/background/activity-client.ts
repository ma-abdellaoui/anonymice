/**
 * Reports what this extension did to the engine's activity log.
 *
 * The two halves of the product answer the same question at different moments,
 * and a reviewer can only see that if both show up in one place. What crosses
 * is the shape of the work: which classes, how many, on what kind of host. The
 * `Beacon` type has no field for page text, so this cannot become a transcript
 * of what someone was reading even by mistake, which is the same rule `log.ts`
 * enforces for the detection backend.
 *
 * Off unless an administrator configures an endpoint, and fire-and-forget in
 * every case: a copy must not fail because a log was unreachable.
 */
import type { Policy } from '../lib/policy.ts';

export type BeaconDirection = 'encode' | 'decode';

export interface Beacon {
  direction: BeaconDirection;
  /** What the person did: `mint`, `reveal`, or `egress-block`. */
  action: string;
  host: string;
  trustClass: string;
  /** Detection classes only, never the values behind them. */
  entityTypes: string[];
  tokenCount: number;
  resolvedCount?: number;
  blockedEntityType?: string;
  failedReason?: string;
}

export interface ActivityClientOptions {
  policy: Policy;
  fetchImpl?: typeof fetch;
}

export class ActivityClient {
  readonly #policy: Policy;
  readonly #fetch: typeof fetch | undefined;

  constructor(opts: ActivityClientOptions) {
    this.#policy = opts.policy;
    this.#fetch = opts.fetchImpl;
  }

  get enabled(): boolean {
    return this.#policy.activityEndpoint !== '' && this.#policy.activityToken !== '';
  }

  report(beacon: Beacon): void {
    if (!this.enabled) return;
    const doFetch = this.#fetch ?? fetch;
    void doFetch(this.#policy.activityEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#policy.activityToken}`,
      },
      body: JSON.stringify({
        direction: beacon.direction,
        action: beacon.action,
        host: beacon.host,
        trust_class: beacon.trustClass,
        entity_types: beacon.entityTypes,
        token_count: beacon.tokenCount,
        resolved_count: beacon.resolvedCount ?? 0,
        ...(beacon.blockedEntityType ? { blocked_entity_type: beacon.blockedEntityType } : {}),
        ...(beacon.failedReason ? { failed_reason: beacon.failedReason } : {}),
      }),
    }).catch(() => {
      // Deliberately silent. The person copying is not the audience for a log outage,
      // and diagnostics already reports whether the endpoint is configured.
    });
  }
}
