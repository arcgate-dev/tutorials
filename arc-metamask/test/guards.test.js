import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { loadConfig } from '../src/config.js';
import { reviewPermit, reviewQuote, reviewSwap } from '../src/guards.js';
import { main } from '../src/main.js';
import { config, finalSwap, minimum, other, permit, permitSignature, pinTime, quote, swap, swapArgs, testnetConfig, trader } from './fixtures.js';

process.env.PATH = ''; // Never let a test find the real `mm` on this machine.
globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('configuration pins public mainnet and caps orders and API spend', () => {
  assert.equal(config.amount, '0.50'); assert.equal(config.maxTotal, 25000n); assert.equal(config.paymentChainId, 5042); assert.equal(config.tradeChainId, 5042);
  for (const env of [{ SELL_AMOUNT: '1.1' }, { SELL_AMOUNT: '0' }, { SELL_AMOUNT: '0.0000001' }, { API_URL: 'http://example.com' }, { API_URL: 'https://name:secret@example.com' }]) assert.throws(() => loadConfig(env));
});

test('execution requires explicit flag before any wallet operation', async () => {
  await assert.rejects(main(['trade']), /--execute/);
});

test('quote preserves requested input and original output floor', t => { pinTime(t);
  assert.equal(reviewQuote(quote(), config), minimum);
  const q = quote(); q.sell.amountRaw = '1000000';
  assert.throws(() => reviewQuote(q, config), /sell amount/);
});

test('Permit2 guard binds the schema, domain, amount, spender, nonce and lifetimes', t => { pinTime(t);
  assert.equal(reviewPermit(permit(), config).details.amount, '500000');
  for (const mutate of [
    p => { p.domain.chainId = 1; }, p => { p.domain.verifyingContract = other; }, p => { p.domain.name = 'other'; },
    p => { p.message.spender = other; }, p => { p.message.details.token = other; }, p => { p.message.details.amount = '500001'; },
    p => { p.message.sigDeadline = '0'; }, p => { p.message.details.expiration = '9999999999'; }, p => { p.message.details.nonce = '-1'; },
    p => { p.types.PermitDetails[1].type = 'uint256'; },
  ]) { const p = permit(); mutate(p); assert.throws(() => reviewPermit(p, config)); }
});

test('batch guards refuse changed router, recipient, floor, amount, mode and approval spender', t => { pinTime(t);
  assert.equal(reviewSwap(swap({ approval: true }), quote(), trader, config, minimum).length, 2);
  for (const [index, value] of [[1, 500001n], [2, other], [3, minimum - 1n], [4, other], [5, 0n]]) {
    const args = swapArgs(); args[index] = value;
    assert.throws(() => reviewSwap(swap({ args, approval: true }), quote(), trader, config, minimum));
  }
  const s = swap({ approval: true }); s.transactions[0].data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [config.router, maxUint256] });
  assert.throws(() => reviewSwap(s, quote(), trader, config, minimum), /Permit2/);
  const native = swap({ approval: true }); native.transactions[1].value = '500000000000000000';
  assert.throws(() => reviewSwap(native, quote(), trader, config, minimum), /value/);
  const allowance = swap({ approval: true }); allowance.signatures = [];
  assert.throws(() => reviewSwap(allowance, quote(), trader, config, minimum), /fresh Permit2/);
});

test('final calldata must contain precisely the permit and signature this wallet signed', t => { pinTime(t);
  const signed = { typedData: permit(), signature: permitSignature };
  assert.equal(reviewSwap(finalSwap(), quote(), trader, config, minimum, signed).length, 1);
  const args = swapArgs(true); args[7].permit.details.amount = '500001'; // the embedded permit no longer matches what was signed
  assert.throws(() => reviewSwap(finalSwap(args), quote(), trader, config, minimum, signed), /Embedded permit/);
  const wrongSignature = swapArgs(true); wrongSignature[7].signature = '0x1234';
  assert.throws(() => reviewSwap(finalSwap(wrongSignature), quote(), trader, config, minimum, signed), /Embedded permit/);
});

test('quote needs best.executable true and a next of swap', t => { pinTime(t);
  assert.equal(reviewQuote(quote(), config), minimum); // as captured, next is swap
  const absent = quote(); delete absent.next;
  assert.throws(() => reviewQuote(absent, config), undefined, 'next missing');
  for (const executable of [false, undefined, 'true', 1]) {
    const q = quote(); q.best.executable = executable;
    assert.throws(() => reviewQuote(q, config), undefined, `executable ${executable}`);
  }
  for (const next of ['stop', 'requote', 'retry', 'fix_request', 'pay', 'sign_permit', 'send', 'done', '']) {
    const q = quote(); q.next = next;
    assert.throws(() => reviewQuote(q, config), undefined, `next ${next}`);
  }
});

test('search, quote and Permit2 checks follow the row\'s trade network and chain, not constants', t => { pinTime(t);
  assert.equal(reviewQuote(quote(), testnetConfig), minimum); // the testnet row also trades on Arc mainnet
  assert.equal(reviewPermit(permit(testnetConfig), testnetConfig).details.amount, '500000');
  const elsewhere = { ...config, tradeNetwork: 'eip155:777', tradeChainId: 777 }; // a row that trades on another chain
  assert.throws(() => reviewQuote(quote(), elsewhere), /network/);
  assert.throws(() => reviewPermit(permit(), elsewhere), /domain/);
  const q = quote(); q.network = 'eip155:777'; // the same quote, on the row's own network
  assert.equal(reviewQuote(q, elsewhere), minimum);
  const p = permit(); p.domain.chainId = 777;
  assert.equal(reviewPermit(p, elsewhere).details.amount, '500000');
  // A Permit2 domain on the payment chain is not the trade chain.
  const onPayment = permit(); onPayment.domain.chainId = testnetConfig.paymentChainId;
  assert.throws(() => reviewPermit(onPayment, testnetConfig), /domain/);
});

test('the first swap response must say sign_permit', t => { pinTime(t);
  assert.equal(reviewSwap(swap({ approval: true }), quote(), trader, config, minimum).length, 2);
  for (const next of [undefined, 'send', 'done', 'swap', 'stop', 'requote', 'retry', 'fix_request', 'pay']) {
    const s = swap({ approval: true }); if (next === undefined) delete s.next; else s.next = next;
    assert.throws(() => reviewSwap(s, quote(), trader, config, minimum), undefined, `next ${next}`);
  }
});

test('the final swap response says send', t => { pinTime(t);
  const signed = { typedData: permit(), signature: permitSignature };
  assert.equal(reviewSwap(finalSwap(), quote(), trader, config, minimum, signed).length, 1); // as captured, next is send
  const absent = finalSwap(); delete absent.next;
  assert.throws(() => reviewSwap(absent, quote(), trader, config, minimum, signed), undefined, 'next missing');
  for (const next of ['sign_permit', 'done', 'swap', 'stop', 'requote', 'retry', 'fix_request', 'pay', '']) {
    const s = finalSwap(); s.next = next;
    assert.throws(() => reviewSwap(s, quote(), trader, config, minimum, signed), undefined, `next ${next}`);
  }
});
