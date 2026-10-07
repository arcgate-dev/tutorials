import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { forNetwork, loadConfig } from '../src/config.js';
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
