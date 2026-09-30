import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { reviewPermit, reviewQuote, reviewSwap } from '../src/guards.js';
import { main } from '../src/main.js';
import { proposePolicy, requirePolicy, reviewPolicy } from '../src/policy.js';
import { account, config, initialPolicy, other, permit, quote, swap, swapArgs, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('configuration pins public mainnet and caps orders and API spend', () => {
  assert.equal(config.amount, '0.50'); assert.equal(config.maxTotal, 25000n); assert.equal(config.chainId, 5042);
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

test('policy proposal preserves restrictions, adds Arc, sets finite budget and never drops blocks', () => {
  const before = initialPolicy(); before.customRestriction = { untouched: true };
  assert.throws(() => requirePolicy(reviewPolicy(stringify(before), wallet, config)), /5042/);
  const proposed = proposePolicy(stringify(before), wallet, config), parsed = parse(proposed);
  assert.deepEqual(parsed.evm.allowed_chains, [1, 11155111, 5042]);
  assert.equal(parsed.evm.outflow_limits_usd.rolling_24h, 2);
  assert.deepEqual(parsed.addresses, before.addresses);
  assert.deepEqual(parsed.customRestriction, before.customRestriction);
  requirePolicy(reviewPolicy(proposed, wallet, config));
  before.addresses.blocklist.push({ address: config.router, chain_id: 5042 });
  assert.throws(() => proposePolicy(stringify(before), wallet, config), /blocklist/);
});
