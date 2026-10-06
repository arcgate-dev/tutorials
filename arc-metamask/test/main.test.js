import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main } from '../src/main.js';
import { fakeMm, freeFetch, guardRefusal, localnet } from './support.js';

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
