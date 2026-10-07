import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { loadConfig } from '../src/config.js';
import { reviewPermit, reviewQuote, reviewSwap } from '../src/guards.js';
import { main } from '../src/main.js';
import { account, config, other, permit, quote, swap, swapArgs, testnetConfig, wallet } from './fixtures.js';

process.env.PATH = ''; // Never let a test find the real `mm` on this machine.
globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('configuration pins public mainnet and caps orders and API spend', () => {
  assert.equal(config.amount, '0.50'); assert.equal(config.maxTotal, 25000n); assert.equal(config.paymentChainId, 5042); assert.equal(config.tradeChainId, 5042);
  for (const env of [{ SELL_AMOUNT: '1.1' }, { SELL_AMOUNT: '0' }, { SELL_AMOUNT: '0.0000001' }, { API_URL: 'http://example.com' }, { API_URL: 'https://name:secret@example.com' }]) assert.throws(() => loadConfig(env));
});

test('execution requires explicit flag before any wallet operation', async () => {
  await assert.rejects(main(['trade']), /--execute/);
});

test('quote preserves requested input and original output floor', () => {
  assert.equal(reviewQuote(quote(), config), 594n);
  const q = quote(); q.sell.amountRaw = '1000000';
  assert.throws(() => reviewQuote(q, config), /sell amount/);
});

test('Permit2 guard binds the schema, domain, amount, spender, nonce and lifetimes', () => {
  assert.equal(reviewPermit(permit(), config).details.amount, '500000');
  for (const mutate of [
    p => { p.domain.chainId = 1; }, p => { p.domain.verifyingContract = other; }, p => { p.domain.name = 'other'; },
    p => { p.message.spender = other; }, p => { p.message.details.token = other; }, p => { p.message.details.amount = '500001'; },
    p => { p.message.sigDeadline = '0'; }, p => { p.message.details.expiration = '9999999999'; }, p => { p.message.details.nonce = '-1'; },
    p => { p.types.PermitDetails[1].type = 'uint256'; },
  ]) { const p = permit(); mutate(p); assert.throws(() => reviewPermit(p, config)); }
});

test('batch guards refuse changed router, recipient, floor, amount, mode and approval spender', () => {
  assert.equal(reviewSwap(swap(), quote(), wallet, config, 594n).length, 2);
  for (const [index, value] of [[1, 500001n], [2, other], [3, 593n], [4, other], [5, 0n]]) {
    const args = swapArgs(); args[index] = value;
    assert.throws(() => reviewSwap(swap(null, args), quote(), wallet, config, 594n));
  }
  const s = swap(); s.transactions[0].data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [config.router, maxUint256] });
  assert.throws(() => reviewSwap(s, quote(), wallet, config, 594n), /Permit2/);
  const native = swap(); native.transactions[1].value = '500000000000000000';
  assert.throws(() => reviewSwap(native, quote(), wallet, config, 594n), /value/);
  const allowance = swap(); allowance.signatures = [];
  assert.throws(() => reviewSwap(allowance, quote(), wallet, config, 594n), /fresh Permit2/);
});

test('final calldata must contain precisely the permit and signature this wallet signed', async () => {
  const typedData = permit(), signature = await account.signTypedData(typedData), signed = { typedData, signature };
  assert.equal(reviewSwap(swap(signed), quote(), wallet, config, 594n, signed).length, 1);
  const args = swapArgs(signed); args[7].permit = structuredClone(args[7].permit); args[7].permit.details.amount = '500001';
  assert.throws(() => reviewSwap(swap(signed, args), quote(), wallet, config, 594n, signed), /Embedded permit/);
  const wrongSignature = swapArgs(signed); wrongSignature[7].signature = '0x1234';
  assert.throws(() => reviewSwap(swap(signed, wrongSignature), quote(), wallet, config, 594n, signed), /Embedded permit/);
});

test('quote needs best.executable true and a next of swap, or none on the deployed API', () => {
  assert.equal(reviewQuote(quote(), config), 594n); // next absent: the deployed 603c5f1 omits it
  const local = quote(); local.next = 'swap'; // local HEAD makes it required
  assert.equal(reviewQuote(local, config), 594n);
  for (const executable of [false, undefined, 'true', 1]) {
    const q = quote(); q.best.executable = executable;
    assert.throws(() => reviewQuote(q, config), undefined, `executable ${executable}`);
  }
  for (const next of ['stop', 'requote', 'retry', 'fix_request', 'pay', 'sign_permit', 'send', 'done', '']) {
    const q = quote(); q.next = next;
    assert.throws(() => reviewQuote(q, config), undefined, `next ${next}`);
  }
});

test('search, quote and Permit2 checks follow the row\'s trade network and chain, not constants', () => {
  assert.equal(reviewQuote(quote(), testnetConfig), 594n); // the testnet row also trades on Arc mainnet
  assert.equal(reviewPermit(permit(testnetConfig), testnetConfig).details.amount, '500000');
  const elsewhere = { ...config, tradeNetwork: 'eip155:777', tradeChainId: 777 }; // a row that trades on another chain
  assert.throws(() => reviewQuote(quote(), elsewhere), /network/);
  assert.throws(() => reviewPermit(permit(), elsewhere), /domain/);
  const q = quote(); q.network = 'eip155:777'; // the same quote, on the row's own network
  assert.equal(reviewQuote(q, elsewhere), 594n);
  const p = permit(); p.domain.chainId = 777;
  assert.equal(reviewPermit(p, elsewhere).details.amount, '500000');
  // A Permit2 domain on the payment chain is not the trade chain.
  const onPayment = permit(); onPayment.domain.chainId = testnetConfig.paymentChainId;
  assert.throws(() => reviewPermit(onPayment, testnetConfig), /domain/);
});

test('the first swap response must say sign_permit', () => {
  assert.equal(reviewSwap(swap(), quote(), wallet, config, 594n).length, 2);
  for (const next of [undefined, 'send', 'done', 'swap', 'stop', 'requote', 'retry', 'fix_request', 'pay']) {
    const s = swap(); if (next === undefined) delete s.next; else s.next = next;
    assert.throws(() => reviewSwap(s, quote(), wallet, config, 594n), undefined, `next ${next}`);
  }
});

test('the final swap response says send, or nothing on the deployed API', async () => {
  const typedData = permit(), signature = await account.signTypedData(typedData), signed = { typedData, signature };
  assert.equal(reviewSwap(swap(signed), quote(), wallet, config, 594n, signed).length, 1); // next absent
  const withSend = swap(signed); withSend.next = 'send';
  assert.equal(reviewSwap(withSend, quote(), wallet, config, 594n, signed).length, 1);
  for (const next of ['sign_permit', 'done', 'swap', 'stop', 'requote', 'retry', 'fix_request', 'pay', '']) {
    const s = swap(signed); s.next = next;
    assert.throws(() => reviewSwap(s, quote(), wallet, config, 594n, signed), undefined, `next ${next}`);
  }
});
