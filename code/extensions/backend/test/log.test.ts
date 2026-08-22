import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoPlaintext, createLogger } from '../src/log.ts';
import { isAllowedOrigin } from '../src/http.ts';

test('a field that could carry page text throws rather than being logged', () => {
  for (const field of ['text', 'chunks', 'spans', 'normalized', 'value', 'token']) {
    assert.throws(() => assertNoPlaintext({ [field]: 'x' }), /may carry page text/);
  }
  assert.doesNotThrow(() => assertNoPlaintext({ chunkCount: 3, hash: 'sha256:x', ms: 1.2 }));
});

test('levels filter, and child fields ride along', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) }).child({ requestId: 'r1' });
  log.info('ignored');
  log.warn('kept', { chunkCount: 2 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record.event, 'kept');
  assert.equal(record.requestId, 'r1');
  assert.equal(record.chunkCount, 2);
});

test('CORS answers the extension and loopback, and nobody else', () => {
  assert.ok(isAllowedOrigin('chrome-extension://abcdefghijklmnop', []));
  assert.ok(isAllowedOrigin('http://localhost:8080', []));
  assert.ok(!isAllowedOrigin('https://evil.example', []));
  assert.ok(!isAllowedOrigin('null', []));
  assert.ok(isAllowedOrigin('https://ops.internal.example', ['https://ops.internal.example']));
  assert.ok(!isAllowedOrigin('chrome-extension://abcdefghijklmnop', ['https://ops.internal.example']));
});
