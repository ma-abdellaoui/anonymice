/**
 * Emits the enterprise policy file that populates chrome.storage.managed — the
 * channel SPEC §1 specifies for the real trust list, and the one a deployment
 * will actually use. The QA build's baked policy is a convenience; this is the
 * mechanism.
 *
 *   node dev/managed-policy.ts <extension-id> [--native=a,b] [--trusted=c]
 *
 * Prints the file and the command to install it. It does not write anything
 * itself: the target lives under /etc and needs root, which is not this
 * script's call to take.
 */
import { platform } from 'node:os';

const id = process.argv[2];
if (!id || id.startsWith('--')) {
  console.error(
    'usage: node dev/managed-policy.ts <extension-id> [--native=a,b] [--trusted=c]\n' +
      '  [--policy-endpoint=URL] [--policy-refresh=MINUTES]\n' +
      'The id is on chrome://extensions with Developer mode on. For an unpacked\n' +
      'extension it is derived from the directory path, so it is stable across reloads.',
  );
  process.exit(1);
}

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const hosts = (raw: string): string[] => raw.split(',').map((h) => h.trim()).filter(Boolean);

const policy = {
  '3rdparty': {
    extensions: {
      [id]: {
        policyVersion: argValue('policyVersion', new Date().toISOString().slice(0, 10)),
        locale: argValue('locale', 'de-CH'),
        detectEndpoint: argValue('endpoint', 'http://localhost:8788/v1/detect'),
        detectToken: argValue('token', 'dev-token'),
        // Set this and the lists below become a fallback: the extension pulls
        // the current ones from the backend (ENDPOINTS.md §2). Leave it out to
        // distribute the lists by managed policy alone.
        policyEndpoint: argValue('policy-endpoint', 'http://localhost:8788/v1/policy'),
        policyRefreshMinutes: Number(argValue('policy-refresh', '60')),
        native: hosts(argValue('native', 'localhost')),
        trusted: hosts(argValue('trusted', '')),
        scanTrusted: 'off',
        painter: argValue('painter', 'auto'),
      },
    },
  },
};

/** Chrome and Chromium read different directories; Chromium's is the fallback. */
const target =
  platform() === 'darwin'
    ? '/Library/Managed Preferences/com.google.Chrome.plist (see Chrome policy docs — plist, not JSON)'
    : '/etc/opt/chrome/policies/managed/anonymice.json   (Chromium: /etc/chromium/policies/managed/anonymice.json)';

console.log(JSON.stringify(policy, null, 2));
console.error(`
# install to:
#   ${target}
#
# then, in Chrome: chrome://policy -> Reload policies, and reload the extension.
# Verify from the service worker console:
#   await chrome.storage.managed.get(null)
#
# one-liner (Linux):
#   node dev/managed-policy.ts ${id} --native=${argValue('native', 'localhost')} \\
#     | sudo tee /etc/opt/chrome/policies/managed/anonymice.json > /dev/null
#
# Managed values outrank storage.local and the baked QA policy, so this is also
# how you prove the precedence in SPEC §1 holds.`);
