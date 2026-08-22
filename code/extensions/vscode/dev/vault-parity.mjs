/**
 * `src/lib/vault.ts` is duplicated into `browser/mock/vault.ts` so the mock
 * backend can serve the shared vault without a build step. Two copies that
 * drift are worse than one copy in the wrong place: a token minted by one and
 * resolved by the other would disagree about scope reuse, retention or what
 * revocation kills, and none of that fails loudly.
 *
 * Two differences are expected and nothing else is: the import paths, and the
 * vendoring note at the top of the copy.
 */
import { readFileSync } from 'node:fs';

const here = new URL('../src/lib/vault.ts', import.meta.url).pathname;
const there = new URL('../../browser/mock/vault.ts', import.meta.url).pathname;

const strip = (src) =>
  src
    .replace("from '../src/lib/tokens.ts'", "from './tokens.ts'")
    .replace("from '../src/lib/types.ts'", "from './types.ts'")
    // The leading block comment, however long, is allowed to differ.
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '');

const mine = strip(readFileSync(here, 'utf8'));
const theirs = strip(readFileSync(there, 'utf8'));

if (mine !== theirs) {
  const a = mine.split('\n');
  const b = theirs.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  console.error('vault parity: vscode/src/lib/vault.ts and browser/mock/vault.ts have drifted.');
  console.error(`  first difference around line ${at + 1} (after the header comment):`);
  console.error(`    vscode: ${a[at] ?? '(end of file)'}`);
  console.error(`    mock  : ${b[at] ?? '(end of file)'}`);
  process.exit(1);
}
console.log('vault: vscode == browser/mock');
