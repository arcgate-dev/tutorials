import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { getAddress } from 'viem';
import * as cfg from '../src/config.js';
import { inspect } from '../src/main.js';
import { other } from './fixtures.js';
import { freeFetch, localnet, mainnet } from './support.js';

process.env.PATH = ''; // Never let a test find the real `mm` on this machine.
globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const MAINNET = 'eip155:5042', TESTNET = 'eip155:5042002';
const base = () => cfg.loadConfig({});
const ROW = {
  [MAINNET]: { paymentChainId: 5042, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io', paymentRpcUrl: 'https://rpc.mainnet.arc.io',
    payTo: '0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e', router: '0x6cf4f7785d479b9ec1c3abe2fb569525380baede' },
  [TESTNET]: { paymentChainId: 5042002, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'http://127.0.0.1:19845', paymentRpcUrl: 'https://rpc.testnet.arc.io',
    payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', router: '0x0eA7461542fE051c013AB0f5860190bC847f3271' },
};
const same = (actual, expected, label) => {
  if (['payTo', 'router'].includes(label)) assert.equal(getAddress(actual), getAddress(expected), label);
  else assert.equal(actual, expected, label);
};
const offered = capture => capture.search402.paymentRequired.accepts[0];

// inspect() reads the pay-to override from the process environment, as the npm scripts do.
async function withEnv(values, run) {
  const saved = {};
  for (const key of Object.keys(values)) { saved[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const clean = { ARC_RPC_URL: undefined, ARCGATE_PAY_TO: undefined, ARCGATE_ROUTER_ADDRESS: undefined };

test('API_URL accepts https anywhere and http only on localhost or 127.0.0.1; credentials, paths and queries are refused', () => {
  for (const url of ['https://api.arcgate.dev', 'http://127.0.0.1:19800', 'http://localhost:19800']) {
    assert.equal(cfg.loadConfig({ API_URL: url }).apiUrl, url);
  }
  assert.equal(cfg.loadConfig({}).apiUrl, 'https://api.arcgate.dev');
  for (const url of ['http://example.com', 'http://api.arcgate.dev', 'http://127.0.0.1.example.com:19800', 'http://localhost.example.com',
    'http://0.0.0.0:19800', 'ftp://127.0.0.1:19800', 'not a url',
    'http://user:pass@127.0.0.1:19800', 'https://user:pass@api.arcgate.dev', 'https://name@api.arcgate.dev',
    'http://127.0.0.1:19800/v1', 'http://127.0.0.1:19800/?key=1', 'https://api.arcgate.dev/trade', 'https://api.arcgate.dev/?x=1', 'https://api.arcgate.dev/#x']) {
    assert.throws(() => cfg.loadConfig({ API_URL: url }), url);
  }
});

test('loadConfig carries no network of its own: the API names it', () => {
  const config = base();
  for (const key of ['network', 'chainId', 'blockchain', 'paymentChainId', 'tradeChainId', 'payTo', 'router', 'rpcUrl']) assert.equal(config[key], undefined, key);
  assert.equal(config.amount, '0.50'); assert.equal(config.maxPayment, 10_000n); assert.equal(config.maxTotal, 25_000n); assert.equal(config.slippageBps, 100);
});

test('forNetwork resolves eip155:5042 and eip155:5042002 and refuses any other network', () => {
  for (const [network, expected] of Object.entries(ROW)) {
    const resolved = cfg.forNetwork(base(), network, {});
    assert.equal(resolved.network, network);
    for (const [key, value] of Object.entries(expected)) same(resolved[key], value, key);
    // Resolution keeps what loadConfig validated.
    assert.equal(resolved.apiUrl, 'https://api.arcgate.dev'); assert.equal(resolved.amount, '0.50');
    assert.equal(resolved.maxPayment, 10_000n); assert.equal(resolved.maxTotal, 25_000n); assert.equal(resolved.slippageBps, 100);
  }
  for (const network of ['eip155:1', 'eip155:42161', 'eip155:5042 ', 'eip155:50420020', '', undefined, 'constructor']) {
    assert.throws(() => cfg.forNetwork(base(), network, {}), /network/i, String(network));
  }
});

test('env overrides the trade RPC, the payee and the router on either row', () => {
  const env = { ARCGATE_PAY_TO: other.toLowerCase(), ARCGATE_ROUTER_ADDRESS: offered(localnet).payTo, ARC_RPC_URL: 'http://localhost:19845' };
  for (const network of [MAINNET, TESTNET]) {
    const resolved = cfg.forNetwork(base(), network, env);
    assert.equal(resolved.payTo, other);
    assert.equal(resolved.router, getAddress(env.ARCGATE_ROUTER_ADDRESS));
    assert.equal(resolved.rpcUrl, 'http://localhost:19845');
  }
  // API fees are paid on Arc testnet itself, never on the localnet fork the trade RPC points at.
  assert.equal(cfg.forNetwork(base(), TESTNET, env).paymentRpcUrl, 'https://rpc.testnet.arc.io');
  assert.throws(() => cfg.forNetwork(base(), TESTNET, { ARCGATE_PAY_TO: 'not-an-address' }));
  assert.throws(() => cfg.forNetwork(base(), TESTNET, { ARCGATE_ROUTER_ADDRESS: '0x123' }));
});

test('inspect resolves the production row from the captured /health and 402, and never signs', async () => {
  const seen = [], logs = [];
  const config = await withEnv(clean, () => inspect(cfg.loadConfig({}), freeFetch(mainnet, seen), line => logs.push(line)));
  assert.equal(config.network, MAINNET);
  for (const [key, value] of Object.entries(ROW[MAINNET])) same(config[key], value, key);
  // The pinned row agrees with what production actually asks for.
  assert.equal(getAddress(config.payTo), getAddress(offered(mainnet).payTo));
  assert.deepEqual(seen.map(request => new URL(request.url).pathname), ['/health', '/trade/v1/search']);
  for (const request of seen) assert.equal(request.headers.get('payment-signature'), null);
  const output = logs.join('\n');
  assert(output.includes(mainnet.health.commit), 'logs the deployed commit');
  assert(output.includes(mainnet.health.rulesVersion), 'logs the rules version');
});

test('inspect resolves the Arc testnet row from the captured localnet /health and 402', async () => {
  const seen = [], logs = [];
  const env = { ...clean, ARCGATE_PAY_TO: offered(localnet).payTo };
  const config = await withEnv(env, () => inspect(cfg.loadConfig({ API_URL: 'http://127.0.0.1:19800' }), freeFetch(localnet, seen), line => logs.push(line)));
  assert.equal(config.network, TESTNET);
  assert.equal(config.apiUrl, 'http://127.0.0.1:19800');
  for (const [key, value] of Object.entries(ROW[TESTNET])) if (key !== 'payTo') same(config[key], value, key);
  same(config.payTo, offered(localnet).payTo, 'payTo');
  assert.deepEqual(seen.map(request => new URL(request.url).pathname), ['/health', '/trade/v1/search']);
  for (const request of seen) assert.equal(request.headers.get('payment-signature'), null);
  assert(logs.join('\n').includes(localnet.health.rulesVersion), 'logs the rules version');
});

test('inspect refuses before signing when /health and the 402 disagree, or the network is unknown', async () => {
  const refuse = async (capture, pattern) => {
    const seen = [];
    await assert.rejects(withEnv(clean, () => inspect(cfg.loadConfig({}), freeFetch(capture, seen), () => {})), pattern);
    for (const request of seen) assert.equal(request.headers.get('payment-signature'), null);
  };
  // Each case mutates its own clone of a captured response.
  const mismatch = structuredClone(mainnet);
  mismatch.search402.paymentRequired.accepts[0].network = TESTNET; // /health says 5042, the 402 says 5042002
  await refuse(mismatch, /network/i);
  const reverse = structuredClone(mainnet);
  reverse.health.x402.network = TESTNET; // /health says 5042002, the 402 says 5042
  await refuse(reverse, /network/i);
  const mixed = structuredClone(mainnet);
  mixed.search402.paymentRequired.accepts.push({ ...offered(mainnet), network: TESTNET }); // one offer on another network
  await refuse(mixed, /network/i);
  const unknown = structuredClone(mainnet);
  unknown.health.x402.network = 'eip155:1'; // both agree, but it is not an Arc network
  unknown.search402.paymentRequired.accepts[0].network = 'eip155:1';
  await refuse(unknown, /network/i);
  const disabled = structuredClone(mainnet);
  disabled.health.x402.enabled = false;
  await refuse(disabled, /unavailable|disabled/i);
});

test('copying .env.example and pointing API_URL at the localnet resolves the Arc testnet row, not mainnet values', () => {
  const example = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  // The shipped file talks to production with no network pinned: each row's defaults live in src/config.js.
  assert.equal(cfg.loadConfig(example).apiUrl, 'https://api.arcgate.dev');
  for (const key of ['ARCGATE_PAY_TO', 'ARCGATE_ROUTER_ADDRESS', 'ARC_RPC_URL']) assert.equal(example[key], undefined, `${key} is an active line in .env.example`);
  // The only edit a reader makes for the localnet is API_URL; npm run loads the file through --env-file.
  const env = { ...example, API_URL: 'http://127.0.0.1:19800' };
  const testnet = cfg.forNetwork(cfg.loadConfig(env), TESTNET, env);
  assert.equal(testnet.apiUrl, 'http://127.0.0.1:19800');
  for (const key of ['payTo', 'router', 'rpcUrl']) same(testnet[key], ROW[TESTNET][key], key);
  // Production resolves to its own row from the same file.
  const mainnet = cfg.forNetwork(cfg.loadConfig(example), MAINNET, example);
  for (const key of ['payTo', 'router', 'rpcUrl']) same(mainnet[key], ROW[MAINNET][key], key);
});
