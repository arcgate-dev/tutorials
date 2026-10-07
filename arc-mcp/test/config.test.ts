import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig, reportError } from '../src/config.ts';
import { noNetwork } from './support.ts';

globalThis.fetch = noNetwork;

const keys = () => ({ PRIVATE_KEY: generatePrivateKey(), AGENT_PRIVATE_KEY: generatePrivateKey() });

test('API_URL rules', () => {
  assert.equal(loadConfig({ ...keys() }).apiUrl, 'https://api.arcgate.dev', 'the default is the public API');
  assert.equal(loadConfig({ ...keys() }).mcpUrl, 'https://api.arcgate.dev/mcp');

  for (const origin of ['https://api.arcgate.dev', 'https://example.com:8443', 'http://127.0.0.1:19800', 'http://localhost:19800']) {
    const config = loadConfig({ ...keys(), API_URL: origin });
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
    assert.throws(() => loadConfig({ ...keys(), API_URL: bad }), (error: Error) => {
      assert.match(error.message, /API_URL/);
      assert.doesNotMatch(error.message, /hunter2/, 'a URL credential never reaches the error');
      return true;
    }, bad);
  }
});

test('keys are required and validated', () => {
  const { PRIVATE_KEY, AGENT_PRIVATE_KEY } = keys();
  const config = loadConfig({ PRIVATE_KEY, AGENT_PRIVATE_KEY });
  assert.equal(config.payer.address, privateKeyToAccount(PRIVATE_KEY as `0x${string}`).address);
  assert.equal(config.agent.address, privateKeyToAccount(AGENT_PRIVATE_KEY as `0x${string}`).address);
  assert.notEqual(config.payer.address, config.agent.address);

  assert.throws(() => loadConfig({ AGENT_PRIVATE_KEY }), /PRIVATE_KEY/);
  assert.throws(() => loadConfig({ PRIVATE_KEY }), /AGENT_PRIVATE_KEY/);
  assert.throws(() => loadConfig({}), /PRIVATE_KEY/);

  const notAKey = `0x${'zz'.repeat(32)}`;
  for (const bad of ['', '0x1234', notAKey, `0x${'00'.repeat(32)}`]) {
    for (const name of ['PRIVATE_KEY', 'AGENT_PRIVATE_KEY'] as const) {
      const env = { PRIVATE_KEY, AGENT_PRIVATE_KEY, [name]: bad };
      assert.throws(() => loadConfig(env), (error: Error) => {
        assert.match(error.message, new RegExp(name));
        for (const secret of [PRIVATE_KEY, AGENT_PRIVATE_KEY, bad]) {
          if (secret) assert.ok(!error.message.includes(secret), `the error for ${name}=${bad} must not print a key`);
        }
        return true;
      }, `${name}=${bad}`);
    }
  }
});

test('the defaults are the caps and tools this tutorial pays for', () => {
  const config = loadConfig({ ...keys() });
  assert.deepEqual(config.networks, ['eip155:5042', 'eip155:5042002']);
  assert.equal(config.maxPerCall, 50_000n, '0.05 USDC per call');
  assert.equal(config.maxPerRun, 70_000n, '0.07 USDC per run');
  assert.deepEqual(config.paidTools, ['tradeSearch', 'tradeQuote', 'boxCreate']);
});

test('reportError redacts both keys', () => {
  const env = keys();
  const error = mock.method(console, 'error', () => {});
  const exitCode = process.exitCode;
  try {
    reportError(new Error(`signing failed for ${env.PRIVATE_KEY}, then the agent ${env.AGENT_PRIVATE_KEY} at https://rpc.example/v1/secret-token?k=1`), env);
    reportError('a thrown string carrying ' + env.PRIVATE_KEY, env);
    const printed = error.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.equal(error.mock.calls.length, 2);
    assert.ok(!printed.includes(env.PRIVATE_KEY), 'the payer key is redacted');
    assert.ok(!printed.includes(env.AGENT_PRIVATE_KEY), 'the agent key is redacted');
    assert.ok(!printed.includes('secret-token'), 'a URL is redacted');
    assert.match(printed, /signing failed/);
    assert.equal(process.exitCode, 1);
  } finally {
    error.mock.restore();
    process.exitCode = exitCode;
  }
});
