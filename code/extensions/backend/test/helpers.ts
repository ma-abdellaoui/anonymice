/** Test rig: a real server on an ephemeral port, over a temporary policy file. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { DetectEngine } from '../src/detect/engine.ts';
import type { ModelPass } from '../src/detect/model.ts';
import { createLogger, type Fields } from '../src/log.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { createBackend } from '../src/server.ts';

export const TOKEN = 'test-token-0123456789';

export interface Rig {
  base: string;
  policyFile: string;
  writePolicy(policy: unknown): void;
  lines: string[];
  engine: DetectEngine;
  close(): Promise<void>;
}

export interface RigOptions {
  policy?: unknown;
  model?: ModelPass;
  env?: Record<string, string>;
}

export async function startRig(opts: RigOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'anonymice-backend-'));
  const policyFile = join(dir, 'policy.json');
  const writePolicy = (policy: unknown): void => writeFileSync(policyFile, JSON.stringify(policy, null, 2));
  writePolicy(
    opts.policy ?? {
      policyVersion: '2026-08-22',
      locale: 'de-CH',
      native: ['native.anonymice.test'],
      trusted: ['trusted.anonymice.test'],
      maxAgeSeconds: 300,
    },
  );

  const config: Config = loadConfig({
    env: { DETECT_TOKEN: TOKEN, PORT: '0', POLICY_FILE: policyFile, LOG_LEVEL: 'debug', ...opts.env },
    argv: [],
  });

  const lines: string[] = [];
  const logger = createLogger({ level: config.logLevel, sink: (line) => lines.push(line) });
  const store = new PolicyStore({ file: config.policyFile, logger });
  store.load();
  const engine = new DetectEngine(opts.model ? { model: opts.model } : {});
  const backend = createBackend({ config, engine, store, logger });
  const { port } = await backend.listen();

  return { base: `http://127.0.0.1:${port}`, policyFile, writePolicy, lines, engine, close: () => backend.close() };
}

export function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** A minimal well-formed detect body. */
export function detectBody(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyVersion: '2026-08-22',
    locale: 'de-CH',
    hostClass: 'native',
    chunks: [{ id: 'c1', hash: 'sha256:unverified', text }],
    ...over,
  };
}

export function logged(lines: string[], event: string): Array<Record<string, unknown> & Fields> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === event) as Array<Record<string, unknown> & Fields>;
}
