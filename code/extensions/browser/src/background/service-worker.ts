/**
 * MV3 service worker — SPEC §1, §3.1.
 *
 * Three jobs: hold the trust lists (from the managed policy, refreshed from
 * `GET /v1/policy`), register content scripts from them so a host in no list is
 * never touched at all, and be the only thing that talks to the detection
 * backend.
 */
import { DetectClient } from './detect-client.ts';
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
import { planNotification, type Notified } from '../lib/notify.ts';

const SCRIPT_ID = 'anonymice-content';
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
/** Last pull outcome, and what registration did with it — read by QA (§4). */
let health: Diagnostics = { policyStatus: 'disabled', rejected: [], registered: [], registrationError: null };

export interface Diagnostics {
  policyStatus: PolicyResult['status'];
  rejected: string[];
  registered: string[];
  registrationError: string | null;
  policyVersion?: string;
  expiresAt?: number;
}

export interface DetectMessage {
  type: 'anonymice:detect';
  chunks: DetectChunkRequest[];
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
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
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
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
      await register();
    }
    health.registered = matches;
  } catch (err) {
    // Almost always "cannot add script relating to a host it does not have
    // access to": the pull named a host nobody granted us. Registering nothing
    // is the correct outcome, but it must not be a silent one (ENDPOINTS.md §2.5).
    health.registrationError = err instanceof Error ? err.message : String(err);
    console.error('anonymice: content-script registration failed', err);
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

async function boot(mode: BootMode = 'refresh'): Promise<void> {
  const { policy: resolved, result } = await loadPolicy(mode);
  policy = resolved;
  client = new DetectClient({ policy });
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
    ready
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

  if (message.type === 'anonymice:state') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const { values, unscanned } = message;
      void ready.then(() => notifyIfWorthIt(tabId, message));
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
    void ready.then(() =>
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
    void ready.then(() =>
      sendResponse({
        hostClass: classifyHost(host, policy),
        locale: policy.locale,
        painter: policy.painter,
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

const ready: Promise<void> = requestBoot('cached');

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
        await ready;
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
