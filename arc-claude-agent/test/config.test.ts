import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig, reportError } from '../src/config.ts';
import { noNetwork } from './support.ts';

globalThis.fetch = noNetwork;

const key = () => ({ PRIVATE_KEY: generatePrivateKey() });

test('API_URL rules', () => {
  assert.equal(loadConfig(key()).apiUrl, 'https://api.arcgate.dev', 'the default is the public API');
  assert.equal(loadConfig(key()).mcpUrl, 'https://api.arcgate.dev/mcp');

  for (const origin of ['https://api.arcgate.dev', 'https://example.com:8443', 'http://127.0.0.1:19800', 'http://localhost:19800']) {
    const config = loadConfig({ ...key(), API_URL: origin });
    assert.equal(config.apiUrl, origin);
    assert.equal(config.mcpUrl, `${origin}/mcp`);
  }

  for (const bad of [
    'http://api.arcgate.dev', // http only for localhost and 127.0.0.1
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'ftp://127.0.0.1',
    'https://user:hunter2@api.arcgate.dev', // credentials
    'https://api.arcgate.dev/v1', // path
    'https://api.arcgate.dev/mcp', // the tutorial adds /mcp itself
    'https://api.arcgate.dev?key=1', // query
    'not a url',
  ]) {
    assert.throws(() => loadConfig({ ...key(), API_URL: bad }), (error: Error) => {
      assert.match(error.message, /API_URL/);
      assert.doesNotMatch(error.message, /hunter2/, 'a URL credential never reaches the error');
      return true;
    }, bad);
  }
});

test('one PRIVATE_KEY is the payer and the box', () => {
  const { PRIVATE_KEY } = key();
  const config = loadConfig({ PRIVATE_KEY });
  assert.equal(config.account.address, privateKeyToAccount(PRIVATE_KEY as `0x${string}`).address, 'the key signs the payments, the owner calls and is the box');

  // A second key in the environment changes nothing: there is no separate agent.
  const other = generatePrivateKey();
  const both = loadConfig({ PRIVATE_KEY, AGENT_PRIVATE_KEY: other });
  assert.equal(both.account.address, config.account.address);
  assert.ok(!('agent' in both) && !('payer' in both), 'one account, not a payer and an agent');
});

test('the key is required and validated, and never printed', () => {
  const { PRIVATE_KEY } = key();
  assert.throws(() => loadConfig({}), /PRIVATE_KEY/);
  assert.throws(() => loadConfig({ AGENT_PRIVATE_KEY: PRIVATE_KEY }), /PRIVATE_KEY/, 'only PRIVATE_KEY counts');

  const notAKey = `0x${'zz'.repeat(32)}`;
  for (const bad of ['', '0x1234', notAKey, `0x${'00'.repeat(32)}`]) {
    assert.throws(() => loadConfig({ PRIVATE_KEY: bad }), (error: Error) => {
      assert.match(error.message, /PRIVATE_KEY/);
      if (bad) assert.ok(!error.message.includes(bad), `the error for PRIVATE_KEY=${bad} must not print the key`);
      return true;
    }, `PRIVATE_KEY=${bad}`);
  }
});

test('the model id defaults to claude-sonnet-5-5 and CLAUDE_MODEL overrides it', () => {
  assert.equal(loadConfig(key()).model, 'claude-sonnet-5-5');
  assert.equal(loadConfig({ ...key(), CLAUDE_MODEL: 'claude-opus-5' }).model, 'claude-opus-5');
  assert.equal(loadConfig({ ...key(), CLAUDE_MODEL: '' }).model, 'claude-sonnet-5-5', 'an empty value is no choice');
});

test('the defaults are the caps and tools this tutorial pays for', () => {
  const config = loadConfig(key());
  assert.deepEqual(config.networks, ['eip155:5042', 'eip155:5042002']);
  assert.equal(config.maxPerCall, 50_000n, '0.05 USDC per call');
  assert.equal(config.maxPerRun, 80_000n, '0.08 USDC per run');
  assert.deepEqual(config.paidTools, ['boxCreate', 'watchCreate', 'inboundCreate']);
  for (const limit of [config.maxTurns, config.maxBudgetUsd]) {
    assert.equal(typeof limit, 'number');
    assert.ok(Number.isFinite(limit) && limit > 0, 'the model is bounded');
  }
});

test('reportError redacts PRIVATE_KEY and ANTHROPIC_API_KEY', () => {
  const env = { ...key(), ANTHROPIC_API_KEY: 'anthropic-key-for-this-test-0123456789' };
  const error = mock.method(console, 'error', () => {});
  const exitCode = process.exitCode;
  try {
    reportError(new Error(`signing failed for ${env.PRIVATE_KEY}, then the model call with ${env.ANTHROPIC_API_KEY} at https://rpc.example/v1/secret-token?k=1`), env);
    reportError('a thrown string carrying ' + env.PRIVATE_KEY + ' and ' + env.ANTHROPIC_API_KEY, env);
    const printed = error.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.equal(error.mock.calls.length, 2);
    assert.ok(!printed.includes(env.PRIVATE_KEY), 'the key is redacted');
    assert.ok(!printed.includes(env.ANTHROPIC_API_KEY), 'the Anthropic key is redacted');
    assert.ok(!printed.includes('secret-token'), 'a URL is redacted');
    assert.match(printed, /signing failed/);
    assert.equal(process.exitCode, 1);
  } finally {
    error.mock.restore();
    process.exitCode = exitCode;
  }
});
