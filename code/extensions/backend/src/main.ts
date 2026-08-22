/**
 * Entry point: resolve configuration, refuse to start on anything that would
 * make the service unsafe or silently wrong, then listen.
 *
 * Startup is where the loud failures belong. A missing credential, an
 * unreadable policy file or a bad env var stops the process with a message
 * naming the fix — all three are cheap to fix at deploy time and expensive to
 * discover later from an extension that has quietly stopped protecting hosts.
 */
import { ConfigError, isLoopback, loadConfig } from './config.ts';
import { DetectEngine } from './detect/engine.ts';
import { createLogger } from './log.ts';
import { PolicyStore } from './policy/store.ts';
import { createBackend } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const store = new PolicyStore({ file: config.policyFile, logger });
  store.load(); // fatal if the file is missing or does not parse

  const engine = new DetectEngine({ cacheMaxEntries: config.cacheMaxEntries });
  const backend = createBackend({ config, engine, store, logger });

  backend.server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('listen.address_in_use', { port: config.port });
      process.stderr.write(
        `port ${config.port} is already in use — the mock backend or another instance is ` +
          `probably still running. Free it, or pick another: PORT=9788 npm start\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  const { host, port } = await backend.listen();
  logger.info('listening', {
    host,
    port,
    modelVersion: engine.modelVersion,
    policyFile: config.policyFile,
    tokens: config.tokens.length,
    dev: config.dev,
  });

  if (!isLoopback(host)) {
    // Raw page text crosses this socket. Off loopback it needs TLS and a
    // network path that stays inside the trust boundary (SPEC §3.1) — neither
    // of which this process can check, so it says so and leaves it to the
    // deployment.
    logger.warn('bind.not_loopback', {
      host,
      note: 'raw page text crosses this socket; terminate TLS in front of it and keep it inside the vault trust boundary',
    });
  }
  if (config.dev) logger.warn('dev.credential', { note: 'serving the well-known `dev-token` on loopback only' });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('shutdown', { signal });
      void backend.close().then(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
