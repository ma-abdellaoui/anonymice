/**
 * Content-script entry. Registered only on hosts the policy lists (SPEC §1), so
 * reaching this file already means the page is in scope.
 */
import { Scanner } from './scanner.ts';
import { attachClipboardGuard, createRemoteMinter, type MintReply, type MintRequest } from './clipboard.ts';
import { createRevealer } from './reveal.ts';
import { attachEgressBridge, type ResolveOutcome } from './egress-bridge.ts';
import { attachDomReveal, tokensInDom } from './dom-reveal.ts';
import { alarm, banner, note, setDebug } from '../lib/debug.ts';

/**
 * Stamped by `dev/build.ts`. `unbuilt` means this is running from source under
 * the test runner, where there is no build to identify.
 */
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unbuilt';
import type { Detector } from '../lib/pipeline.ts';
import type { DetectResponse } from '../lib/protocol.ts';

/** Every request goes through the worker — the page never sees a credential. */
const detector: Detector = {
  async detect(chunks) {
    const response = (await chrome.runtime.sendMessage({
      type: 'anonymice:detect',
      chunks,
    })) as DetectResponse | null;
    return response ?? null;
  },
};

interface BeaconRequest {
  direction: 'encode' | 'decode';
  action: string;
  entityTypes: string[];
  tokenCount: number;
  blockedEntityType?: string;
}

/**
 * Tell the worker what the gate decided, so it lands in the engine's activity
 * log next to what the proxy did. Nothing about the body travels, and a worker
 * that is asleep or a log that is off simply means nothing is recorded.
 */
function reportBeacon(beacon: BeaconRequest): void {
  void chrome.runtime.sendMessage({ type: 'anonymice:beacon', ...beacon }).catch(() => {});
}

async function main(): Promise<void> {
  const info = (await chrome.runtime.sendMessage({ type: 'anonymice:policy' })) as {
    hostClass: string;
    locale: string;
    painter: 'auto' | 'overlay';
    scanTrusted: 'off' | 'readonly' | 'full';
    egress: 'off' | 'report' | 'enforce';
    reveal: 'off' | 'dom';
    debug?: boolean;
  } | null;
  if (!info) {
    alarm('the service worker did not answer — no policy, nothing runs');
    return;
  }
  setDebug(info.debug === true);
  const country = info.locale?.split('-')[1];

  /**
   * TRUSTED is the class we are willing to *show real values to* (SPEC §1). The
   * page's own fields hold tokens; the reveal frame is what turns one back into
   * something the user can read, and it is the only surface the page cannot read
   * in turn (SPEC §8.1).
   */
  if (info.hostClass === 'TRUSTED') {
    createRevealer(document, {
      // The destination stage of §6.3: a token pasted here gets this origin's
      // own alias, so two destinations holding the same value cannot correlate.
      scopeId: `destination:${location.origin}`,
      ...(country ? { country } : {}),
      frameUrl: chrome.runtime.getURL('reveal.html'),
    });
  }

  /**
   * Highlighting follows the rollout flag, not the host class alone. `readonly`
   * runs exactly the NATIVE algorithm over read-only regions and skips every
   * editable, so it ships no new painting machinery (SPEC §1).
   */
  const scanning =
    info.hostClass === 'NATIVE' || (info.hostClass === 'TRUSTED' && info.scanTrusted !== 'off');
  const gating = info.hostClass === 'TRUSTED' && info.egress !== 'off';

  /**
   * The first thing to read when nothing happened on a real destination. Every
   * gate below is a conjunction, and this says which conjunct failed — which is
   * the difference between "decided not to act" and "never loaded" (SPEC §10.8).
   */
  banner('content script running', {
    build: BUILD_ID,
    origin: location.origin,
    hostClass: info.hostClass,
    'policy.egress': info.egress,
    'policy.reveal': info.reveal,
    'policy.scanTrusted': info.scanTrusted,
    'egress gate active': gating ? 'YES' : `NO — needs TRUSTED + egress≠off`,
    'DOM reveal active': gating && info.reveal === 'dom' ? 'YES' : 'NO — needs the gate + reveal=dom',
    'will scan page': scanning ? 'YES' : 'NO',
  });

  if (info.hostClass !== 'TRUSTED') {
    note('this host is not TRUSTED, so neither the gate nor DOM reveal can run here');
  }
  // The gate does not need a scan. Its second pass is checksum-anchored, which
  // is the whole point: it catches a value typed straight into the page, which
  // by definition no scan has ever seen (SPEC §10.1).
  if (!scanning && !gating) return;

  const scanner = new Scanner({
    detector,
    locale: info.locale,
    painterBackend: info.painter ?? 'auto',
    onUpdate: (state) => {
      void chrome.runtime.sendMessage({
        type: 'anonymice:state',
        ...state,
        url: location.href,
      });
    },
  });

  /**
   * The gate is attached before the first scan for the same reason the copy
   * guard is: an empty registry blocks nothing that pass 2 would not have
   * caught anyway, and attaching late leaves a window where the app's first
   * request goes out unexamined (SPEC §10.5).
   */
  /**
   * Ingress resolution (SPEC §10.9.3). Batched only by `Promise.all` — the vault
   * endpoint takes one token per call, and a page load asks about a handful.
   *
   * The two failure arms are kept apart, because the caller memoises one of them
   * and must not memoise the other. A present `resolution` means the vault
   * spoke: `value`, or one of §6.7's final answers — dead, foreign, damaged,
   * none — every one of which is permanent and worth remembering. An absent one
   * means nobody spoke at all: the worker was down, the vault was unreachable,
   * the reply was malformed. That is a transient condition, and remembering it
   * is what makes a token stay showing until the page is reloaded.
   */
  const resolveTokens = async (tokens: string[]): Promise<ResolveOutcome> => {
    const scopeId = `destination:${location.origin}`;
    const values: Record<string, string> = {};
    const unreachable: string[] = [];
    const answered: string[] = [];

    await Promise.all(
      tokens.map(async (token) => {
        let reply: { resolution?: { kind: string; value?: string } } | null = null;
        try {
          reply = (await chrome.runtime.sendMessage({
            type: 'anonymice:vault',
            op: 'resolve',
            token,
            scopeId,
          })) as { resolution?: { kind: string; value?: string } } | null;
        } catch (err) {
          // The worker was not there to answer — mid-teardown, or not yet up.
          note(`could not ask the vault about ${token}`, err);
          unreachable.push(token);
          return;
        }
        const resolution = reply?.resolution;
        if (!resolution) {
          note(`no answer for ${token} — worker or vault down; will ask again`);
          unreachable.push(token);
          return;
        }
        answered.push(token);
        // Every non-`value` arm — dead, revoked, wrong vault (§6.7) — leaves the
        // token showing, which is the honest thing to render for each of them.
        if (resolution.kind === 'value') values[token] = resolution.value ?? '';
        else note(`vault could not resolve ${token}`, resolution);
      }),
    );

    banner('vault resolve', {
      asked: tokens.length,
      resolved: Object.keys(values).length,
      'answered, but not with a value': answered.filter((t) => !(t in values)),
      'no answer at all — will retry': unreachable,
    });
    return { values, unreachable };
  };

  let domReveal: { rerun: () => void; detach: () => void } | null = null;
  /** token → value for the DOM pass. The bridge is the source; this mirrors it. */
  const revealed = new Map<string, string>();

  /**
   * Minting is the cheapest possible cache fill: the pair is already in hand and
   * the vault is being told, not asked. Without this a paste of something copied
   * moments ago on the same page still costs a resolve, and a `paste` cannot
   * await one — which is precisely the round trip that made a pasted token sit
   * there as a token until the user clicked away (SPEC §10.9.3).
   */
  const rememberMinted = (token: string, value: string): void => {
    revealed.set(token, value);
  };

  const bridge = gating
    ? attachEgressBridge(window, {
        registry: scanner.registry,
        minter: createRemoteMinter(
          `source:${location.origin}`,
          (specs: MintRequest[]) =>
            chrome.runtime.sendMessage({ type: 'anonymice:mint', specs }) as Promise<MintReply | null>,
          rememberMinted,
        ),
        mode: info.egress === 'enforce' ? 'enforce' : 'report',
        reveal: info.reveal,
        resolve: resolveTokens,
        // New values mean text that was showing a token can now show one.
        onValues: (values) => {
          for (const [token, value] of Object.entries(values)) revealed.set(token, value);
          const changed = domReveal?.rerun() ?? 0;
          note(`values landed (${Object.keys(values).length} held) — DOM nodes rewritten: ${changed}`);
        },
        ...(country ? { country } : {}),
        onHealth: (patched) =>
          banner('egress shim up', {
            mode: info.egress,
            reveal: info.reveal,
            'transports patched': patched,
            missing: ['fetch', 'xhr', 'websocket', 'beacon', 'form'].filter(
              (t) => !patched.includes(t),
            ),
          }),
        onBlocked: ({ url, transport, missing }) => {
          banner('REQUEST HELD', {
            transport,
            url,
            classes: missing.map((m) => m.cls),
            why: 'no token in hand yet — minting; the app\'s own retry should go out tokenised',
          });
          reportBeacon({
            direction: 'encode',
            action: 'egress-block',
            entityTypes: missing.map((m) => m.cls),
            tokenCount: 0,
            blockedEntityType: missing[0]?.cls,
          });
        },
        onSent: ({ url, transport, replaced }) => {
          note(`${transport} → ${url} — ${replaced} value(s) tokenised at egress`);
          if (replaced > 0) {
            reportBeacon({ direction: 'encode', action: 'egress-substitute', entityTypes: [], tokenCount: replaced });
          }
        },
      })
    : null;

  /**
   * The document's own tokens — server-rendered HTML, an embedded state blob —
   * are in the tree before any network hook can matter (SPEC §10.9.4).
   */
  if (gating && info.reveal === 'dom') {
    domReveal = attachDomReveal(document, {
      valueFor: (token) => revealed.get(token),
      onPasteRevealed: (tokens) =>
        note(`paste taken — ${tokens} token(s) revealed before the editor saw them`),
      onUnresolved: (tokens) => void bridge?.warm(tokens),
    });
    // The first pass finds tokens but resolves nothing; this is what turns them
    // into values, and `onValues` re-runs the pass once they land.
    const present = tokensInDom(document);
    banner('DOM reveal armed', {
      'tokens found in page': present.length ? present : '(none — nothing to reveal)',
      note: present.length ? 'resolving against the vault…' : 'check the token is in the DOM at load',
    });
    void bridge?.warm(present);
  }

  if (!scanning) return;

  // Copy is guarded before the first scan finishes: an empty registry intercepts
  // nothing, so attaching early costs nothing and closes the window where a page
  // has painted but a copy would still go out in the clear.
  attachClipboardGuard(document, {
    registry: scanner.registry,
    minter: createRemoteMinter(
      // The source stage of §6.3. The vault decides what a session is; the page
      // only says where the value was read.
      `source:${location.origin}`,
      (specs: MintRequest[]) =>
        chrome.runtime.sendMessage({ type: 'anonymice:mint', specs }) as Promise<MintReply | null>,
      rememberMinted,
    ),
    ...(country ? { country } : {}),
    onCopy: (plan) => {
      const what = plan.replacements
        .map((r) => `${r.cls}${r.whole ? '' : ' (partial)'} -> ${r.token}`)
        .join(', ');
      console.info(`anonymice: ${plan.replacements.length} value(s) tokenised on copy — ${what}`);
    },
    // An empty clipboard is the safe outcome and an invisible one. Say so out
    // loud, in a surface the user is actually looking at when they hit Ctrl+C.
    onFailure: (reason) => {
      void chrome.runtime.sendMessage({ type: 'anonymice:copy-failed', reason });
    },
  });

  await scanner.scan();
  // The scan is what fills the registry, and the registry is pass 1's whole
  // input — so the gate learns about this page's values here, not before.
  bridge?.refresh();
  scanner.observe();
}

void main();
