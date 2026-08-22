/**
 * Content-script entry. Registered only on hosts the policy lists (SPEC §1), so
 * reaching this file already means the page is in scope.
 */
import { Scanner } from './scanner.ts';
import { attachClipboardGuard, createRemoteMinter, type MintRequest } from './clipboard.ts';
import { createRevealer } from './reveal.ts';
import { attachEgressBridge } from './egress-bridge.ts';
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

async function main(): Promise<void> {
  const info = (await chrome.runtime.sendMessage({ type: 'anonymice:policy' })) as {
    hostClass: string;
    locale: string;
    painter: 'auto' | 'overlay';
    scanTrusted: 'off' | 'readonly' | 'full';
    egress: 'off' | 'report' | 'enforce';
  } | null;
  if (!info) return;
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
  const bridge = gating
    ? attachEgressBridge(window, {
        registry: scanner.registry,
        minter: createRemoteMinter(`source:${location.origin}`, (specs: MintRequest[]) =>
          chrome.runtime.sendMessage({ type: 'anonymice:mint', specs }) as Promise<string[] | null>,
        ),
        mode: info.egress === 'enforce' ? 'enforce' : 'report',
        ...(country ? { country } : {}),
        onHealth: (patched) =>
          console.info(`anonymice: egress gate up (${info.egress}) — patched ${patched.join(', ')}`),
        onBlocked: ({ url, transport, missing }) =>
          console.warn(
            `anonymice: ${transport} to ${url} held — ${missing.length} untokenised value(s): ` +
              missing.map((m) => m.cls).join(', '),
          ),
        onSent: ({ url, transport, replaced }) =>
          console.info(`anonymice: ${transport} to ${url} — ${replaced} value(s) tokenised at egress`),
      })
    : null;

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
        chrome.runtime.sendMessage({ type: 'anonymice:mint', specs }) as Promise<string[] | null>,
    ),
    ...(country ? { country } : {}),
    onCopy: (plan) => {
      const what = plan.replacements
        .map((r) => `${r.cls}${r.whole ? '' : ' (partial)'} -> ${r.token}`)
        .join(', ');
      console.info(`anonymice: ${plan.replacements.length} value(s) tokenised on copy — ${what}`);
    },
  });

  await scanner.scan();
  // The scan is what fills the registry, and the registry is pass 1's whole
  // input — so the gate learns about this page's values here, not before.
  bridge?.refresh();
  scanner.observe();
}

void main();
