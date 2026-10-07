import test from 'node:test';
import assert from 'node:assert/strict';
import { getReceipt } from '../src/receipt.js';
import { main } from '../src/main.js';
import { config, hash, tradeReceipt } from './fixtures.js';

process.env.PATH = ''; // Never let a test find the real `mm` on this machine.
globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('receipt is a plain free call and preserves pass, pending and fail answers', async () => {
  for (const result of ['pass', 'pending', 'fail']) {
    const receipt = { ...tradeReceipt(), result };
    const response = await getReceipt({ config, quoteId: receipt.quoteId, txHashes: [hash], fetchFn: async (url, init) => {
      assert.equal(url, `${config.apiUrl}/trade/v1/receipt`);
      assert.deepEqual(JSON.parse(init.body), { quoteId: receipt.quoteId, txHashes: [hash] });
      assert.equal(new Headers(init.headers).get('payment-signature'), null);
      assert.equal(init.redirect, 'error');
      return Response.json(receipt);
    } });
    assert.deepEqual(response, receipt);
  }
});

test('receipt refuses invalid IDs and hashes before network access', async () => {
  for (const input of [{ quoteId: 'old-quote', txHashes: [hash] }, { quoteId: tradeReceipt().quoteId, txHashes: ['polling-id'] },
    { quoteId: tradeReceipt().quoteId, txHashes: [] }, { quoteId: tradeReceipt().quoteId, txHashes: Array(5).fill(hash) }]) {
    await assert.rejects(getReceipt({ config, ...input }), /onchain hashes/);
  }
});

test('receipt errors never initiate payment or automatic retries', async () => {
  for (const status of [402, 429, 503]) {
    let calls = 0;
    await assert.rejects(getReceipt({ config, quoteId: tradeReceipt().quoteId, txHashes: [hash], fetchFn: async () => {
      calls++;
      return Response.json({ error: { code: 'receipt_unavailable' }, next: 'retry', retryAfterSec: 5 }, { status });
    } }), /No automatic retry/);
    assert.equal(calls, 1);
  }
});

test('receipt command works without mm', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(tradeReceipt()));
  t.mock.method(console, 'log', () => {});
  assert.deepEqual(await main(['receipt', tradeReceipt().quoteId, hash]), tradeReceipt());
});
