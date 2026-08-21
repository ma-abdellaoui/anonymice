// Build: core/ + platform/<target>/ -> dist/<target>/
//
// A copy step, not a bundler — deliberately. Content scripts are classic
// scripts that share state through the ISOLATED world's global scope, and the
// service worker is a real ES module, so nothing here needs bundling. If a
// content script ever needs to `import`, add esbuild at that point and not
// before.
//
//   node code/extensions/build.mjs           # all targets
//   node code/extensions/build.mjs chrome

import { readdir, mkdir, copyFile, rm, stat, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await readdir(join(HERE, 'platform'), { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);

for (const target of targets) {
  const out = join(HERE, 'dist', target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await copyTree(join(HERE, 'core'), out);
  await copyTree(join(HERE, 'platform', target), out);
  if (await verify(out, target)) console.log(`✓ ${target} → ${relative(process.cwd(), out)}`);
}

async function copyTree(src, dest) {
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name), d = join(dest, entry.name);
    if (entry.isDirectory()) { await mkdir(d, { recursive: true }); await copyTree(s, d); }
    else await copyFile(s, d);
  }
}

// Every path the manifest names must exist in the output. A manifest that
// references a missing content script fails silently at load time — the
// extension installs and simply never intercepts anything, which for this
// project is the worst possible failure mode.
async function verify(out, target) {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background?.service_worker,
    manifest.storage?.managed_schema,
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])
  ].filter(Boolean);

  const missing = [];
  for (const p of referenced) {
    try { await stat(join(out, p)); } catch { missing.push(p); }
  }
  if (missing.length) {
    console.error(`✗ ${target}: manifest references missing files:\n  ${missing.join('\n  ')}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}
