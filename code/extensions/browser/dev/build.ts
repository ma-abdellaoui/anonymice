/**
 * Bundles the extension into dist/ (esbuild; Node strips the types for tests).
 *
 * `--qa` produces a build that is ready for a manual pass with no console step:
 * host access pre-granted, and a dev policy baked in so content scripts register
 * on a known host at first boot. Neither applies to a normal build — the shipped
 * bundle contains no dev hosts and no broad host permission.
 *
 *   node dev/build.ts --qa
 *   node dev/build.ts --qa --native=crm.example,*.clinic.example
 *   node dev/build.ts --qa --endpoint=http://localhost:9788/v1/detect
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const out = `${root}dist`;
const qa = process.argv.includes('--qa');

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const hosts = (raw: string): string[] => raw.split(',').map((h) => h.trim()).filter(Boolean);

/** Baked into the worker as a default under managed policy and storage.local. */
const devPolicy = qa
  ? {
      native: hosts(argValue('native', 'native.anonymice.test')),
      trusted: hosts(argValue('trusted', 'trusted.anonymice.test')),
      detectEndpoint: argValue('endpoint', 'http://localhost:8788/v1/detect'),
      detectToken: argValue('token', 'dev-token'),
      // Empty disables the pull, which is how you test the baked lists alone.
      policyEndpoint: argValue('policy-endpoint', 'http://localhost:8788/v1/policy'),
      policyRefreshMinutes: Number(argValue('policy-refresh', '1')),
      locale: argValue('locale', 'de-CH'),
      painter: argValue('painter', 'auto'),
      // QA needs TRUSTED to paint, because the class gate and the reveal path
      // are both only observable on a page that has something on it.
      scanTrusted: argValue('scan-trusted', 'readonly'),
      notifications: argValue('notifications', 'on'),
      // QA needs the gate on; the shipped default stays `off` (SPEC §11.6).
      egress: argValue('egress', 'enforce'),
    }
  : null;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    'service-worker': `${root}src/background/service-worker.ts`,
    content: `${root}src/content/main.ts`,
    // The reveal frame is its own document on the extension origin (SPEC §8.1),
    // so it is a separate entry rather than part of the content bundle.
    reveal: `${root}src/ui/reveal.ts`,
    // The egress shim runs in the page's own realm (SPEC §11.2), so it shares no
    // module instance with the content bundle and must be its own entry.
    egress: `${root}src/content/egress-main.ts`,
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome105',
  sourcemap: true,
  // Minify only the shipped build: it is what drops the `if (false)` branches a
  // QA-only define leaves behind, and the QA bundle stays readable in DevTools.
  minify: !qa,
  logLevel: 'info',
  define: {
    __DEV_POLICY__: devPolicy ? JSON.stringify(JSON.stringify(devPolicy)) : 'null',
  },
});

/**
 * The QA manifest grants host access up front so a local run does not have to
 * fight the optional-permission prompt. It changes what the extension *may*
 * read; it does not change where content scripts are registered, which stays
 * list-driven (SPEC §1) and is the property QA is there to check.
 */
const manifest = JSON.parse(readFileSync(`${root}platform/chrome/manifest.json`, 'utf8'));
if (qa) {
  manifest.host_permissions = ['*://*/*'];
  // Declaring the same pattern as optional too makes Chrome warn that the
  // optional entry is redundant, and it is: nothing is left to request once the
  // permission is required. The shipped manifest keeps it, because there it is
  // the only way the user can grant access at all.
  delete manifest.optional_host_permissions;
  manifest.name = 'anonymice (QA build)';
}
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
cpSync(`${root}platform/chrome/managed-schema.json`, `${out}/managed-schema.json`);
cpSync(`${root}platform/chrome/icons`, `${out}/icons`, { recursive: true });
cpSync(`${root}src/ui/reveal.html`, `${out}/reveal.html`);

if (devPolicy) {
  console.log(`built -> ${out} (QA build)`);
  console.log(`  host access : pre-granted (*://*/*)`);
  console.log(`  NATIVE      : ${devPolicy.native.join(', ') || '(none)'}`);
  console.log(`  TRUSTED     : ${devPolicy.trusted.join(', ') || '(none)'} (scan: ${devPolicy.scanTrusted})`);
  console.log(`  egress      : ${devPolicy.egress} (SPEC §10 — ships \`off\`; --egress=off|report|enforce)`);
  console.log(`  backend     : ${devPolicy.detectEndpoint}`);
  console.log(
    `  policy pull : ${devPolicy.policyEndpoint || '(off — baked lists only)'}` +
      (devPolicy.policyEndpoint ? ` every ${devPolicy.policyRefreshMinutes} min` : ''),
  );
  console.log(`  note        : a pulled list outranks the baked one above`);
  console.log(`  change hosts: rebuild with --native=host, or override chrome.storage.local at runtime`);
} else {
  console.log(`built -> ${out}`);
}
