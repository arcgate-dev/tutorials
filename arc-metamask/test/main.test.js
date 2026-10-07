import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main } from '../src/main.js';
import { USDC } from '../src/payment.js';
import { wallet } from './fixtures.js';
import { fakeMm, freeFetch, guardRefusal, localnet, rpcFetch, word } from './support.js';

process.env.PATH = ''; // Never let a test find the real `mm` on this machine.

const forbidden = () => { throw new Error('Network access is forbidden in tests.'); };
globalThis.fetch = forbidden;

const signsOrSends = call => /^wallet (sign-typed-data|send-transaction)/.test(call);

test('every wallet command refuses to run in Guard Mode', async () => {
  for (const args of [['connect'], ['search'], ['quote'], ['preview'], ['trade', '--execute']]) {
    const calls = [], requests = [];
    globalThis.fetch = (...request) => { requests.push(request); return forbidden(); };
    const run = fakeMm({ 'wallet trading-mode': { mode: 'guard' } }, calls);
    await assert.rejects(main(args, { run }), guardRefusal, args.join(' '));
    assert(calls.includes('wallet trading-mode get'), `${args.join(' ')} must read the server's trading mode: ${calls.join(' | ')}`);
    assert.deepEqual(calls.filter(signsOrSends), [], args.join(' '));
    assert.equal(requests.length, 0, `${args.join(' ')} must not touch the network in Guard Mode`);
  }
  globalThis.fetch = forbidden;
});

test('a stale --beast flag or local session cannot talk a Guard wallet into running', async () => {
  const run = fakeMm({ 'wallet trading-mode': { mode: 'guard' }, 'init show': { walletMode: 'server-wallet', tradingMode: 'beast' } });
  await assert.rejects(main(['connect', '--beast'], { run }), guardRefusal);
});

test('npm run policy is an unknown command and the policy script is gone', async () => {
  const calls = [];
  await assert.rejects(main(['policy'], { run: fakeMm({}, calls) }), error => /Use npm run|unknown command/i.test(error.message) && !/policy/.test(error.message));
  assert.deepEqual(calls, []);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.policy, undefined);
  assert.equal(pkg.dependencies.yaml, undefined);
});

test('trade on the Arc testnet row is refused before any payment or signature', async () => {
  const calls = [], seen = [], saved = { API_URL: process.env.API_URL, ARCGATE_PAY_TO: process.env.ARCGATE_PAY_TO };
  process.env.API_URL = 'http://127.0.0.1:19800';
  process.env.ARCGATE_PAY_TO = localnet.search402.paymentRequired.accepts[0].payTo;
  globalThis.fetch = freeFetch(localnet, seen);
  try {
    await assert.rejects(main(['trade', '--execute'], { run: fakeMm({}, calls) }),
      error => /broadcasts to the real chain/.test(error.message) && /Arc mainnet/.test(error.message));
  } finally {
    globalThis.fetch = forbidden;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert(calls.includes('wallet trading-mode get'), 'Beast Mode is still checked first');
  assert.deepEqual(calls.filter(signsOrSends), []);
  // The row came from the API: only the free /health and the unpaid search 402 were requested, none with a payment.
  assert.deepEqual(seen.map(request => new URL(request.url).pathname), ['/health', '/trade/v1/search']);
  for (const request of seen) assert.equal(request.headers.get('payment-signature'), null);
});

// Where the RPC calls go once the row is resolved. The localnet row pays API fees on Arc testnet and trades on the Arc fork,
// and the mm wallet holds 9.8 USDC on the fork but about 1 USDC on testnet, so reading fees on the fork hides the bug.
const API = 'http://127.0.0.1:19800', FORK = 'http://127.0.0.1:19845', TESTNET_RPC = 'https://rpc.testnet.arc.io', STUB = 'http://127.0.0.1:19999';
const isBalanceOf = request => request.method === 'eth_call' && request.params[0].to?.toLowerCase() === USDC.toLowerCase()
  && (request.params[0].data ?? request.params[0].input)?.startsWith('0x70a08231');
const chain = (chainId, balance, code) => ({ method, params }) => {
  if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
  if (method === 'eth_call' && isBalanceOf({ method, params })) {
    if (!(params[0].data ?? params[0].input).toLowerCase().endsWith(wallet.address.slice(2).toLowerCase())) throw new Error('balanceOf of another account');
    return word(balance);
  }
  if (method === 'eth_getCode' && code) return code;
  throw new Error(`Unexpected ${method}`);
};

// Runs main() against the captured localnet API, with each RPC URL answering as the chain behind it would.
async function onLocalnet(args, endpoints, env = {}) {
  const calls = [], api = [], rpc = [], names = ['API_URL', 'ARCGATE_PAY_TO', 'ARC_RPC_URL'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { API_URL: API, ARCGATE_PAY_TO: localnet.search402.paymentRequired.accepts[0].payTo }, env);
  const serveApi = freeFetch(localnet, api), serveRpc = rpcFetch(endpoints, rpc);
  globalThis.fetch = (url, init) => String(url).startsWith(API) ? serveApi(url, init) : serveRpc(url, init);
  let outcome;
  try {
    outcome = await main(args, { run: fakeMm({}, calls) }).then(value => ({ value }), error => ({ error }));
  } finally {
    globalThis.fetch = forbidden;
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  return { ...outcome, calls, api, rpc };
}
const paidNothing = ({ calls, api }) => {
  assert.deepEqual(calls.filter(signsOrSends), [], 'no signature and no broadcast');
  assert.deepEqual([...new Set(api.map(request => new URL(request.url).pathname))].sort(), ['/health', '/trade/v1/search']);
  for (const request of api) assert.equal(request.headers.get('payment-signature'), null);
};

test("API fees are checked on the row's payment chain, and the trade RPC must be the row's trade chain", async () => {
  // (1) The fork holds 9.8 USDC, Arc testnet none: the fee balance read on the fork would let the run on to an x402 failure.
  const poor = await onLocalnet(['preview'], { [TESTNET_RPC]: chain(5042002, 0n), [FORK]: chain(5042, 9_800_000n, '0x6080') });
  assert.match(poor.error?.message ?? '', /fund/i, `preview must refuse for API fees, got ${poor.error?.message ?? 'a result'}`);
  assert.match(poor.error.message, /API fees/i);
  assert.match(poor.error.message, /Arc testnet/);
  paidNothing(poor);
  const balances = poor.rpc.filter(isBalanceOf).map(request => request.url);
  assert(balances.includes(TESTNET_RPC), `the fee balance is read on rpc.testnet.arc.io: ${balances.join(' | ')}`);
  assert(!balances.includes(FORK), 'the fee balance is never read on the fork');

  // (2) With enough testnet USDC the wallet connects, and the chain id is read on the trade RPC.
  const funded = await onLocalnet(['connect'], { [TESTNET_RPC]: chain(5042002, 5_000_000n), [FORK]: chain(5042, 9_800_000n, '0x6080') });
  assert.equal(funded.error, undefined, funded.error?.message);
  assert(funded.rpc.some(request => request.method === 'eth_chainId' && request.url === FORK), 'eth_chainId is read on the trade RPC');
  paidNothing(funded);

  // (3) A trade RPC on the payment chain (5042002) is not the trade chain (5042).
  const wrong = await onLocalnet(['connect'], { [TESTNET_RPC]: chain(5042002, 5_000_000n), [STUB]: chain(5042002, 5_000_000n) }, { ARC_RPC_URL: STUB });
  assert.match(wrong.error?.message ?? '', /chain/i, `connect must refuse a trade RPC on the wrong chain, got ${wrong.error?.message ?? 'a result'}`);
  assert(wrong.rpc.some(request => request.method === 'eth_chainId' && request.url === STUB), 'the stub trade RPC was asked for its chain id');
  paidNothing(wrong);
});
