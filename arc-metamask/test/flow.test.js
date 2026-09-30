import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import { runFlow } from '../src/flow.js';
import { USDC } from '../src/payment.js';
import { account, config, hash, quote, swap, tradeReceipt, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

function workflow() {
  const calls = [], sent = [], sequence = [];
  let delivered = false;
  const q = quote(), first = swap(), typedData = first.signatures[0].typedData, receipts = [tradeReceipt()];
  const dependencies = { config, log: () => {}, sleep: async () => { sequence.push('sleep'); }, wallet: { ...wallet,
    decode: async txs => { sequence.push('decode'); assert.equal(txs.at(-1).purpose, 'swap'); },
    signTypedData: async data => { sequence.push('sign'); return account.signTypedData(data); },
    send: async tx => { sent.push(tx); sequence.push(tx.purpose); return hash; },
  }, api: async (operation, body) => {
    calls.push({ operation, body });
    if (operation === 'search') return { network: 'eip155:5042', resolution: 'verified', results: [{ address: config.buyToken, symbol: 'cirBTC', verification: { status: 'verified' }, flags: [] }] };
    if (operation === 'quote') { assert.deepEqual(body.venues, ['uniswap_v3']); return q; }
    if (operation === 'receipt') { sequence.push('receipt'); assert.deepEqual(body, { quoteId: q.quoteId, txHashes: sent.map(() => hash) }); return receipts.length > 1 ? receipts.shift() : receipts[0]; }
    if (operation === 'swap/tx') {
      sequence.push('final-api');
      assert.deepEqual(Object.keys(body).sort(), ['deadlineSec', 'permit', 'quoteId', 'recipient', 'taker']);
      assert.deepEqual(body.permit, { message: typedData.message, signature: body.permit.signature });
      assert.equal(sent.length, first.transactions.filter(tx => tx.purpose === 'approve').length);
      return swap({ typedData, signature: body.permit.signature });
    }
    assert.equal(operation, 'swap'); assert.equal(body.approval, 'permit2'); assert.equal(body.permit, undefined);
    return first;
  }, rpc: {
    readContract: async ({ address }) => address === USDC ? 3_000_000n : delivered ? 600n : 0n,
    waitForTransactionReceipt: async () => {
      if (sent.at(-1).purpose === 'approve') return { status: 'success', logs: [] };
      delivered = true;
      return { status: 'success', logs: [{ address: config.buyToken, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: config.router, to: wallet.address } }), data: encodeAbiParameters([{ type: 'uint256' }], [600n]) }] };
    },
  } };
  return { calls, sent, sequence, dependencies, first, q, receipts };
}

test('preview decodes the batch but never signs Permit2 or broadcasts', async () => {
  const w = workflow(); await runFlow('preview', w.dependencies);
  assert.deepEqual(w.calls.map(c => c.operation), ['search', 'quote', 'swap']);
  assert.deepEqual(w.sequence, ['decode']); assert.equal(w.sent.length, 0);
});

test('trade signs Permit2, sends approval, finishes on free /swap/tx, verifies delivery and the receipt', async () => {
  const w = workflow(), result = await runFlow('trade', w.dependencies);
  assert.equal(result.delivered, 600n);
  assert.equal(result.receipt.result, 'pass');
  assert.deepEqual(w.sequence, ['decode', 'sign', 'approve', 'final-api', 'decode', 'swap', 'receipt']);
  assert.deepEqual(w.calls.map(c => c.operation), ['search', 'quote', 'swap', 'swap/tx', 'receipt']);
});

test('existing ERC-20 allowance still signs Permit2 and sends only the final swap', async () => {
  const w = workflow(); w.first.transactions.shift();
  assert.equal((await runFlow('trade', w.dependencies)).delivered, 600n);
  assert.deepEqual(w.sequence, ['decode', 'sign', 'final-api', 'decode', 'swap', 'receipt']);
});

test('a pending receipt is asked again, a few seconds apart, until it answers', async () => {
  const w = workflow(); w.receipts.unshift({ ...tradeReceipt(), result: 'pending', delivered: null, reason: 'not indexed yet' });
  assert.equal((await runFlow('trade', w.dependencies)).receipt.result, 'pass');
  assert.deepEqual(w.sequence.slice(-3), ['receipt', 'sleep', 'receipt']);
});

test('a failed or disagreeing receipt is reported, never a reason to trade again', async () => {
  for (const change of [{ result: 'fail', reason: 'reverted', next: 'stop' }, { delivered: '599' }, { minAmountOut: '1' }]) {
    const w = workflow(); w.receipts[0] = { ...tradeReceipt(), ...change };
    await assert.rejects(runFlow('trade', w.dependencies), /do not rerun the trade/i);
    assert.deepEqual(w.calls.filter(c => c.operation === 'swap').length, 1);
  }
});

test('failed approval stops before another paid swap call or transaction', async () => {
  const w = workflow(); w.dependencies.rpc.waitForTransactionReceipt = async () => ({ status: 'reverted', logs: [] });
  await assert.rejects(runFlow('trade', w.dependencies), /reverted/);
  assert.equal(w.calls.length, 3); assert.equal(w.sent.length, 1);
});

test('missing fresh permit refuses execution instead of sending the placeholder', async () => {
  const w = workflow(); w.first.signatures = [];
  await assert.rejects(runFlow('trade', w.dependencies), /fresh Permit2/);
  assert.equal(w.sent.length, 0);
});

test('quote expiring while approval waits stops before spending another API fee', async () => {
  const w = workflow(); w.dependencies.rpc.waitForTransactionReceipt = async () => { w.q.expiresAt = new Date(0).toISOString(); return { status: 'success', logs: [] }; };
  await assert.rejects(runFlow('trade', w.dependencies), /expired/);
  assert.equal(w.calls.length, 3); assert.equal(w.sent.length, 1);
});

test('lower output delivery is not reported as a successful trade', async () => {
  const w = workflow(); w.dependencies.rpc.readContract = async ({ address }) => address === USDC ? 3000000n : 0n;
  await assert.rejects(runFlow('trade', w.dependencies), /delivery/);
});
