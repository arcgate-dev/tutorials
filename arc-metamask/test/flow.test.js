import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import { runFlow } from '../src/flow.js';
import { USDC } from '../src/payment.js';
import { account, config, finalSwap, hash, pinTime, quote, search, swap, tradeReceipt, trader } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// The captured first swap needs no approval (that wallet already held an allowance), so the approval path is the one variant (`approval`).
function workflow({ approval = true } = {}) {
  const calls = [], sent = [], sequence = [];
  let delivered = false;
  const delivery = BigInt(tradeReceipt().delivered); // the receipt's own number, at least the quote minimum
  const q = quote(), first = swap({ approval }), typedData = first.signatures[0].typedData, receipts = [tradeReceipt()], finalPatch = {};
  const dependencies = { config, log: () => {}, sleep: async () => { sequence.push('sleep'); }, wallet: { ...trader,
    decode: async txs => { sequence.push('decode'); assert.equal(txs.at(-1).purpose, 'swap'); },
    signTypedData: async data => { sequence.push('sign'); return account.signTypedData(data); },
    send: async tx => { sent.push(tx); sequence.push(tx.purpose); return hash; },
  }, api: async (operation, body) => {
    calls.push({ operation, body });
    if (operation === 'search') return search();
    if (operation === 'quote') { assert.deepEqual(body.venues, ['uniswap_v3']); return q; }
    if (operation === 'receipt') { sequence.push('receipt'); assert.deepEqual(body, { quoteId: q.quoteId, txHashes: sent.map(() => hash) }); return receipts.length > 1 ? receipts.shift() : receipts[0]; }
    if (operation === 'swap/tx') {
      sequence.push('final-api');
      assert.deepEqual(Object.keys(body).sort(), ['deadlineSec', 'permit', 'quoteId', 'recipient', 'taker']);
      assert.deepEqual(body.permit, { message: typedData.message, signature: body.permit.signature });
      assert.equal(sent.length, first.transactions.filter(tx => tx.purpose === 'approve').length);
      return { ...finalSwap({ typedData, signature: body.permit.signature }), ...finalPatch };
    }
    assert.equal(operation, 'swap'); assert.equal(body.approval, 'permit2'); assert.equal(body.permit, undefined);
    return first;
  }, rpc: {
    readContract: async ({ address }) => address === USDC ? 3_000_000n : delivered ? delivery : 0n,
    waitForTransactionReceipt: async () => {
      if (sent.at(-1).purpose === 'approve') return { status: 'success', logs: [] };
      delivered = true;
      return { status: 'success', logs: [{ address: config.buyToken, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: config.router, to: trader.address } }), data: encodeAbiParameters([{ type: 'uint256' }], [delivery]) }] };
    },
  } };
  return { calls, sent, sequence, dependencies, first, q, receipts, finalPatch };
}

test('preview decodes the batch but never signs Permit2 or broadcasts', async t => { pinTime(t);
  const w = workflow(); await runFlow('preview', w.dependencies);
  assert.deepEqual(w.calls.map(c => c.operation), ['search', 'quote', 'swap']);
  assert.deepEqual(w.sequence, ['decode']); assert.equal(w.sent.length, 0);
});

test('trade signs Permit2, sends approval, finishes on free /swap/tx, verifies delivery and the receipt', async t => { pinTime(t);
  const w = workflow(), result = await runFlow('trade', w.dependencies);
  assert.equal(result.delivered, BigInt(tradeReceipt().delivered));
  assert.equal(result.receipt.result, 'pass');
  assert.deepEqual(w.sequence, ['decode', 'sign', 'approve', 'final-api', 'decode', 'swap', 'receipt']);
  assert.deepEqual(w.calls.map(c => c.operation), ['search', 'quote', 'swap', 'swap/tx', 'receipt']);
});

test('existing ERC-20 allowance still signs Permit2 and sends only the final swap', async t => { pinTime(t);
  const w = workflow({ approval: false }); // as captured
  assert.equal((await runFlow('trade', w.dependencies)).delivered, BigInt(tradeReceipt().delivered));
  assert.deepEqual(w.sequence, ['decode', 'sign', 'final-api', 'decode', 'swap', 'receipt']);
});

test('a pending receipt is asked again, a few seconds apart, until it answers', async t => { pinTime(t);
  const w = workflow(); w.receipts.unshift({ ...tradeReceipt(), result: 'pending', delivered: null, reason: 'not indexed yet' });
  assert.equal((await runFlow('trade', w.dependencies)).receipt.result, 'pass');
  assert.deepEqual(w.sequence.slice(-3), ['receipt', 'sleep', 'receipt']);
});

test('a failed or disagreeing receipt is reported, never a reason to trade again', async t => { pinTime(t);
  for (const change of [{ result: 'fail', reason: 'reverted', next: 'stop' }, { delivered: String(BigInt(tradeReceipt().delivered) - 1n) }, { minAmountOut: '1' }]) {
    const w = workflow(); w.receipts[0] = { ...tradeReceipt(), ...change };
    await assert.rejects(runFlow('trade', w.dependencies), /do not rerun the trade/i);
    assert.deepEqual(w.calls.filter(c => c.operation === 'swap').length, 1);
  }
});

test('failed approval stops before another paid swap call or transaction', async t => { pinTime(t);
  const w = workflow(); w.dependencies.rpc.waitForTransactionReceipt = async () => ({ status: 'reverted', logs: [] });
  await assert.rejects(runFlow('trade', w.dependencies), /reverted/);
  assert.equal(w.calls.length, 3); assert.equal(w.sent.length, 1);
});

test('missing fresh permit refuses execution instead of sending the placeholder', async t => { pinTime(t);
  const w = workflow(); w.first.signatures = [];
  await assert.rejects(runFlow('trade', w.dependencies), /fresh Permit2/);
  assert.equal(w.sent.length, 0);
});

test('quote expiring while approval waits stops before spending another API fee', async t => { pinTime(t);
  const w = workflow(); w.dependencies.rpc.waitForTransactionReceipt = async () => { w.q.expiresAt = new Date(0).toISOString(); return { status: 'success', logs: [] }; };
  await assert.rejects(runFlow('trade', w.dependencies), /expired/);
  assert.equal(w.calls.length, 3); assert.equal(w.sent.length, 1);
});

test('lower output delivery is not reported as a successful trade', async t => { pinTime(t);
  const w = workflow(); w.dependencies.rpc.readContract = async ({ address }) => address === USDC ? 3_000_000n : 0n;
  await assert.rejects(runFlow('trade', w.dependencies), /delivery/);
});

test('a quote that is not executable or does not say swap is never swapped', async t => { pinTime(t);
  for (const change of [{ best: { ...quote().best, executable: false } }, { next: 'stop' }, { next: 'requote' }, { next: 'retry' }, { next: 'fix_request' }, { next: 'pay' }]) {
    const w = workflow(); Object.assign(w.q, change);
    await assert.rejects(runFlow('trade', w.dependencies), undefined, JSON.stringify(change));
    assert.deepEqual(w.calls.map(c => c.operation), ['search', 'quote']); assert.deepEqual(w.sequence, []);
  }
  for (const change of [{}, { next: 'swap' }]) { // deployed 603c5f1 omits next, local HEAD says swap
    const w = workflow(); Object.assign(w.q, change);
    assert.equal((await runFlow('quote', w.dependencies)).quote.quoteId, w.q.quoteId);
  }
});

test('search follows the row\'s trade network', async t => { pinTime(t);
  const w = workflow(), api = w.dependencies.api;
  w.dependencies.api = async (operation, body) => operation === 'search' ? { ...await api(operation, body), network: 'eip155:5042002' } : api(operation, body);
  await assert.rejects(runFlow('search', w.dependencies), /another network/);
  const elsewhere = workflow(); elsewhere.dependencies.config = { ...config, tradeNetwork: 'eip155:777' }; // a row whose trade network is not Arc mainnet
  await assert.rejects(runFlow('search', elsewhere.dependencies), /another network/);
});

test('a first swap response that does not say sign_permit is not signed', async t => { pinTime(t);
  for (const next of [undefined, 'send', 'done', 'stop', 'pay']) {
    const w = workflow(); if (next === undefined) delete w.first.next; else w.first.next = next;
    await assert.rejects(runFlow('trade', w.dependencies), undefined, String(next));
    assert.deepEqual(w.sequence, []); assert.equal(w.sent.length, 0);
  }
});

test('a final swap response must say send, or nothing, before anything is broadcast', async t => { pinTime(t);
  for (const next of ['sign_permit', 'done', 'stop', 'requote', 'retry', 'pay']) {
    const w = workflow(); w.finalPatch.next = next;
    await assert.rejects(runFlow('trade', w.dependencies), undefined, next);
    assert.deepEqual(w.sent.map(tx => tx.purpose), ['approve']); // only the approval, which came before the final round
    assert(!w.sequence.includes('swap'));
  }
  const w = workflow(); w.finalPatch.next = 'send';
  assert.equal((await runFlow('trade', w.dependencies)).receipt.result, 'pass');
});

test('a passing receipt must say done, or nothing', async t => { pinTime(t);
  for (const next of [undefined, 'done']) { // deployed 603c5f1 omits next on a pass, local HEAD says done
    const w = workflow(); w.receipts[0] = { ...tradeReceipt(), ...next && { next } };
    assert.equal((await runFlow('trade', w.dependencies)).receipt.result, 'pass', String(next));
  }
  for (const next of ['stop', 'retry', 'requote', 'sign_permit', 'send', 'pay']) {
    const w = workflow(); w.receipts[0] = { ...tradeReceipt(), next };
    await assert.rejects(runFlow('trade', w.dependencies), /do not rerun the trade/i, next);
  }
});
