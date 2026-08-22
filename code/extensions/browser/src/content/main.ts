/**
 * Content-script entry. Registered only on hosts the policy lists (SPEC §1), so
 * reaching this file already means the page is in scope.
 */
import { Scanner } from './scanner.ts';
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
  } | null;
  // Scanning is NATIVE-only for now; TRUSTED is behind policy.scanTrusted (SPEC §1).
  if (!info || info.hostClass !== 'NATIVE') return;

  const scanner = new Scanner({
    detector,
    locale: info.locale,
    painterBackend: info.painter ?? 'auto',
    onUpdate: (state) => {
      void chrome.runtime.sendMessage({ type: 'anonymice:state', ...state });
    },
  });

  await scanner.scan();
  scanner.observe();
}

void main();
