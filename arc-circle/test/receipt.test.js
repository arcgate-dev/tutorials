import test from 'node:test';
import assert from 'node:assert/strict';
import { getReceipt } from '../src/receipt.js';
import { main } from '../src/main.js';
import { approveHash, config, receiptCommand, swapHash, tradeReceipt } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('receipt is a plain free call and preserves pass, pending and fail answers', async () => {
  for (const result of ['pass', 'pending', 'fail']) {
    const receipt = Object.assign(tradeReceipt(), { result }); // override: the API answers pass, pending or fail
    const response = await getReceipt({ config, quoteId: receipt.quoteId, txHashes: [swapHash], fetchFn: async (url, init) => {
      assert.equal(url, `${config.apiUrl}/trade/v1/receipt`);
      assert.deepEqual(JSON.parse(init.body), { quoteId: receipt.quoteId, txHashes: [swapHash] });
      assert.equal(new Headers(init.headers).get('payment-signature'), null);
      assert.equal(init.redirect, 'error');
      return Response.json(receipt);
    } });
    assert.deepEqual(response, receipt);
  }
});

test('receipt refuses invalid IDs and hashes before network access', async () => {
  for (const input of [{ quoteId: 'old-quote', txHashes: [swapHash] }, { quoteId: tradeReceipt().quoteId, txHashes: ['circle-id'] },
    { quoteId: tradeReceipt().quoteId, txHashes: [] }, { quoteId: tradeReceipt().quoteId, txHashes: Array(5).fill(swapHash) }]) {
    await assert.rejects(getReceipt({ config, ...input }), /onchain hashes/);
  }
});

test('receipt errors never initiate payment or automatic retries', async () => {
  for (const status of [402, 429, 503]) {
    let calls = 0;
    await assert.rejects(getReceipt({ config, quoteId: tradeReceipt().quoteId, txHashes: [swapHash], fetchFn: async () => {
      calls++;
      return Response.json({ error: { code: 'receipt_unavailable' }, next: 'retry', retryAfterSec: 5 }, { status });
    } }), /No automatic retry/);
    assert.equal(calls, 1);
  }
});

test('receipt command works without Circle credentials', async t => {
  const { request, body } = receiptCommand();
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  t.mock.method(console, 'log', () => {});
  assert.deepEqual(await main(['receipt', request.quoteId, ...request.txHashes]), body);
  assert.deepEqual(request.txHashes, [approveHash, swapHash]);
});
