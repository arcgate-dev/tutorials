import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { loadConfig, requireApiKey } from '../src/config.js';
import { runFlow } from '../src/flow.js';
import { pickToken, reviewQuote, reviewSwap } from '../src/guards.js';
import * as app from '../src/main.js';
import { USDC } from '../src/payment.js';
import { approveHash, config, delivered, minOut, now, other, pinTime, quote, run, search, swap, swapArgs, swapHash, testnetConfig, tradeReceipt, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// A guard refusal is a plain Error from the guard itself, not a TypeError from reading a missing field.
const refusal = error => error.constructor === Error;

test('configuration pins public mainnet, small payments and a small trade', () => {
  assert.equal(config.apiUrl, 'https://api.arcgate.dev');
  assert.equal(config.paymentChainId, 5042);
  assert.equal(config.broadcast, 'circle');
  assert.equal(config.maxTotal, 25000n);
  for (const env of [{ SELL_AMOUNT: '1.1' }, { SELL_AMOUNT: '-1' }, { SELL_AMOUNT: '0.0000001' }, { API_URL: 'http://example.com' }, { API_URL: 'https://name:password@example.com' }]) assert.throws(() => loadConfig(env));
  assert.throws(() => requireApiKey(config, { CIRCLE_API_KEY: 'TEST_API_KEY:example' }), /LIVE_API_KEY/);
});

test('trade requires explicit execution before loading credentials or paying', async () => {
  await assert.rejects(app.main(['trade']), /--execute/);
});

test('search rejects ambiguous resolution, impostors and unverified tokens', () => {
  assert.equal(getAddress(pickToken(search(), testnetConfig).address), testnetConfig.buyToken);
  for (const mutate of [
    value => { value.resolution = 'ambiguous'; }, // override: the API is not sure which token was meant
    value => { value.results[0].address = other; }, // override: the first result is some other token
    value => { value.results[0].flags = ['impersonates_canonical']; }, // override: the token carries a risk flag
    value => { value.results[0].verification.status = 'unverified'; }, // override: the token is not on a verified list
  ]) {
    const value = search(); mutate(value); assert.throws(() => pickToken(value, testnetConfig), refusal);
  }
});

test('search network is compared with the row trade network, not a literal', () => {
  assert.equal(search().network, testnetConfig.tradeNetwork);
  assert.equal(getAddress(pickToken(search(), testnetConfig).address), testnetConfig.buyToken);
  // Override: the search is answered on the payment network instead of the trade network.
  const onPayment = search(); onPayment.network = testnetConfig.network;
  assert.equal(onPayment.network, 'eip155:5042002');
  assert.throws(() => pickToken(onPayment, testnetConfig), /another network/);
  // Override: a row whose trade network is not eip155:5042 accepts the search that names it and refuses the one that names eip155:5042.
  const row = { ...testnetConfig, tradeNetwork: 'eip155:777' };
  const onRow = search(); onRow.network = row.tradeNetwork;
  assert.equal(getAddress(pickToken(onRow, row).address), row.buyToken);
  assert.throws(() => pickToken(search(), row), /another network/);
});

test('swap next send: only a swap that says to send can be broadcast', () => {
  assert.equal(swap().next, 'send');
  assert.equal(reviewSwap(swap(), quote(), wallet, testnetConfig, minOut, now).length, 2);
  assert.equal(swap().signatures.length, 0);
  for (const next of [undefined, 'sign_permit', 'swap', 'requote', 'done']) {
    const s = swap();
    if (next === undefined) delete s.next; else s.next = next; // override: the swap names another action, or none
    assert.throws(() => reviewSwap(s, quote(), wallet, testnetConfig, minOut, now), refusal, String(next));
  }
});

test('quote next swap: only a quote that says to swap can continue', () => {
  assert.equal(quote().next, 'swap');
  assert.equal(reviewQuote(quote(), testnetConfig, wallet, now), minOut);
  for (const next of [undefined, 'stop', 'requote', 'fix_request', 'send']) {
    const q = quote();
    if (next === undefined) delete q.next; else q.next = next; // override: the quote names another action, or none
    assert.throws(() => reviewQuote(q, testnetConfig, wallet, now), refusal, String(next));
  }
});

test('quote expiry is checked against the now argument, in seconds like reviewSwap', () => {
  const q = quote();
  const expiry = Math.floor(Date.parse(q.expiresAt) / 1000);
  assert.equal(reviewQuote(q, testnetConfig, wallet, expiry - 60), minOut);
  assert.throws(() => reviewQuote(q, testnetConfig, wallet, expiry + 1), /expired/i);
});

test('the trade chain, not the payment chain, names the search and quote network', async t => {
  pinTime(t);
  assert.equal(reviewQuote(quote(), testnetConfig, wallet, now), minOut);
  const changed = quote(); changed.network = 'eip155:5042002'; // override: the quote names the payment network
  assert.throws(() => reviewQuote(changed, testnetConfig, wallet, now), /network/i);
  const { dependencies, calls } = workflow(testnetConfig);
  const api = dependencies.api;
  dependencies.api = async (operation, body) => {
    const response = await api(operation, body);
    if (operation === 'search') response.network = 'eip155:5042002'; // override: the search names the payment network
    return response;
  };
  await assert.rejects(runFlow('quote', dependencies), /network/i);
  assert.deepEqual(calls.map(x => x.operation), ['search']);
});

test('quote uses sell.amountRaw and preserves the original minimum', () => {
  assert.equal(reviewQuote(quote(), testnetConfig, wallet, now), minOut);
  const changed = quote(); changed.sell.amountRaw = '2000000'; // override: the quote sells twice the request
  assert.throws(() => reviewQuote(changed, testnetConfig, wallet, now), /sell amount/);
  const unsafe = quote(); unsafe.safety.verdict = 'cannot_sell'; // override: the quote cannot be sold back
  assert.throws(() => reviewQuote(unsafe, testnetConfig, wallet, now), /safety/);
});

test('decode complete batch before any send; refuse changed order and output floor', () => {
  assert.equal(reviewSwap(swap(), quote(), wallet, testnetConfig, minOut, now).length, 2);
  // Each override mutates one decoded argument of the captured swap call and re-encodes it.
  for (const [index, value] of [[1, 2_000_000n], [2, other], [3, minOut - 1n], [4, other], [5, 0n], [5, BigInt(now) + 631n]]) {
    const args = swapArgs(); args[index] = value;
    assert.throws(() => reviewSwap(swap(args), quote(), wallet, testnetConfig, minOut, now), /Decoded swap does not match/, `${index}`);
  }
  const redirected = swap(); redirected.transactions[1].to = other; // override: the swap goes to another contract
  assert.throws(() => reviewSwap(redirected, quote(), wallet, testnetConfig, minOut, now));
  // Override: the approval allows the largest amount instead of the sell amount.
  const tooMuch = swap(); tooMuch.transactions[0].data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [testnetConfig.router, 2n ** 256n - 1n] });
  assert.throws(() => reviewSwap(tooMuch, quote(), wallet, testnetConfig, minOut, now), /exact sell amount/);
  const reordered = swap(); reordered.transactions.reverse(); // override: the swap comes before its approval
  assert.throws(() => reviewSwap(reordered, quote(), wallet, testnetConfig, minOut, now), /followed by/);
});

test('the mainnet row accepts the captured trade re-pointed at its router and refuses the localnet router', () => {
  assert.notEqual(config.router, testnetConfig.router);
  // Override: swap(undefined, config) re-encodes the captured approval and swap target for the mainnet router.
  assert.equal(reviewSwap(swap(undefined, config), quote(), wallet, config, minOut, now).length, 2);
  assert.throws(() => reviewSwap(swap(), quote(), wallet, config, minOut, now), /configured router/);
  assert.equal(reviewQuote(quote(), config, wallet, now), minOut);
});

test('native-funded swaps require 18-decimal value and native pull mode', () => {
  const args = swapArgs(); args[7].mode = 2; // override: the swap pulls native USDC
  const native = swap(args); native.transactions.shift(); native.transactions[0].value = '1000000000000000000';
  assert.match(reviewSwap(native, quote(), wallet, testnetConfig, minOut, now)[0].funding, /native/);
  native.transactions[0].value = '1000000'; // override: a 6-decimal value on a native pull
  assert.throws(() => reviewSwap(native, quote(), wallet, testnetConfig, minOut, now), /native value/);
});

function workflow(cfg = testnetConfig) {
  const calls = [], sent = [];
  let landed = false;
  const q = quote(), s = swap(undefined, cfg);
  const hashes = { approve: approveHash, swap: swapHash };
  const receiptRequests = [];
  return { calls, sent, receiptRequests, q, dependencies: { wallet, config: cfg, log: () => {},
    readReceipt: async request => { receiptRequests.push(request); return tradeReceipt(); },
    api: async (operation, body) => {
      calls.push({ operation, body });
      if (operation === 'search') return search();
      if (operation === 'quote') return q;
      assert.equal(body.approval, 'approve'); assert.equal(body.taker, wallet.address);
      return s;
    },
    rpc: { readContract: async ({ address }) => address === USDC ? BigInt(q.readiness.balance.available) : landed ? delivered : 0n,
      waitForTransactionReceipt: async () => {
        if (sent.length === 1) return { status: 'success', logs: [] };
        landed = true;
        return { status: 'success', logs: [{ address: cfg.buyToken,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: cfg.router, to: wallet.address } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [delivered]),
        }] };
      } },
    send: async tx => { sent.push(tx); return hashes[tx.purpose]; },
  } };
}

test('preview runs public request flow without submitting any transaction', async t => {
  pinTime(t);
  const { dependencies, sent, calls } = workflow();
  await runFlow('preview', dependencies);
  assert.deepEqual(calls.map(x => x.operation), ['search', 'quote', 'swap']);
  assert.equal(calls[1].body.taker, wallet.address);
  assert.equal(sent.length, 0);
});

test('trade sends approval then swap and verifies delivery against the quote floor', async t => {
  pinTime(t);
  const { dependencies, sent, receiptRequests } = workflow();
  assert.equal((await runFlow('trade', dependencies)).delivered, delivered);
  assert.deepEqual(sent.map(x => x.purpose), ['approve', 'swap']);
  assert.deepEqual(receiptRequests, [run.run.receipt.request]);
});

test('failed approval stops execution before the swap', async t => {
  pinTime(t);
  const { dependencies, sent } = workflow();
  dependencies.rpc.waitForTransactionReceipt = async () => ({ status: 'reverted', logs: [] });
  await assert.rejects(runFlow('trade', dependencies), /reverted/);
  assert.equal(sent.length, 1);
});

test('unready, stop and non-executable quotes never reach swap construction or Circle sending', async t => {
  pinTime(t);
  for (const mutate of [
    q => { q.readiness.ready = false; q.readiness.gas.enough = false; }, // override: the wallet cannot cover gas
    q => { q.next = 'stop'; }, // override: the quote says stop
    q => { q.best.executable = false; }, // override: no executable route
    q => { q.readiness.taker = other; }, // override: readiness is for another wallet
  ]) {
    const { dependencies, q, sent, calls } = workflow();
    mutate(q);
    await assert.rejects(runFlow('trade', dependencies), /readiness|stop|another wallet/);
    assert.deepEqual(calls.map(x => x.operation), ['search', 'quote']);
    assert.equal(sent.length, 0);
  }
});

test('an actionable swap response cannot be broadcast even with empty signatures', () => {
  const s = swap(); s.next = 'sign_permit'; // override: the swap still needs a permit signature
  assert.throws(() => reviewSwap(s, quote(), wallet, testnetConfig, minOut, now), /another action/);
});

test('receipt pending, failure and lookup errors never resubmit a mined trade', async t => {
  pinTime(t);
  for (const result of ['pending', 'fail', 'unavailable']) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => {
      if (result === 'unavailable') throw new Error('HTTP 503');
      // Override: the receipt is not a pass, reports no delivery, and names the next action for that result.
      return Object.assign(tradeReceipt(), { result, delivered: null, reason: 'Inspect the transaction', next: result === 'pending' ? 'retry' : 'stop' });
    };
    await assert.rejects(runFlow('trade', dependencies), /already mined.*Do not rerun the trade/);
    assert.equal(sent.length, 2);
  }
});

test('a passing API receipt must match the original order and locally verified delivery', async t => {
  pinTime(t);
  // Each override changes one field of the captured pass receipt.
  for (const change of [{ recipient: other }, { token: other }, { delivered: String(delivered - 1n) }, { minAmountOut: String(minOut - 1n) }]) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => Object.assign(tradeReceipt(), change);
    await assert.rejects(runFlow('trade', dependencies), /differs from the locally verified fill/);
    assert.equal(sent.length, 2);
  }
});

test('a passing API receipt must match the verified fill and report next done', async t => {
  pinTime(t);
  assert.equal(tradeReceipt().next, 'done');
  for (const next of [undefined, 'retry', 'stop', 'requote', 'swap']) {
    const { dependencies, sent } = workflow();
    dependencies.readReceipt = async () => {
      const receipt = tradeReceipt();
      if (next === undefined) delete receipt.next; else receipt.next = next; // override: the pass receipt names another action, or none
      return receipt;
    };
    await assert.rejects(runFlow('trade', dependencies), /differs from the locally verified fill/, String(next));
    assert.equal(sent.length, 2);
  }
});

test('testnet row broadcasts on the fork', async t => {
  pinTime(t);
  assert.equal(testnetConfig.broadcast, 'fork');
  assert.equal(config.broadcast, 'circle');
  const { dependencies, sent, receiptRequests } = workflow(testnetConfig);
  const result = await runFlow('trade', dependencies);
  assert.equal(result.delivered, delivered);
  // The injected send is the only broadcast path runFlow has; the approval goes to USDC and the swap to the testnet router.
  assert.deepEqual(sent.map(x => x.purpose), ['approve', 'swap']);
  assert.equal(getAddress(sent[1].to), testnetConfig.router);
  assert.notEqual(testnetConfig.router, config.router);
  assert.deepEqual(receiptRequests, [run.run.receipt.request]);
  // A swap built for the mainnet router is refused on the testnet row before anything is sent.
  const mainnetBuilt = workflow(testnetConfig);
  mainnetBuilt.dependencies.api = async operation => operation === 'search' ? search()
    : operation === 'quote' ? mainnetBuilt.q : swap(undefined, config); // override: the swap targets the mainnet router
  await assert.rejects(runFlow('trade', mainnetBuilt.dependencies));
  assert.equal(mainnetBuilt.sent.length, 0);
});

// An in-memory EIP-1193 anvil node answering what sendOnFork asks, as in fork.test.js. No socket is opened.
function forkNode(tx) {
  const calls = [];
  const receipt = { transactionHash: approveHash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', transactionIndex: '0x0',
    from: wallet.address, to: tx.to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [],
    logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2', contractAddress: null };
  const request = async ({ method, params = [] }) => {
    calls.push({ method, params });
    switch (method) {
      case 'anvil_nodeInfo': return { currentBlockNumber: '0x1', environment: { chainId: 5042 } };
      case 'eth_chainId': return '0x13b2';
      case 'anvil_impersonateAccount': case 'anvil_stopImpersonatingAccount': return null;
      case 'eth_sendTransaction': return approveHash;
      case 'eth_blockNumber': return '0x1';
      case 'eth_getTransactionByHash': return { hash: approveHash, blockNumber: '0x1', blockHash: receipt.blockHash, from: wallet.address, to: tx.to, input: tx.data,
        value: '0x0', gas: '0x7a120', nonce: '0x0', transactionIndex: '0x0', type: '0x2', gasPrice: '0x1', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' };
      case 'eth_getTransactionReceipt': return receipt;
      case 'eth_getBlockByNumber': return { number: '0x1', hash: receipt.blockHash, timestamp: '0x1', transactions: [approveHash] };
      default: throw new Error(`Unexpected RPC method ${method}`);
    }
  };
  return { calls, request, named: method => calls.filter(call => call.method === method) };
}
const lower = value => String(value).toLowerCase();

test('broadcast sender follows the network row', async () => {
  const approve = swap().transactions[0];

  // Testnet row: impersonate the Circle wallet's address on the fork; Circle is never called.
  const fork = forkNode(approve);
  const circleCalls = [];
  const forbidden = name => async () => { circleCalls.push(name); throw new Error(`Circle ${name} must not be called on the fork row.`); };
  const forbiddenCircle = { createContractExecutionTransaction: forbidden('createContractExecutionTransaction'),
    getTransaction: forbidden('getTransaction'), signTypedData: forbidden('signTypedData') };
  const sendOnFork = app.broadcaster(testnetConfig, { circle: forbiddenCircle, wallet, record: () => {}, forkRequest: fork.request });
  assert.equal(await sendOnFork(approve, 'key-fork'), approveHash);
  assert.deepEqual(fork.named('anvil_impersonateAccount').map(call => call.params.map(lower)), [[lower(wallet.address)]]);
  assert.equal(fork.named('eth_sendTransaction').length, 1);
  const sent = fork.named('eth_sendTransaction')[0].params[0];
  assert.equal(lower(sent.from), lower(wallet.address));
  assert.equal(lower(sent.to), lower(approve.to));
  assert.equal(sent.data, approve.data);
  assert.equal(BigInt(sent.gas), BigInt(approve.gas));
  assert.deepEqual(circleCalls, []);

  // Mainnet row: Circle signs and broadcasts; the fork is never touched.
  const idle = forkNode(approve);
  const requests = [];
  const circle = {
    createContractExecutionTransaction: async request => { requests.push(request); return { data: { id: 'circle-tx' } }; },
    getTransaction: async () => ({ data: { transaction: { state: 'COMPLETE', txHash: approveHash } } }),
  };
  const sendOnCircle = app.broadcaster(config, { circle, wallet, record: () => {}, forkRequest: idle.request });
  assert.equal(await sendOnCircle(approve, 'key-circle'), approveHash);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].walletId, wallet.id);
  assert.equal(requests[0].contractAddress, approve.to);
  assert.equal(requests[0].callData, approve.data);
  assert.equal(requests[0].idempotencyKey, 'key-circle');
  assert.deepEqual(idle.calls, []);
});
