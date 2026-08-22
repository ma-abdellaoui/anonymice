import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerializer } from '../src/lib/serialize.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lastWins = (_queued: string, incoming: string) => incoming;

test('two runs never overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const s = createSerializer<string>(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick(5);
    active--;
  }, lastWins);

  await Promise.all([s.run('a'), s.run('b'), s.run('c')]);
  await tick(30);
  assert.equal(maxActive, 1, 'this is the Duplicate script ID bug if it is ever 2');
});

test('a burst during a run collapses into exactly one follow-up', async () => {
  const runs: string[] = [];
  const s = createSerializer<string>(async (mode) => {
    runs.push(mode);
    await tick(10);
  }, lastWins);

  const first = s.run('first');
  s.run('x');
  s.run('y');
  s.run('z');
  await first;
  await tick(40);
  assert.deepEqual(runs, ['first', 'z'], 'one run for the burst, carrying the merged mode');
});

test('merge decides what the follow-up run does', async () => {
  const runs: string[] = [];
  const preferRefresh = (a: string, b: string) => (a === 'refresh' || b === 'refresh' ? 'refresh' : 'cached');
  const s = createSerializer<string>(async (mode) => {
    runs.push(mode);
    await tick(5);
  }, preferRefresh);

  const first = s.run('cached');
  s.run('cached');
  s.run('refresh');   // outranks the queued cached
  s.run('cached');
  await first;
  await tick(30);
  assert.deepEqual(runs, ['cached', 'refresh']);
});

test('a failing task does not wedge the queue', async () => {
  const runs: string[] = [];
  const s = createSerializer<string>(async (mode) => {
    runs.push(mode);
    throw new Error('boom');
  }, lastWins);

  await s.run('a').catch(() => {});
  await s.run('b').catch(() => {});
  await tick(10);
  assert.deepEqual(runs, ['a', 'b']);
  assert.equal(s.busy, false);
});
