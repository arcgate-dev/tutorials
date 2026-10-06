import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import * as cfg from '../src/config.js';
import { inspect, main } from '../src/main.js';
import { captured, freeFetch, MAINNET, other, TESTNET } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const base = () => cfg.loadConfig({});
const ROW = {
  [MAINNET]: { paymentChainId: 5042, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io', paymentRpcUrl: 'https://rpc.mainnet.arc.io', blockchain: 'ARC', apiKeyPrefix: 'LIVE_API_KEY:',
    payTo: '0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e', router: '0x6cf4f7785d479b9ec1c3abe2fb569525380baede', broadcast: 'circle' },
  [TESTNET]: { paymentChainId: 5042002, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'http://127.0.0.1:19845', paymentRpcUrl: 'https://rpc.testnet.arc.io', blockchain: 'ARC-TESTNET', apiKeyPrefix: 'TEST_API_KEY:',
    payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', router: '0x0eA7461542fE051c013AB0f5860190bC847f3271', broadcast: 'fork' },
};
const same = (actual, expected, label) => {
  if (['payTo', 'router'].includes(label)) assert.equal(getAddress(actual), getAddress(expected), label);
  else assert.equal(actual, expected, label);
};

test('network table resolves both Arc networks and refuses any other', () => {
  assert.deepEqual(Object.keys(cfg.NETWORKS).sort(), [MAINNET, TESTNET].sort());
  for (const [network, expected] of Object.entries(ROW)) {
    for (const [key, value] of Object.entries(expected)) same(cfg.NETWORKS[network][key], value, key);
    const resolved = cfg.forNetwork(base(), network, {});
    assert.equal(resolved.network, network);
    for (const [key, value] of Object.entries(expected)) same(resolved[key], value, key);
    // Resolution keeps what loadConfig validated.
    assert.equal(resolved.amount, '1');
    assert.equal(resolved.maxPayment, 10_000n);
    assert.equal(resolved.maxTotal, 25_000n);
    assert.equal(resolved.slippageBps, 100);
  }
  for (const network of ['eip155:1', 'eip155:5042 ', 'eip155:42161', '', undefined, 'constructor']) {
    assert.throws(() => cfg.forNetwork(base(), network, {}), /network/i, String(network));
  }
});

test('requireApiKey refuses a LIVE_API_KEY on eip155:5042002 and a TEST_API_KEY on eip155:5042', () => {
  const mainnet = cfg.forNetwork(base(), MAINNET, {});
  const testnet = cfg.forNetwork(base(), TESTNET, {});
  assert.doesNotThrow(() => cfg.requireApiKey(mainnet, { CIRCLE_API_KEY: 'LIVE_API_KEY:example' }));
  assert.doesNotThrow(() => cfg.requireApiKey(testnet, { CIRCLE_API_KEY: 'TEST_API_KEY:example' }));
  assert.throws(() => cfg.requireApiKey(testnet, { CIRCLE_API_KEY: 'LIVE_API_KEY:example' }),
    error => /eip155:5042002/.test(error.message) && /TEST_API_KEY/.test(error.message) && /ARC-TESTNET/.test(error.message));
  assert.throws(() => cfg.requireApiKey(mainnet, { CIRCLE_API_KEY: 'TEST_API_KEY:example' }),
    error => /eip155:5042\b/.test(error.message) && /LIVE_API_KEY/.test(error.message) && /\bARC\b/.test(error.message));
  for (const env of [{}, { CIRCLE_API_KEY: '' }, { CIRCLE_API_KEY: 'example' }, { CIRCLE_API_KEY: 'xTEST_API_KEY:example' }]) {
    assert.throws(() => cfg.requireApiKey(testnet, env), /TEST_API_KEY/, JSON.stringify(env));
  }
});

test('loopback http only for API_URL and ARC_RPC_URL', () => {
  for (const url of ['http://127.0.0.1:19800', 'http://localhost:19845', 'https://api.arcgate.dev']) {
    assert.equal(cfg.loadConfig({ API_URL: url }).apiUrl, url);
    assert.equal(cfg.forNetwork(base(), TESTNET, { ARC_RPC_URL: url }).rpcUrl, url);
  }
  for (const url of ['http://example.com', 'http://127.0.0.1.example.com:19800', 'http://localhost.example.com',
    'http://0.0.0.0:19800', 'ftp://127.0.0.1:19800', 'http://user:pass@127.0.0.1:19800', 'https://user:pass@api.arcgate.dev']) {
    assert.throws(() => cfg.loadConfig({ API_URL: url }), url);
    assert.throws(() => cfg.forNetwork(base(), TESTNET, { ARC_RPC_URL: url }), url);
  }
  for (const url of ['http://127.0.0.1:19800/v1', 'http://127.0.0.1:19800/?key=1', 'https://api.arcgate.dev/trade', 'https://api.arcgate.dev/#x']) {
    assert.throws(() => cfg.loadConfig({ API_URL: url }), url);
  }
});

test('env overrides pinned addresses and the trade RPC', () => {
  const pinned = cfg.forNetwork(base(), TESTNET, {});
  assert.equal(getAddress(pinned.payTo), getAddress(ROW[TESTNET].payTo));
  const env = { ARCGATE_PAY_TO: other.toLowerCase(), ARCGATE_ROUTER_ADDRESS: captured.search402.paymentRequired.accepts[0].payTo, ARC_RPC_URL: 'http://localhost:19845' };
  for (const network of [MAINNET, TESTNET]) {
    const resolved = cfg.forNetwork(base(), network, env);
    assert.equal(resolved.payTo, other);
    assert.equal(resolved.router, getAddress(env.ARCGATE_ROUTER_ADDRESS));
    assert.equal(resolved.rpcUrl, 'http://localhost:19845');
    assert.equal(resolved.blockchain, ROW[network].blockchain);
  }
  // The fee balance is read on testnet itself, never on the fork.
  assert.equal(cfg.forNetwork(base(), TESTNET, env).paymentRpcUrl, 'https://rpc.testnet.arc.io');
  assert.throws(() => cfg.forNetwork(base(), TESTNET, { ARCGATE_PAY_TO: 'not-an-address' }));
  assert.throws(() => cfg.forNetwork(base(), TESTNET, { ARCGATE_ROUTER_ADDRESS: '0x123' }));
});

test('inspect resolves the 402 network and prints the API build', async () => {
  const logs = [];
  const fetchFn = freeFetch();
  const resolved = await inspect(cfg.loadConfig({ API_URL: 'http://127.0.0.1:19800' }), fetchFn, line => logs.push(line));
  assert.deepEqual(fetchFn.urls, ['http://127.0.0.1:19800/health', 'http://127.0.0.1:19800/trade/v1/search']);
  assert.equal(resolved.network, TESTNET);
  assert.equal(resolved.paymentChainId, 5042002);
  assert.equal(resolved.tradeNetwork, 'eip155:5042');
  assert.equal(resolved.blockchain, 'ARC-TESTNET');
  assert.equal(resolved.apiKeyPrefix, 'TEST_API_KEY:');
  assert.equal(resolved.broadcast, 'fork');
  assert.equal(resolved.apiUrl, 'http://127.0.0.1:19800');
  assert.match(logs.join('\n'), new RegExp(captured.health.rulesVersion));
  assert.match(logs.join('\n'), /commit/);

  const mainnetOffer = structuredClone(captured.search402.paymentRequired);
  mainnetOffer.accepts[0].network = MAINNET;
  const mainnetHealth = { ...captured.health, x402: { ...captured.health.x402, network: MAINNET } };
  const mainnet = await inspect(cfg.loadConfig({}), freeFetch({ health: mainnetHealth, required: mainnetOffer }), () => {});
  assert.equal(mainnet.network, MAINNET);
  assert.equal(mainnet.blockchain, 'ARC');
  assert.equal(mainnet.broadcast, 'circle');
});

test('inspect refuses a network mismatch or an unsupported network before any payment', async () => {
  const offerOn = network => { const value = structuredClone(captured.search402.paymentRequired); value.accepts[0].network = network; return value; };
  const healthOn = network => ({ ...captured.health, x402: { ...captured.health.x402, network } });
  const cases = [
    { health: healthOn(MAINNET), required: offerOn(TESTNET) },
    { health: healthOn(TESTNET), required: offerOn(MAINNET) },
    { health: healthOn('eip155:1'), required: offerOn('eip155:1') },
    { health: healthOn(TESTNET), required: offerOn('eip155:1') },
    { health: healthOn(TESTNET), required: offerOn(undefined) },
  ];
  for (const options of cases) {
    await assert.rejects(inspect(cfg.loadConfig({ API_URL: 'http://127.0.0.1:19800' }), freeFetch(options), () => {}), /network/i, JSON.stringify(options.health.x402));
  }
});

// main() reads process.env; run it against the captured free responses with no Circle credentials.
async function withEnv(env, fetchFn, run) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  for (const key of ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'CIRCLE_WALLET_ID', 'ARCGATE_PAY_TO', 'ARCGATE_ROUTER_ADDRESS', 'ARC_RPC_URL', 'SELL_AMOUNT']) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = fetchFn;
  try { return await run(); }
  finally {
    globalThis.fetch = saved.fetch;
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  }
}

test('inspect resolves the 402 network before any Circle call: the key must match it', async t => {
  t.mock.method(console, 'log', () => {});
  const mainnetOffer = structuredClone(captured.search402.paymentRequired);
  mainnetOffer.accepts[0].network = MAINNET;
  const mainnetHealth = { ...captured.health, x402: { ...captured.health.x402, network: MAINNET } };
  // No CIRCLE_ENTITY_SECRET or wallet: reaching the Circle client or wallet would raise a different error.
  await withEnv({ API_URL: 'http://127.0.0.1:19800', CIRCLE_API_KEY: 'LIVE_API_KEY:example' }, freeFetch(), () =>
    assert.rejects(main(['connect']), error => /TEST_API_KEY/.test(error.message) && /ARC-TESTNET/.test(error.message)));
  await withEnv({ API_URL: 'http://127.0.0.1:19800', CIRCLE_API_KEY: 'TEST_API_KEY:example' }, freeFetch({ health: mainnetHealth, required: mainnetOffer }), () =>
    assert.rejects(main(['search']), error => /LIVE_API_KEY/.test(error.message) && /\bARC\b/.test(error.message)));
});

test('inspect refuses a mismatched 402 network before any Circle call', async t => {
  t.mock.method(console, 'log', () => {});
  const mismatch = structuredClone(captured.search402.paymentRequired);
  mismatch.accepts[0].network = 'eip155:1';
  await withEnv({ API_URL: 'http://127.0.0.1:19800' }, freeFetch({ required: mismatch }), () =>
    assert.rejects(main(['search']), error => /network/i.test(error.message) && !/circle/i.test(error.message)));
});
