import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatTransactionReceipt, getAddress } from 'viem';
import { forNetwork, loadConfig } from '../src/config.js';
import { runFlow } from '../src/flow.js';
import { pickToken, reviewPermit, reviewQuote, reviewSwap } from '../src/guards.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// Bodies captured from `npm run preview` against the arcgate localnet (see fixtures/localnet-run.json). Nothing here is hand-written.
const run = JSON.parse(readFileSync(new URL('./fixtures/localnet-run.json', import.meta.url), 'utf8'));
const row = forNetwork(loadConfig({}), 'eip155:5042002', { ARCGATE_PAY_TO: run.search.unpaid.paymentRequired.accepts[0].payTo });
const wallet = { address: getAddress(run.taker) };
const clone = () => ({ search: structuredClone(run.search.paid.body), quote: structuredClone(run.quote.paid.body), swap: structuredClone(run.swap.paid.body) });
// Expiries and deadlines in a capture are only valid at the moment it was taken.
const pinned = t => { t.mock.timers.enable({ apis: ['Date'], now: Date.parse(run.capturedAt) }); return Math.floor(Date.parse(run.capturedAt) / 1000); };

test('the captured localnet search, quote and first swap pass every guard on the Arc testnet row', t => {
  const now = pinned(t), { search, quote, swap } = clone();
  assert.equal(pickToken(search, row).symbol, 'cirBTC');
  assert.equal(quote.next, 'swap'); // local HEAD says swap; the deployed API omits it
  const minimum = reviewQuote(quote, row);
  assert.equal(minimum, BigInt(quote.best.amountOutRaw) * 99n / 100n);
  assert.equal(swap.next, 'sign_permit');
  const typedData = swap.signatures[0].typedData;
  assert.equal(typedData.domain.chainId, row.tradeChainId); // Permit2 is on Arc mainnet even where the API pays on Arc testnet
  assert.equal(reviewPermit(typedData, row, now).details.amount, '500000');
  assert.deepEqual(reviewSwap(swap, quote, wallet, row, minimum, null, now).map(tx => tx.purpose), ['swap']);
});

test('the captured bodies are refused once the API says otherwise or a field is changed', t => {
  const now = pinned(t), { quote } = clone();
  const refuses = (change, review) => { const copy = clone(); change(copy); assert.throws(() => review(copy)); };
  refuses(({ quote }) => { quote.best.executable = false; }, ({ quote }) => reviewQuote(quote, row));
  refuses(({ quote }) => { quote.next = 'requote'; }, ({ quote }) => reviewQuote(quote, row));
  refuses(({ search }) => { search.network = 'eip155:5042002'; }, ({ search }) => pickToken(search, row));
  refuses(({ swap }) => { swap.next = 'stop'; }, ({ swap }) => reviewSwap(swap, quote, wallet, row, 590n, null, now));
  refuses(({ swap }) => { swap.signatures[0].typedData.message.details.amount = '500001'; }, ({ swap }) => reviewSwap(swap, quote, wallet, row, 590n, null, now));
  refuses(({ swap }) => { swap.transactions[0].to = wallet.address; }, ({ swap }) => reviewSwap(swap, quote, wallet, row, 590n, null, now));
  assert.equal(reviewQuote(quote, row), 590n); // the unchanged capture still passes
});

// The same, for production (603c5f1): captured from `npm run preview` on Arc mainnet, where the deployed API omits `next` on a quote.
const production = JSON.parse(readFileSync(new URL('./fixtures/mainnet-run.json', import.meta.url), 'utf8'));

test('the captured production quote and first swap pass every guard on the Arc mainnet row', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(production.capturedAt) });
  const now = Math.floor(Date.parse(production.capturedAt) / 1000);
  const mainnet = forNetwork(loadConfig({}), 'eip155:5042', {});
  const { search, quote, swap } = structuredClone({ search: production.search.paid.body, quote: production.quote.paid.body, swap: production.swap.paid.body });
  assert.equal(production.search.unpaid.paymentRequired.accepts[0].payTo, mainnet.payTo); // the pinned payee is what production asks for
  assert.equal(quote.next, undefined);
  assert.equal(pickToken(search, mainnet).symbol, 'cirBTC');
  const minimum = reviewQuote(quote, mainnet);
  assert.equal(swap.next, 'sign_permit');
  assert.deepEqual(reviewSwap(swap, quote, { address: getAddress(production.taker) }, mainnet, minimum, null, now).map(tx => tx.purpose), ['swap']);
  quote.next = 'stop'; // the same capture, with the API telling the caller to stop
  assert.throws(() => reviewQuote(quote, mainnet));
});

// The Beast Mode trade, captured from `npm run trade -- --execute` on Arc mainnet (fixtures/mainnet-trade.json). The capture is read
// inside the test, so a missing file fails this test alone. The wallet and the RPC answer with what the capture recorded.
test('the captured mainnet trade passes runFlow(trade) offline', async t => {
  const trade = JSON.parse(readFileSync(new URL('./fixtures/mainnet-trade.json', import.meta.url), 'utf8'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(trade.capturedAt) });
  const mainnet = forNetwork(loadConfig({}), 'eip155:5042', {});
  const taker = getAddress(trade.taker), hashes = trade.receipt.request.txHashes, permit = trade.swapTx.request.permit;
  const steps = [['search', trade.search.request, trade.search.paid.body], ['quote', trade.quote.request, trade.quote.paid.body],
    ['swap', trade.swap.request, trade.swap.paid.body], ['swap/tx', trade.swapTx.request, trade.swapTx.body], ['receipt', trade.receipt.request, trade.receipt.body]];
  const minimum = reviewQuote(structuredClone(trade.quote.paid.body), mainnet);

  const served = [], sequence = [], sent = [];
  // Serves the capture in order. Each request body must be exactly the one the capture recorded.
  const api = async (operation, body) => {
    const [expected, request, response] = steps[served.length] ?? [];
    assert.equal(operation, expected, `call ${served.length + 1} is ${expected}`);
    assert.deepEqual(body, request, `${operation} request body`);
    served.push(operation);
    if (['swap/tx', 'receipt'].includes(operation)) sequence.push(operation);
    return structuredClone(response);
  };
  const wallet = { address: taker,
    decode: async () => { sequence.push('decode'); },
    signTypedData: async () => { sequence.push('sign'); return permit.signature; },
    send: async tx => { sent.push(tx); sequence.push(`send ${tx.purpose}`); return hashes[sent.length - 1]; } };

  // eth_call balanceOf(taker) and eth_getTransactionReceipt results, as the mainnet RPC returned them during the capture.
  const balances = {};
  for (const { method, params, result } of trade.rpc) {
    const call = params?.[0], data = call?.data ?? call?.input;
    if (method === 'eth_call' && data?.startsWith('0x70a08231') && data.toLowerCase().endsWith(taker.slice(2).toLowerCase())) (balances[call.to.toLowerCase()] ??= []).push(BigInt(result));
  }
  const rpc = {
    readContract: async ({ address, functionName, args }) => {
      assert.equal(functionName, 'balanceOf'); assert.deepEqual(args, [taker]);
      const read = balances[address.toLowerCase()]?.shift();
      assert(read !== undefined, `no captured balanceOf for ${address}`);
      return read;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      const raw = trade.rpc.find(call => call.method === 'eth_getTransactionReceipt' && call.result?.transactionHash.toLowerCase() === hash.toLowerCase())?.result;
      assert(raw, `no captured receipt for ${hash}`);
      return formatTransactionReceipt(raw);
    },
  };

  const result = await runFlow('trade', { wallet, config: mainnet, api, rpc, log: () => {}, sleep: async () => { throw new Error('the captured receipt is already pass'); } });

  assert.deepEqual(served, steps.map(([operation]) => operation));
  // The captured approval (if the capture needed one) goes first, then the transactions the free /swap/tx round returned.
  const transactions = [...trade.swap.paid.body.transactions.filter(tx => tx.purpose === 'approve'), ...trade.swapTx.body.transactions];
  assert.deepEqual(sent, transactions);
  assert.deepEqual(sequence, ['decode', 'sign', ...transactions.slice(0, transactions.length - trade.swapTx.body.transactions.length).map(tx => `send ${tx.purpose}`),
    'swap/tx', 'decode', ...trade.swapTx.body.transactions.map(tx => `send ${tx.purpose}`), 'receipt']);
  assert.equal(hashes.length, transactions.length);
  assert.equal(result.delivered, BigInt(trade.receipt.body.delivered));
  assert(result.delivered >= minimum, `delivered ${result.delivered} is below the quote minimum ${minimum}`);
  assert.equal(result.receipt.result, 'pass');
  assert.deepEqual(result.receipt, trade.receipt.body);
});
