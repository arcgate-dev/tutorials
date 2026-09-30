import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { acceptOffer, assertAuthorization, createArcgateClient } from '../src/payment.js';
import { account, authorization, config, encodeHeader, hash, offer, other, receiptHeader, required, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

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

test('real x402 SDK retries identical request once with a valid MetaMask-signed payment', async () => {
  const requests = [];
  const logs = [];
  const api = createArcgateClient({ wallet, config, record: entry => logs.push(entry), fetchFn: async (url, init) => {
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

test('wrong network never reaches wallet signing', async () => {
  let signed = false;
  const api = createArcgateClient({ wallet: { address: wallet.address, signTypedData() { signed = true; } }, config,
    fetchFn: async () => new Response(JSON.stringify({ ...required, accepts: [{ ...offer, network: 'eip155:5042002' }] }), { status: 402 }),
  });
  await assert.rejects(api('search', {}), /payment network/);
  assert.equal(signed, false);
});

test('lost paid response is not retried and retains the run budget', async () => {
  let requests = 0;
  const api = createArcgateClient({ wallet, config: { ...config, maxTotal: 5000n }, fetchFn: async () => {
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
  const api = createArcgateClient({ wallet, config, fetchFn: async () => ++requests === 1
    ? new Response(JSON.stringify(required), { status: 402 }) : new Response('{}') });
  await assert.rejects(api('search', {}), /payment receipt/);
});


test('free /swap/tx and /receipt never sign a payment, even when answered with 402', async () => {
  for (const [operation, body] of [['swap/tx', { quoteId: 'q_1234567890abcdef', permit: {} }], ['receipt', { quoteId: 'q_1234567890abcdef', txHashes: [hash] }]]) {
    let signed = false, calls = 0;
    const api = createArcgateClient({ wallet: { address: wallet.address, signTypedData() { signed = true; } }, config, fetchFn: async (url, init) => {
      calls++;
      assert.equal(url, `${config.apiUrl}/trade/v1/${operation}`);
      assert.equal(new Headers(init.headers).get('payment-signature'), null);
      return Response.json(required, { status: 402, headers: { 'payment-required': encodeHeader(required) } });
    } });
    await assert.rejects(api(operation, body), /HTTP 402.*No automatic retry/);
    assert.equal(calls, 1); assert.equal(signed, false);
  }
});

test('a paid call that fails keeps the API next action and free replacement quote', async () => {
  let requests = 0;
  const api = createArcgateClient({ wallet, config, fetchFn: async () => ++requests === 1
    ? new Response(JSON.stringify(required), { status: 402 })
    : Response.json({ error: { code: 'quote_stale', hint: 'price moved' }, next: 'requote', quote: { quoteId: 'q_abcdefabcdefabcd' } }, { status: 409, headers: { 'payment-response': receiptHeader } }) });
  await assert.rejects(api('swap', {}), error => error.status === 409 && /next=requote/.test(error.message) && error.body.quote.quoteId === 'q_abcdefabcdefabcd');
});
