/**
 * Dev harness entry: the same Scanner the extension runs, but talking to the
 * mock backend directly so a fixture page can be opened in a plain browser tab.
 * Not shipped — dist/ never includes this.
 */
import { Scanner } from '../src/content/scanner.ts';
import type { Detector } from '../src/lib/pipeline.ts';
import type { DetectResponse } from '../src/lib/protocol.ts';

const ENDPOINT = 'http://localhost:8788/v1/detect';

const detector: Detector = {
  async detect(chunks) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
        body: JSON.stringify({
          policyVersion: '2026-08-01',
          locale: 'de-CH',
          hostClass: 'native',
          chunks,
        }),
      });
      if (!res.ok) return null;
      return (await res.json()) as DetectResponse;
    } catch {
      return null;
    }
  },
};

const scanner = new Scanner({
  detector,
  locale: 'de-CH',
  onUpdate: (state) => {
    const el = document.querySelector('[data-anonymice="status"]');
    if (el) {
      el.textContent = state.unscanned
        ? 'not scanned — detection unavailable'
        : `${state.values} sensitive value(s), ${state.occurrences} highlighted`;
    }
  },
});

await scanner.scan();
scanner.observe();

// Exposed for the dev harness only, so a browser session can assert on state.
Object.assign(globalThis, {
  __anonymice: {
    backend: scanner.painterBackend,
    values: () => scanner.registry.entries().map((e) => ({ cls: e.cls, value: e.value, origin: e.origin, ranges: e.ranges.length })),
    dim: (on: boolean) => scanner.setDimmed(on),
  },
});
