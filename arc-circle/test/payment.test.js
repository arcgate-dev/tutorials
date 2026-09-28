import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { acceptOffer, assertAuthorization, createArcgateClient } from '../src/payment.js';
import { circleCall, loadWallet, normalizeSignature, sendTransaction, signTypedData } from '../src/circle.js';
import { account, authorization, circleSigner, config, encodeHeader, hash, offer, other, receiptHeader, required, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

test('Circle EIP-712 serialization, signature normalization and recovery', async () => {
  const data = authorization();
  assertAuthorization(data, wallet, config);
  const signature = await signTypedData(circleSigner, wallet, data);
  assert.equal(await recoverTypedDataAddress({ ...data, signature }), wallet.address);
  const rawV = (parseInt(signature.slice(-2), 16) - 27).toString(16).padStart(2, '0');
  assert.equal(normalizeSignature(`${signature.slice(2, -2)}${rawV}`), signature);
  await assert.rejects(signTypedData(circleSigner, { ...wallet, address: other }, data), /recover/);
});

test('payment policy refuses wrong chains, recipients, assets, price, flow and timeout', () => {
  assert.equal(acceptOffer(offer, config), true);
  for (const change of [
    { network: 'eip155:5042002' }, { asset: other }, { payTo: other }, { amount: '10001' }, { amount: '-1' }, { amount: '0' },
    { maxTimeoutSeconds: 301 }, { maxTimeoutSeconds: '300' }, { maxTimeoutSeconds: 0 }, { scheme: 'upto' },
    { extra: { name: 'USDC', version: '2', paymentFlow: 'escrow' } }, { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } },
  ]) assert.equal(acceptOffer({ ...offer, ...change }, config), false, JSON.stringify(change));
});

test('signed authorization is bound to expected network, payer, recipient, amount and expiry', () => {
  for (const mutate of [
    data => { data.domain.chainId = 1; }, data => { data.message.to = other; }, data => { data.message.from = other; },
    data => { data.message.value = 10001n; }, data => { data.message.validBefore = 0n; },
    data => { data.message.validBefore += 3600n; }, data => { data.types.TransferWithAuthorization[2].type = 'uint128'; },
  ]) { const data = authorization(); mutate(data); assert.throws(() => assertAuthorization(data, wallet, config)); }
});

test('real x402 SDK retries identical request once with a valid Circle-signed payment', async () => {
  const requests = [];
  const logs = [];
  const api = createArcgateClient({ circle: circleSigner, wallet, config, record: entry => logs.push(entry), fetchFn: async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Response('{}', { status: 402, headers: { 'payment-required': encodeHeader(required) } });
    const header = new Headers(init.headers).get('payment-signature');
    const payload = JSON.parse(Buffer.from(header, 'base64').toString());
    assert.equal(payload.accepted.network, config.network);
    assert.equal(payload.payload.authorization.to.toLowerCase(), config.payTo.toLowerCase());
    const typed = authorization();
    typed.message = payload.payload.authorization;
    assert.equal(await recoverTypedDataAddress({ ...typed, signature: payload.payload.signature }), account.address);
    return new Response('{"resolution":"verified"}', { headers: { 'payment-response': receiptHeader } });
  } });
  assert.deepEqual(await api('search', { query: 'cirBTC' }), { resolution: 'verified' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[1].init.redirect, 'error');
  assert.equal(logs.at(-1).transaction, hash);
});

test('wrong network never reaches Circle signing', async () => {
  let signed = false;
  const api = createArcgateClient({ circle: { signTypedData() { signed = true; } }, wallet, config,
    fetchFn: async () => new Response(JSON.stringify({ ...required, accepts: [{ ...offer, network: 'eip155:5042002' }] }), { status: 402 }),
  });
  await assert.rejects(api('search', {}), /payment network/);
  assert.equal(signed, false);
});

test('lost paid response is not retried and retains the run budget', async () => {
  let requests = 0;
  const api = createArcgateClient({ circle: circleSigner, wallet, config: { ...config, maxTotal: 5000n }, fetchFn: async () => {
    requests++;
    if (requests === 2) throw new Error('timeout');
    return new Response(JSON.stringify(required), { status: 402 });
  } });
  await assert.rejects(api('search', {}), /may have settled/);
  assert.equal(requests, 2);
  await assert.rejects(api('search', {}), /budget/);
  assert.equal(requests, 3);
});

test('a successful HTTP response without a settlement receipt is not payment success', async () => {
  let requests = 0;
  const api = createArcgateClient({ circle: circleSigner, wallet, config, fetchFn: async () => ++requests === 1
    ? new Response(JSON.stringify(required), { status: 402 }) : new Response('{}') });
  await assert.rejects(api('search', {}), /payment receipt/);
});

test('wallet connection refuses SCA, inactive and wrong-chain wallets', async () => {
  const valid = { address: wallet.address, accountType: 'EOA', state: 'LIVE', blockchain: 'ARC' };
  for (const change of [{ accountType: 'SCA' }, { state: 'FROZEN' }, { blockchain: 'ARC-TESTNET' }]) {
    await assert.rejects(loadWallet({ getWallet: async () => ({ data: { wallet: { ...valid, ...change } } }) }, 'id', 'ARC'), /active ARC/);
  }
});

test('Circle submission uses decimal native value, an idempotency key and COMPLETE', async () => {
  const records = [];
  const client = { createContractExecutionTransaction: async request => {
    assert.equal(request.amount, '1'); assert.equal(request.idempotencyKey, 'request-id'); assert.equal(request.walletId, wallet.id);
    return { data: { id: 'circle-tx' } };
  }, getTransaction: async request => {
    assert.equal(request.waitForState, 'COMPLETE');
    return { data: { transaction: { state: 'COMPLETE', txHash: hash } } };
  } };
  assert.equal(await sendTransaction(client, wallet, { to: config.router, data: '0x1234', value: '1000000000000000000', purpose: 'swap' }, 'request-id', entry => records.push(entry)), hash);
  assert.equal(records[0].state, 'submitting');
  assert.equal(records[1].circleTransactionId, 'circle-tx');
  client.getTransaction = async () => ({ data: { transaction: { state: 'SENT', txHash: hash } } });
  await assert.rejects(sendTransaction(client, wallet, { value: '1000000000000000000' }, 'request-id'), /not confirmed success/);
});

test('Circle errors do not print credentials or SDK request objects', async () => {
  await assert.rejects(circleCall('getWallet', () => { throw new Error('secret-api-key entity-secret'); }), error => {
    assert(!error.message.includes('secret-api-key')); return true;
  });
});
