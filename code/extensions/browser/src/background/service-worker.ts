/**
 * MV3 service worker — SPEC §1, §3.1.
 *
 * Three jobs: hold the trust lists (from the managed policy, refreshed from
 * `GET /v1/policy`), register content scripts from them so a host in no list is
 * never touched at all, and be the only thing that talks to the detection
 * backend.
 */
import type { PolicyLists } from '../lib/policy.ts';
import { DetectClient } from './detect-client.ts';
import { VaultClient, type MintSpec } from './vault-client.ts';
import { chromeStore, CACHE_KEY, PolicyClient, type PolicyResult } from './policy-client.ts';
import {
  classifyHost,
  DEFAULT_POLICY,
  matchPatternsFor,
  resolvePolicy,
  type Policy,
  type PolicySources,
} from '../lib/policy.ts';
import type { DetectChunkRequest, DetectResponse } from '../lib/protocol.ts';
import { createSerializer } from '../lib/serialize.ts';
import { alarm, banner, setDebug } from '../lib/debug.ts';
import { planNotification, type Notified } from '../lib/notify.ts';

const SCRIPT_ID = 'anonymice-content';
/** Separate id: the shim has a different world, a different runAt and a narrower host list (SPEC §10.2). */
const EGRESS_SCRIPT_ID = 'anonymice-egress';
const POLICY_ALARM = 'anonymice:policy-refresh';

/**
 * Baked in by `npm run build:qa` so a local run has a working policy without
 * anyone opening a console. `null` in every shipped build — esbuild replaces the
 * identifier at bundle time, so the shipping bundle contains no dev hosts at all.
 */
declare const __DEV_POLICY__: string | null;
const bakedPolicy: Partial<Policy> | null =
  typeof __DEV_POLICY__ === 'string' ? (JSON.parse(__DEV_POLICY__) as Partial<Policy>) : null;

let policy: Policy = DEFAULT_POLICY;
let client = new DetectClient({ policy });
let vault = new VaultClient({ policy });
/** Last pull outcome, and what registration did with it — read by QA (§4). */
let health: Diagnostics = {
  policyStatus: 'disabled',
  rejected: [],
  registered: [],
  registrationError: null,
  egress: null,
};

export interface Diagnostics {
  /** Set when the last boot threw. Read by QA (§4) and by `anonymice.state()`. */
  bootError?: string | null;
  policyStatus: PolicyResult['status'];
  rejected: string[];
  registered: string[];
  registrationError: string | null;
  /**
   * Null when the gate is `off`. Otherwise what it registered on, and why not
   * if it could not — an absent gate must be visible in diagnostics (SPEC §10.8).
   */
  egress: { mode: string; matches: string[]; error?: string } | null;
  policyVersion?: string;
  expiresAt?: number;
}

export interface DetectMessage {
  type: 'anonymice:detect';
  chunks: DetectChunkRequest[];
}

export interface MintMessage {
  type: 'anonymice:mint';
  specs: MintSpec[];
}

/**
 * The reveal frame's own traffic. It runs as an extension page, so it talks to
 * this worker directly rather than relaying through the content script — which
 * means the plaintext never enters the content script's world at all. The page's
 * own JavaScript could not reach it either way; keeping it out of the isolated
 * world too means one less place it can be read from by accident.
 */
export interface VaultMessage {
  type: 'anonymice:vault';
  op: 'resolve' | 'child' | 'update' | 'commit';
  token: string;
  scopeId?: string;
  value?: string;
  normalized?: string;
}

/** A copy was cancelled and nothing could replace it (SPEC §7 fails closed). */
export interface CopyFailedMessage {
  type: 'anonymice:copy-failed';
  reason: string;
}

export interface StateMessage {
  type: 'anonymice:state';
  values: number;
  occurrences: number;
  unscanned: boolean;
  byClass: Record<string, number>;
  url: string;
}

type Message =
  | DetectMessage
  | MintMessage
  | CopyFailedMessage
  | VaultMessage
  | StateMessage
  | { type: 'anonymice:policy' }
  | { type: 'anonymice:diagnostics' };

/**
 * The locally-configured policy: everything an administrator set on this
 * machine, with no network involved. It carries the enrollment the pull needs —
 * where to pull from, the credential, and the detect origin the pull is pinned
 * to — so it must resolve before the pull, not after it.
 */
async function loadLocal(): Promise<{ sources: PolicySources; policy: Policy }> {
  const managed = await chrome.storage.managed.get(null).catch(() => ({}));
  const local = await chrome.storage.local.get('policy').catch(() => ({}));
  const sources: PolicySources = {
    baked: bakedPolicy,
    local: (local as { policy?: Partial<Policy> }).policy,
    managed: managed as Partial<Policy>,
  };
  return { sources, policy: resolvePolicy(sources) };
}

async function loadPolicy(mode: 'cached' | 'refresh'): Promise<{ policy: Policy; result: PolicyResult }> {
  const { sources, policy: base } = await loadLocal();
  const pull = new PolicyClient({
    endpoint: base.policyEndpoint,
    token: base.detectToken,
    pin: base.detectEndpoint,
    store: chromeStore(),
  });
  // A worker that Chrome just woke reuses the held copy; only a real boot, the
  // refresh alarm, or an empty cache goes to the network.
  let result = mode === 'refresh' ? await pull.refresh() : await pull.cached();
  if (mode === 'cached' && result.policy === null && base.policyEndpoint) result = await pull.refresh();

  return { policy: resolvePolicy({ ...sources, remote: result.policy }), result };
}

/**
 * Registration *is* the gate: `matches` is built from the class lists rather
 * than <all_urls> plus an early return (SPEC §1).
 */
async function registerContentScripts(): Promise<void> {
  const matches = matchPatternsFor(policy);
  await chrome.scripting
    .unregisterContentScripts({ ids: [SCRIPT_ID, EGRESS_SCRIPT_ID] })
    .catch(() => {});
  health.registered = [];
  health.registrationError = null;
  if (matches.length === 0) return;
  const register = () =>
    chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        js: ['content.js'],
        matches,
        runAt: 'document_idle',
        allFrames: false,
      },
    ]);
  try {
    try {
      await register();
    } catch (err) {
      // Something holds the id between our unregister and this call. Boots are
      // serialised so it should not happen, but the recovery is cheap and the
      // failure mode — no content script at all — is not.
      if (!/duplicate script id/i.test(err instanceof Error ? err.message : String(err))) throw err;
      await chrome.scripting
        .unregisterContentScripts({ ids: [SCRIPT_ID, EGRESS_SCRIPT_ID] })
        .catch(() => {});
      await register();
    }
    health.registered = matches;
    banner('content scripts registered', {
      NATIVE: matchPatternsFor(policy, 'NATIVE'),
      TRUSTED: matchPatternsFor(policy, 'TRUSTED'),
      'policy source': policy.policyEndpoint
        ? `pulled from ${policy.policyEndpoint} — OUTRANKS the baked list`
        : 'baked/managed only (no pull)',
    });
  } catch (err) {
    // Almost always "cannot add script relating to a host it does not have
    // access to": the pull named a host nobody granted us. Registering nothing
    // is the correct outcome, but it must not be a silent one (ENDPOINTS.md §2.5).
    health.registrationError = err instanceof Error ? err.message : String(err);
    console.error('anonymice: content-script registration failed', err);
  }

  await registerEgressShim();
}

/**
 * The egress shim, registered **separately and last** — SPEC §10.2.
 *
 * Separate because `world: "MAIN"` needs Chrome 111 and the manifest floor is
 * 105. In one call an unsupported `world` rejects the whole array, so a Chrome
 * between 105 and 110 would end up with *no* content script at all and lose
 * detection, highlighting and reveal to a feature that ships `off`. Its own
 * call, its own catch: the gate is absent, everything else still runs.
 *
 * Last because the ordering of the failure matters more than the ordering of
 * the success. There is no page load between the two calls.
 *
 * TRUSTED hosts only: a gate that drops requests has no business on a NATIVE
 * host, where nothing is rewritten in the first place.
 */
/**
 * A pull that drops a host is indistinguishable, from the page, from the
 * extension being broken: no content script runs, so nothing can log. Say it
 * here, loudly, because this is the only place that knows it happened.
 */
function warnIfPullDroppedHosts(before: PolicyLists, after: PolicyLists): void {
  const lost = [
    ...before.native.filter((h) => !after.native.includes(h)),
    ...before.trusted.filter((h) => !after.trusted.includes(h)),
  ];
  if (lost.length === 0) return;
  alarm(
    `the policy pull REMOVED ${lost.length} host(s) that were baked in — ` +
      `no content script will run there: ${lost.join(', ')}`,
  );
}

async function registerEgressShim(): Promise<void> {
  health.egress = null;
  if (policy.egress === 'off') return;

  const matches = matchPatternsFor(policy, 'TRUSTED');
  if (matches.length === 0) return;

  try {
    // The refresh alarm re-boots on a timer, and registering an id that is
    // already held throws `Duplicate script ID` — which the catch below would
    // then report as "no egress gate on this browser", wrongly.
    await chrome.scripting.unregisterContentScripts({ ids: [EGRESS_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        id: EGRESS_SCRIPT_ID,
        js: ['egress.js'],
        matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
      },
    ]);
    health.egress = { mode: policy.egress, matches };
    banner('egress shim registered', { mode: policy.egress, matches, world: 'MAIN' });
  } catch (err) {
    // On Chrome < 111 this is "world is not supported". Either way the gate is
    // not running, and a gate that is silently absent is the one failure this
    // feature cannot afford (SPEC §10.4).
    const message = err instanceof Error ? err.message : String(err);
    health.egress = { mode: policy.egress, matches: [], error: message };
    console.error('anonymice: egress shim NOT registered — no egress gate on this browser', err);
  }
}

type BootMode = 'cached' | 'refresh';

/**
 * Boot runs from five places, several of which fire together on install. Two
 * concurrent boots both unregister and both register, and the loser throws
 * `Duplicate script ID`; a burst of storage events would otherwise queue one
 * re-registration per event. One at a time, newest intent wins.
 */
const boots = createSerializer<BootMode>(
  (mode) => boot(mode),
  (queued, incoming) => (queued === 'refresh' || incoming === 'refresh' ? 'refresh' : 'cached'),
);

function requestBoot(mode: BootMode = 'refresh'): Promise<void> {
  return boots.run(mode);
}

/**
 * Never rejects, deliberately.
 *
 * `ready` gates every message handler, and each one answers `null` if it
 * rejects. So a single unexpected throw anywhere in here — a malformed cached
 * policy, a `chrome.*` call that behaves differently on some build — used to
 * disable detection, minting and resolving *for the life of the worker*, with
 * nothing in the page to say why. One bad boot must cost the boot, not the
 * extension.
 */
async function boot(mode: BootMode = 'refresh'): Promise<void> {
  try {
    await bootOrThrow(mode);
    bootFailure = null;
  } catch (err) {
    bootFailure = err instanceof Error ? err.message : String(err);
    health = { ...health, bootError: bootFailure };
    console.error('anonymice: boot failed — the extension is running on whatever policy it had', err);
  }
}

/** Set when the last boot threw, so the next message can retry rather than
 *  reusing a promise that will never resolve to anything useful. */
let bootFailure: string | null = null;

async function bootOrThrow(mode: BootMode = 'refresh'): Promise<void> {
  const previous: PolicyLists = { native: policy.native, trusted: policy.trusted, activated: policy.activated };
  const { policy: resolved, result } = await loadPolicy(mode);
  policy = resolved;
  setDebug(policy.debug);
  warnIfPullDroppedHosts(previous, policy);
  client = new DetectClient({ policy });
  vault = new VaultClient({ policy });
  health = {
    ...health,
    policyStatus: result.status,
    rejected: result.rejected,
    policyVersion: policy.policyVersion,
    expiresAt: result.expiresAt,
  };
  if (result.rejected.length) console.warn('anonymice: policy values rejected', result.rejected);
  await registerContentScripts();
  await scheduleRefresh();
}

/** Chrome's alarm floor is one minute; below that it silently does not fire. */
async function scheduleRefresh(): Promise<void> {
  if (!policy.policyEndpoint) return void chrome.alarms?.clear(POLICY_ALARM);
  const periodInMinutes = Math.max(1, policy.policyRefreshMinutes || 60);
  chrome.alarms?.create(POLICY_ALARM, { periodInMinutes, delayInMinutes: periodInMinutes });
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === POLICY_ALARM) void requestBoot('refresh');
});

chrome.runtime.onInstalled.addListener(() => void requestBoot('refresh'));
chrome.runtime.onStartup?.addListener(() => void requestBoot('refresh'));
chrome.storage.onChanged.addListener((changes, area) => {
  // Our own cache write lands here too; re-booting on it would pull, write,
  // and pull again forever.
  const keys = Object.keys(changes);
  if (area === 'local' && keys.every((k) => k === CACHE_KEY)) return;
  void requestBoot('cached');
});

/**
 * A desktop notification the first time a page turns out to hold sensitive data,
 * and again only when it holds more than was announced. The badge is always-on
 * ambient state; this is the one-shot "you should know about this page".
 */
function notifyIfWorthIt(tabId: number, state: StateMessage): void {
  if (policy.notifications === 'off' || !chrome.notifications) return;
  const plan = planNotification(announced.get(tabId) ?? null, {
    values: state.values,
    occurrences: state.occurrences,
    unscanned: state.unscanned,
    byClass: state.byClass ?? {},
    url: state.url ?? '',
  });
  if (!plan) return;
  announced.set(tabId, plan.notified);
  chrome.notifications.create(`anonymice:${tabId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: plan.title,
    message: plan.message,
    contextMessage: plan.contextMessage,
    priority: 0,
  });
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (message.type === 'anonymice:detect') {
    // The class is derived from the sender's own URL, not from anything the page
    // said, so a page cannot talk its way into a different trust class.
    const senderHost = sender.tab?.url ? new URL(sender.tab.url).hostname : '';
    // The content script never fetches: the worker holds the credential.
    whenReady()
      .then(() =>
        client.detect(
          message.chunks,
          classifyHost(senderHost, policy).toLowerCase() as 'native' | 'trusted' | 'untrusted',
        ),
      )
      .then((response: DetectResponse | null) => sendResponse(response))
      .catch(() => sendResponse(null));
    return true; // async
  }

  if (message.type === 'anonymice:mint') {
    // Scoping is the content script's call — it knows the source origin — but the
    // credential and the endpoint are not the page's business, so the request is
    // made here (SPEC §6.3, ENDPOINTS.md §6).
    whenReady()
      .then(() => vault.mint(message.specs))
      .then((result) => sendResponse(result))
      .catch((err: unknown) =>
        sendResponse({ tokens: null, reason: err instanceof Error ? err.message : String(err) }),
      );
    return true; // async
  }

  if (message.type === 'anonymice:vault') {
    const m = message;
    const run = async (): Promise<unknown> => {
      await whenReady();
      switch (m.op) {
        case 'resolve':
          return vault.resolve(m.token, m.scopeId);
        case 'child':
          return vault.mintChild(m.token, m.value ?? '', m.normalized ?? '', m.scopeId ?? '');
        case 'update':
          return vault.updateDraft(m.token, m.value ?? '', m.normalized ?? '');
        case 'commit':
          return vault.commitDraft(m.token);
      }
    };
    run()
      .then((result) => sendResponse(result ?? null))
      .catch(() => sendResponse(null));
    return true; // async
  }

  if (message.type === 'anonymice:copy-failed') {
    // The clipboard is empty and safe. Without a word, that reads as the copy
    // simply not working, which is what teaches people to turn an extension off.
    chrome.notifications?.create(`anonymice:copy-failed:${sender.tab?.id ?? 0}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Nothing was copied',
      message: 'This selection holds sensitive data and could not be tokenised, so the clipboard was left empty rather than carrying it in the clear.',
      contextMessage: message.reason,
      priority: 2,
    });
    return false;
  }

  if (message.type === 'anonymice:state') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const { values, unscanned } = message;
      void whenReady().then(() => notifyIfWorthIt(tabId, message));
      // "Not scanned" must be visible; silence would read as "nothing here".
      chrome.action.setBadgeText({ tabId, text: unscanned ? '?' : values ? String(values) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: unscanned ? '#8a6d3b' : '#c0392b' });
      chrome.action.setTitle({
        tabId,
        title: unscanned
          ? 'anonymice: page not scanned — detection unavailable'
          : `anonymice: ${values} sensitive value(s) on this page`,
      });
    }
    return false;
  }

  if (message.type === 'anonymice:diagnostics') {
    void whenReady().then(() =>
      sendResponse({
        ...health,
        policyEndpoint: policy.policyEndpoint,
        detectEndpoint: policy.detectEndpoint,
        native: policy.native,
        trusted: policy.trusted,
      }),
    );
    return true; // async
  }

  if (message.type === 'anonymice:policy') {
    const host = sender.tab?.url ? new URL(sender.tab.url).hostname : '';
    void whenReady().then(() =>
      sendResponse({
        hostClass: classifyHost(host, policy),
        locale: policy.locale,
        painter: policy.painter,
        scanTrusted: policy.scanTrusted,
        egress: policy.egress,
        reveal: policy.reveal,
        debug: policy.debug,
      }),
    );
    return true; // async — answering before boot would classify everything UNTRUSTED
  }
  return false;
});

/**
 * The worker is killed when idle and revived by the very message it has to
 * answer. Top-level code runs, listeners attach, and boot starts — but boot is
 * async, so without this gate a handler can reply while `policy` is still the
 * empty default: every host classifies UNTRUSTED, the content script returns
 * early, and the page is silently never scanned.
 */
/**
 * What each tab has already been told. Without it a page that mutates would
 * notify on every re-scan, and the user would learn to dismiss us on sight.
 */
const announced = new Map<number, Notified>();
chrome.tabs?.onRemoved.addListener((tabId) => announced.delete(tabId));

let ready: Promise<void> = requestBoot('cached');

/**
 * Every handler awaits this rather than `ready` directly. A boot that failed is
 * retried on the next message the worker receives — which is the moment we know
 * someone is depending on it — instead of leaving the worker wedged until Chrome
 * happens to recycle it.
 */
function whenReady(): Promise<void> {
  if (bootFailure !== null) {
    bootFailure = null;
    ready = requestBoot('refresh');
  }
  return ready;
}

/**
 * QA builds only. `chrome.runtime.sendMessage` from the worker's own console
 * does not reach the worker's own listener, so the diagnostics message is
 * unusable from exactly the place you want it. This exposes the same state
 * directly: `await anonymice.state()` in the service worker console.
 */
// `typeof __DEV_POLICY__` is replaced at bundle time, so a shipped build drops
// this branch entirely rather than carrying it as dead code.
if (typeof __DEV_POLICY__ === 'string') {
  Object.assign(globalThis, {
    anonymice: {
      async state() {
        await whenReady();
        return {
          ...health,
          policy: {
            native: policy.native,
            trusted: policy.trusted,
            detectEndpoint: policy.detectEndpoint,
            policyEndpoint: policy.policyEndpoint,
            painter: policy.painter,
          },
          registeredNow: await chrome.scripting.getRegisteredContentScripts(),
        };
      },
      reboot: () => requestBoot('refresh'),
    },
  });
}
