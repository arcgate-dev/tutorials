import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi } from 'viem';
import { loadConfig, requireApiKey } from '../src/config.js';
import { runFlow } from '../src/flow.js';
import { pickToken, reviewQuote, reviewSwap } from '../src/guards.js';
import { main } from '../src/main.js';
import { USDC } from '../src/payment.js';
import { config, hash, other, quote, swap, swapArgs, testnetConfig, tradeReceipt, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('configuration pins public mainnet, small payments and a small trade', () => {
  assert.equal(config.apiUrl, 'https://api.arcgate.dev');
  assert.equal(config.paymentChainId, 5042);
  assert.equal(config.broadcast, 'circle');
  assert.equal(config.maxTotal, 25000n);
  for (const env of [{ SELL_AMOUNT: '1.1' }, { SELL_AMOUNT: '-1' }, { SELL_AMOUNT: '0.0000001' }, { API_URL: 'http://example.com' }, { API_URL: 'https://name:password@example.com' }]) assert.throws(() => loadConfig(env));
  assert.throws(() => requireApiKey(config, { CIRCLE_API_KEY: 'TEST_API_KEY:example' }), /LIVE_API_KEY/);
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

// A guard refusal is a plain Error from the guard itself, not a TypeError from reading a missing field.
const refusal = error => error.constructor === Error;

test('swap next send: only a swap that says to send can be broadcast', () => {
  assert.equal(swap().next, 'send');
  assert.equal(reviewSwap(swap(), quote(), wallet, config, 1188n).length, 2);
  assert.equal(swap().signatures.length, 0);
  for (const next of [undefined, 'sign_permit', 'swap', 'requote', 'done']) {
    const s = swap();
    if (next === undefined) delete s.next; else s.next = next;
    assert.throws(() => reviewSwap(s, quote(), wallet, config, 1188n), refusal, String(next));
  }
});

test('quote next swap: only a quote that says to swap can continue', () => {
  assert.equal(quote().next, 'swap');
  assert.equal(reviewQuote(quote(), config, wallet), 1188n);
  for (const next of [undefined, 'stop', 'requote', 'fix_request', 'send']) {
    const q = quote();
    if (next === undefined) delete q.next; else q.next = next;
    assert.throws(() => reviewQuote(q, config, wallet), refusal, String(next));
  }
});

test('quote expiry is checked against the now argument, in seconds like reviewSwap', () => {
  const q = quote();
  const expiry = Math.floor(Date.parse(q.expiresAt) / 1000);
  assert.equal(reviewQuote(q, config, wallet, expiry - 60), 1188n);
  assert.throws(() => reviewQuote(q, config, wallet, expiry + 1), /expired/i);
});

test('the trade chain, not the payment chain, names the search and quote network', async () => {
  assert.equal(reviewQuote(quote(), testnetConfig, wallet), 1188n);
  const changed = quote(); changed.network = 'eip155:5042002';
  assert.throws(() => reviewQuote(changed, testnetConfig, wallet), /network/i);
  const { dependencies, calls } = workflow(testnetConfig);
  const api = dependencies.api;
  dependencies.api = async (operation, body) => {
    const response = await api(operation, body);
    return operation === 'search' ? { ...response, network: 'eip155:5042002' } : response;
  };
  await assert.rejects(runFlow('quote', dependencies), /network/i);
  assert.deepEqual(calls.map(x => x.operation), ['search']);
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

function workflow(cfg = config) {
  const calls = [], sent = [];
  let delivered = false;
  const q = quote(), s = swap(undefined, cfg);
  const receiptRequests = [];
  return { calls, sent, receiptRequests, q, dependencies: { wallet, config: cfg, log: () => {},
    readReceipt: async request => { receiptRequests.push(request); return tradeReceipt(); },
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
  assert.equal(calls[1].body.taker, wallet.address);
  assert.equal(sent.length, 0);
});

test('trade sends approval then swap and verifies delivery against the quote floor', async () => {
  const { dependencies, sent, receiptRequests } = workflow();
  assert.equal((await runFlow('trade', dependencies)).delivered, 1200n);
  assert.deepEqual(sent.map(x => x.purpose), ['approve', 'swap']);
  assert.deepEqual(receiptRequests, [{ quoteId: quote().quoteId, txHashes: [hash, hash] }]);
});

test('failed approval stops execution before the swap', async () => {
  const { dependencies, sent } = workflow();
  dependencies.rpc.waitForTransactionReceipt = async () => ({ status: 'reverted', logs: [] });
  await assert.rejects(runFlow('trade', dependencies), /reverted/);
  assert.equal(sent.length, 1);
});

test('unready, stop and non-executable quotes never reach swap construction or Circle sending', async () => {
  for (const mutate of [
    q => { q.readiness.ready = false; q.readiness.gas.enough = false; },
    q => { q.next = 'stop'; },
    q => { q.best.executable = false; },
    q => { q.readiness.taker = other; },
  ]) {
    const { dependencies, q, sent, calls } = workflow();
    mutate(q);
    await assert.rejects(runFlow('trade', dependencies), /readiness|stop|another wallet/);
    assert.deepEqual(calls.map(x => x.operation), ['search', 'quote']);
    assert.equal(sent.length, 0);
  }
});

test('an actionable swap response cannot be broadcast even with empty signatures', () => {
  const s = swap(); s.next = 'sign_permit';
  assert.throws(() => reviewSwap(s, quote(), wallet, config, 1188n), /another action/);
});

test('receipt pending, failure and lookup errors never resubmit a mined trade', async () => {
  for (const result of ['pending', 'fail', 'unavailable']) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => {
      if (result === 'unavailable') throw new Error('HTTP 503');
      return { ...tradeReceipt(), result, delivered: null, reason: 'Inspect the transaction', next: result === 'pending' ? 'retry' : 'stop' };
    };
    await assert.rejects(runFlow('trade', dependencies), /already mined.*Do not rerun the trade/);
    assert.equal(sent.length, 2);
  }
});

test('a passing API receipt must match the original order and locally verified delivery', async () => {
  for (const change of [{ recipient: other }, { token: other }, { delivered: '1199' }, { minAmountOut: '1187' }]) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => ({ ...tradeReceipt(), ...change });
    await assert.rejects(runFlow('trade', dependencies), /differs from the locally verified fill/);
    assert.equal(sent.length, 2);
  }
});

test('a passing API receipt must match the verified fill and report next done', async () => {
  assert.equal(tradeReceipt().next, 'done');
  for (const next of [undefined, 'retry', 'stop', 'requote', 'swap']) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => {
      const receipt = tradeReceipt();
      if (next === undefined) delete receipt.next; else receipt.next = next;
      return receipt;
    };
    await assert.rejects(runFlow('trade', dependencies), /differs from the locally verified fill/, String(next));
    assert.equal(sent.length, 2);
  }
});

test('testnet row broadcasts on the fork', async () => {
  assert.equal(testnetConfig.broadcast, 'fork');
  assert.equal(config.broadcast, 'circle');
  const { dependencies, sent, receiptRequests } = workflow(testnetConfig);
  const result = await runFlow('trade', dependencies);
  assert.equal(result.delivered, 1200n);
  // The injected send is the only broadcast path runFlow has; the approval goes to USDC and the swap to the testnet router.
  assert.deepEqual(sent.map(x => x.purpose), ['approve', 'swap']);
  assert.equal(sent[1].to, testnetConfig.router);
  assert.notEqual(testnetConfig.router, config.router);
  assert.deepEqual(receiptRequests, [{ quoteId: quote().quoteId, txHashes: [hash, hash] }]);
  // A swap built for the mainnet router is refused on the testnet row before anything is sent.
  const mainnetBuilt = workflow(testnetConfig);
  mainnetBuilt.dependencies.api = async (operation, body) => operation === 'search'
    ? { network: 'eip155:5042', resolution: 'verified', results: [{ address: config.buyToken, symbol: 'cirBTC', verification: { status: 'verified' }, flags: [] }] }
    : operation === 'quote' ? mainnetBuilt.q : swap(undefined, config);
  await assert.rejects(runFlow('trade', mainnetBuilt.dependencies));
  assert.equal(mainnetBuilt.sent.length, 0);
});
