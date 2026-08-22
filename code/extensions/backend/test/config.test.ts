import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, isLoopback, loadConfig } from '../src/config.ts';

test('a missing credential refuses to start, and says how to fix it', () => {
  assert.throws(() => loadConfig({ env: {}, argv: [] }), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /DETECT_TOKEN/);
    assert.match(err.message, /--dev/);
    return true;
  });
});

test('--dev is the only route to the well-known credential, and it pins to loopback', () => {
  const config = loadConfig({ env: { HOST: '0.0.0.0' }, argv: ['--dev'] });
  assert.deepEqual(config.tokens, ['dev-token']);
  assert.equal(config.host, '127.0.0.1');
  assert.ok(isLoopback(config.host));
});

test('a short credential is refused outside dev', () => {
  assert.throws(() => loadConfig({ env: { DETECT_TOKEN: 'short' }, argv: [] }), ConfigError);
});

test('a rotation configures two live credentials, current first', () => {
  const config = loadConfig({ env: { DETECT_TOKEN: 'current-credential-x', DETECT_TOKEN_PREVIOUS: 'previous-credential-x' }, argv: [] });
  assert.deepEqual(config.tokens, ['current-credential-x', 'previous-credential-x']);
});

test('the default bind address is loopback', () => {
  assert.equal(loadConfig({ env: { DETECT_TOKEN: 'a-long-enough-token' }, argv: [] }).host, '127.0.0.1');
});

test('a bad numeric env var fails at startup rather than silently defaulting', () => {
  assert.throws(() => loadConfig({ env: { DETECT_TOKEN: 'a-long-enough-token', PORT: 'eight' }, argv: [] }), ConfigError);
  assert.throws(() => loadConfig({ env: { DETECT_TOKEN: 'a-long-enough-token', LOG_LEVEL: 'chatty' }, argv: [] }), ConfigError);
});
