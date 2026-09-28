import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi } from 'viem';
import { loadConfig, requireLiveKey } from '../src/config.js';
import { runFlow } from '../src/flow.js';
import { pickToken, reviewQuote, reviewSwap } from '../src/guards.js';
import { main } from '../src/main.js';
import { USDC } from '../src/payment.js';
import { config, hash, other, quote, swap, swapArgs, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('configuration pins public mainnet, small payments and a small trade', () => {
  assert.equal(config.apiUrl, 'https://api.arcgate.dev');
  assert.equal(config.chainId, 5042);
  assert.equal(config.maxTotal, 25000n);
  for (const env of [{ SELL_AMOUNT: '1.1' }, { SELL_AMOUNT: '-1' }, { SELL_AMOUNT: '0.0000001' }, { API_URL: 'http://example.com' }, { API_URL: 'https://name:password@example.com' }]) assert.throws(() => loadConfig(env));
  assert.throws(() => requireLiveKey({ CIRCLE_API_KEY: 'TEST_API_KEY:example' }), /mainnet/);
});

test('trade requires explicit execution before loading credentials or paying', async () => {
  await assert.rejects(main(['trade']), /--execute/);
});

test('search rejects ambiguous resolution, impostors and unverified tokens', () => {
  const search = { network: 'eip155:5042', resolution: 'verified', results: [{ address: config.buyToken, verification: { status: 'verified' }, flags: [] }] };
  assert.equal(pickToken(search, config.buyToken).address, config.buyToken);
  for (const mutate of [value => { value.resolution = 'ambiguous'; }, value => { value.results[0].address = other; }, value => { value.results[0].flags = ['impersonates_canonical']; }]) {
    const value = structuredClone(search); mutate(value); assert.throws(() => pickToken(value, config.buyToken));
  }
});

test('quote uses sell.amountRaw and preserves the original minimum', () => {
  assert.equal(reviewQuote(quote(), config), 1188n);
  const changed = quote(); changed.sell.amountRaw = '2000000';
  assert.throws(() => reviewQuote(changed, config), /sell amount/);
  const unsafe = quote(); unsafe.safety.verdict = 'cannot_sell';
  assert.throws(() => reviewQuote(unsafe, config), /safety/);
});

test('decode complete batch before any send; refuse changed order and output floor', () => {
  assert.equal(reviewSwap(swap(), quote(), wallet, config, 1188n).length, 2);
  for (const [index, value] of [[1, 2_000_000n], [2, other], [3, 1187n], [4, other], [5, 0n]]) {
    const args = swapArgs(); args[index] = value;
    assert.throws(() => reviewSwap(swap(args), quote(), wallet, config, 1188n));
  }
  const redirected = swap(); redirected.transactions[1].to = other;
  assert.throws(() => reviewSwap(redirected, quote(), wallet, config, 1188n));
  const tooMuch = swap(); tooMuch.transactions[0].data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [config.router, 2n ** 256n - 1n] });
  assert.throws(() => reviewSwap(tooMuch, quote(), wallet, config, 1188n), /exact sell amount/);
  const reordered = swap(); reordered.transactions.reverse();
  assert.throws(() => reviewSwap(reordered, quote(), wallet, config, 1188n), /followed by/);
});

test('native-funded swaps require 18-decimal value and native pull mode', () => {
  const args = swapArgs(); args[7].mode = 2;
  const native = swap(args); native.transactions.shift(); native.transactions[0].value = '1000000000000000000';
  assert.match(reviewSwap(native, quote(), wallet, config, 1188n)[0].funding, /native/);
  native.transactions[0].value = '1000000';
  assert.throws(() => reviewSwap(native, quote(), wallet, config, 1188n), /native value/);
});

function workflow() {
  const calls = [], sent = [];
  let delivered = false;
  const q = quote(), s = swap();
  return { calls, sent, dependencies: { wallet, config, log: () => {},
    api: async (operation, body) => {
      calls.push({ operation, body });
      if (operation === 'search') return { network: 'eip155:5042', resolution: 'verified', results: [{ address: config.buyToken, symbol: 'cirBTC', verification: { status: 'verified' }, flags: [] }] };
      if (operation === 'quote') return q;
      assert.equal(body.approval, 'approve'); assert.equal(body.taker, wallet.address);
      return s;
    },
    rpc: { readContract: async ({ address }) => address === USDC ? 3_000_000n : delivered ? 1200n : 0n,
      waitForTransactionReceipt: async () => {
        if (sent.length === 1) return { status: 'success', logs: [] };
        delivered = true;
        return { status: 'success', logs: [{ address: config.buyToken,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: config.router, to: wallet.address } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [1200n]),
        }] };
      } },
    send: async tx => { sent.push(tx); return hash; },
  } };
}

test('preview runs public request flow without submitting any transaction', async () => {
  const { dependencies, sent, calls } = workflow();
  await runFlow('preview', dependencies);
  assert.deepEqual(calls.map(x => x.operation), ['search', 'quote', 'swap']);
  assert.equal(sent.length, 0);
});

test('trade sends approval then swap and verifies delivery against the quote floor', async () => {
  const { dependencies, sent } = workflow();
  assert.equal((await runFlow('trade', dependencies)).delivered, 1200n);
  assert.deepEqual(sent.map(x => x.purpose), ['approve', 'swap']);
});

test('failed approval stops execution before the swap', async () => {
  const { dependencies, sent } = workflow();
  dependencies.rpc.waitForTransactionReceipt = async () => ({ status: 'reverted', logs: [] });
  await assert.rejects(runFlow('trade', dependencies), /reverted/);
  assert.equal(sent.length, 1);
});
