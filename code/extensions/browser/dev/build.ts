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
import { build, type BuildOptions } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const out = `${root}dist`;
const qa = process.argv.includes('--qa');

/**
 * Stamped into the bundle and printed at the end of every build.
 *
 * The extension logs it in its first banner, so a page console answers "is this
 * the build I just made?" without guessing. Reloading the unpacked extension is
 * a manual step and forgetting it costs a debugging session — this session lost
 * one to a `dist/` that was two changes behind what the console claimed.
 */
const buildId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const passed = (name: string): boolean => process.argv.some((a) => a.startsWith(`--${name}=`));

/**
 * Naming hosts on the command line turns the policy pull off.
 *
 * The pull outranks the baked list by design (ENDPOINTS.md §2), and the mock
 * serves the two fixture hosts — so a build with `--trusted=*.atlassian.net`
 * would register on Confluence, then silently *unregister* within a minute when
 * the first pull replaced the list. That cost a real debugging session: the page
 * console showed nothing at all, which looks identical to the extension being
 * broken. If you named the hosts, you meant them.
 */
const hostsNamed = passed('trusted') || passed('native');

const hosts = (raw: string): string[] => raw.split(',').map((h) => h.trim()).filter(Boolean);

/** Baked into the worker as a default under managed policy and storage.local. */
const devPolicy = qa
  ? {
      native: hosts(argValue('native', 'native.anonymice.test')),
      trusted: hosts(argValue('trusted', 'trusted.anonymice.test')),
      detectEndpoint: argValue('endpoint', 'http://localhost:8788/v1/detect'),
      detectToken: argValue('token', 'dev-token'),
      // Empty disables the pull, which is how you test the baked lists alone.
      policyEndpoint: argValue('policy-endpoint', hostsNamed ? '' : 'http://localhost:8788/v1/policy'),
      policyRefreshMinutes: Number(argValue('policy-refresh', '1')),
      locale: argValue('locale', 'de-CH'),
      painter: argValue('painter', 'auto'),
      // QA needs TRUSTED to paint, because the class gate and the reveal path
      // are both only observable on a page that has something on it.
      scanTrusted: argValue('scan-trusted', 'readonly'),
      notifications: argValue('notifications', 'on'),
      // QA needs the gate on; the shipped default stays `off` (SPEC §11.6).
      egress: argValue('egress', 'enforce'),
      // Off by default even in QA: it changes what is in the DOM, so it has to
      // be asked for explicitly (SPEC §10.11).
      reveal: argValue('reveal', 'off'),
      // A QA build exists to be watched, so the banners are on unless asked off.
      debug: argValue('debug', 'on') !== 'off',
      // Off unless asked for, even in QA: reporting to another service is a
      // decision, not a default. Point it at a running engine to see the browser
      // half and the proxy half in one log.
      activityEndpoint: argValue('activity-endpoint', ''),
      activityToken: argValue('activity-token', ''),
    }
  : null;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/**
 * Everything both builds share. They differ only in `format`, and that one
 * difference is load-bearing — see the split below.
 */
const common: BuildOptions = {
  outdir: out,
  bundle: true,
  target: 'chrome105',
  sourcemap: true,
  // Minify only the shipped build: it is what drops the `if (false)` branches a
  // QA-only define leaves behind, and the QA bundle stays readable in DevTools.
  minify: !qa,
  logLevel: 'info',
  define: {
    __DEV_POLICY__: devPolicy ? JSON.stringify(JSON.stringify(devPolicy)) : 'null',
    __BUILD_ID__: JSON.stringify(buildId),
  },
};

/**
 * The two module contexts. The worker declares `"type": "module"` in the
 * manifest, and `reveal.html` loads its script with `type="module"` — so both
 * may carry the `export {}` an ESM bundle ends with.
 */
await build({
  ...common,
  entryPoints: {
    'service-worker': `${root}src/background/service-worker.ts`,
    // The reveal frame is its own document on the extension origin (SPEC §8.1),
    // so it is a separate entry rather than part of the content bundle.
    reveal: `${root}src/ui/reveal.ts`,
  },
  format: 'esm',
});

/**
 * Content scripts are **classic** scripts. `chrome.scripting.registerContentScripts`
 * gives them no module context, so a trailing `export {}` is a syntax error —
 * and a syntax error is a *parse*-time failure, which means not one line of the
 * file runs.
 *
 * `egress-main.ts` exports its seams so the tests can reach them, so building it
 * as ESM shipped a shim that had never installed on any page, in any build. It
 * failed silently by construction: the file that reports `health` is the file
 * that failed to parse, so the gate's own liveness signal could not fire. Only
 * `content.js` survived, and only because `main.ts` happens to export nothing.
 */
await build({
  ...common,
  entryPoints: {
    content: `${root}src/content/main.ts`,
    // The egress shim runs in the page's own realm (SPEC §11.2), so it shares no
    // module instance with the content bundle and must be its own entry.
    egress: `${root}src/content/egress-main.ts`,
  },
  format: 'iife',
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
  console.log(`  reveal      : ${devPolicy.reveal} (SPEC §10.9 — --reveal=off|dom puts real values in the DOM)`);
  console.log(`  debug       : ${devPolicy.debug ? 'on' : 'off'} (loud console banners; --debug=off to silence)`);
  console.log(
    `  activity    : ${devPolicy.activityEndpoint || '(off)'} (--activity-endpoint=http://localhost:4000/pii/activity --activity-token=sk-...)`,
  );
  console.log(`  backend     : ${devPolicy.detectEndpoint}`);
  console.log(
    `  policy pull : ${devPolicy.policyEndpoint || '(off — baked lists only)'}` +
      (devPolicy.policyEndpoint ? ` every ${devPolicy.policyRefreshMinutes} min` : ''),
  );
  console.log(
    devPolicy.policyEndpoint
      ? `  note        : a pulled list OUTRANKS the baked one above`
      : `  note        : pull disabled (hosts named on the command line), so the list above is final`,
  );
  console.log(`  change hosts: rebuild with --native=host, or override chrome.storage.local at runtime`);
  console.log(`  build id    : ${buildId}  <- must match the banner in the page console`);
} else {
  console.log(`built -> ${out}`);
  console.log(`  build id    : ${buildId}`);
}
