/**
 * Checks whether the fixture hostnames resolve, and prints the /etc/hosts line
 * plus the exact commands to add and remove it.
 *
 * It never writes to /etc itself, and never invokes sudo: even `sudo -n` can sit
 * waiting on an askpass helper, and a setup script that hangs is worse than one
 * that tells you what to type.
 *
 *   node dev/hosts.ts
 */
import { readFileSync } from 'node:fs';
import { HOSTS } from './fixture-server.ts';

const MARKER = '# anonymice QA fixtures';
const LINE = `127.0.0.1 ${HOSTS.native} ${HOSTS.trusted} ${MARKER}`;
const HOSTS_FILE = '/etc/hosts';

const current = readFileSync(HOSTS_FILE, 'utf8');
const already = [HOSTS.native, HOSTS.trusted].every((h) =>
  current.split('\n').some((l) => !l.trim().startsWith('#') && l.includes(h)),
);

if (already) {
  console.log(`already resolvable: ${HOSTS.native}, ${HOSTS.trusted}`);
  process.exit(0);
}

console.log(
  `${HOSTS.native} and ${HOSTS.trusted} do not resolve yet.\n\n` +
    `Add them (one command, needs your password):\n\n` +
    `  echo ${JSON.stringify(LINE)} | sudo tee -a ${HOSTS_FILE}\n\n` +
    `Undo when you are done:\n\n` +
    `  sudo sed -i '/${MARKER.slice(2)}/d' ${HOSTS_FILE}\n\n` +
    `Then re-run this to confirm.`,
);
process.exitCode = 1;
