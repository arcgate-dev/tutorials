import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { acceptOffer, assertAuthorization, createArcgateClient } from '../src/payment.js';
import { circleCall, loadWallet, normalizeSignature, sendTransaction, signTypedData } from '../src/circle.js';
// These tests sign with the in-memory ephemeral key, so their wallet is the payment wallet, not the captured taker.
import { account, authorization, captured, circleSigner, config, encodeHeader, mainnetOffer, mainnetRequired, other, paymentWallet as wallet, pinnedTestnetConfig, quote, receiptHeader, required, run, search, settlement, swap, swapHash, testnetConfig, testnetOffer } from './fixtures.js';

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
  const offer = mainnetOffer();
  assert.equal(acceptOffer(offer, config), true);
  // Each override changes one field of the offer.
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
    if (requests.length === 1) return new Response(JSON.stringify(captured.search402.body), { status: 402, headers: { 'payment-required': encodeHeader(mainnetRequired()) } });
    const header = new Headers(init.headers).get('payment-signature');
    const payload = JSON.parse(Buffer.from(header, 'base64').toString());
    assert.equal(payload.accepted.network, config.network);
    assert.equal(payload.payload.authorization.to.toLowerCase(), config.payTo.toLowerCase());
    const typed = authorization();
    typed.message = payload.payload.authorization;
    assert.equal(await recoverTypedDataAddress({ ...typed, signature: payload.payload.signature }), account.address);
    return Response.json(search(), { headers: { 'payment-response': receiptHeader() } });
  } });
  assert.deepEqual(await api('search', run.run.search.request), search());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[1].init.redirect, 'error');
  assert.equal(logs.at(-1).transaction, settlement().transaction);
});

test('wrong network never reaches Circle signing', async () => {
  let signed = false;
  const api = createArcgateClient({ circle: { signTypedData() { signed = true; } }, wallet, config,
    fetchFn: async () => new Response(JSON.stringify(required()), { status: 402 }), // the captured challenge is on eip155:5042002, which the mainnet row refuses
  });
  await assert.rejects(api('search', {}), /payment network/);
  assert.equal(signed, false);
});

test('lost paid response is not retried and retains the run budget', async () => {
  let requests = 0;
  const api = createArcgateClient({ circle: circleSigner, wallet, config: { ...config, maxTotal: 5000n }, fetchFn: async () => {
    requests++;
    if (requests === 2) throw new Error('timeout');
    return new Response(JSON.stringify(mainnetRequired()), { status: 402 });
  } });
  await assert.rejects(api('search', {}), /may have settled/);
  assert.equal(requests, 2);
  await assert.rejects(api('search', {}), /budget/);
  assert.equal(requests, 3);
});

test('a successful HTTP response without a settlement receipt is not payment success', async () => {
  let requests = 0;
  const api = createArcgateClient({ circle: circleSigner, wallet, config, fetchFn: async () => ++requests === 1
    ? new Response(JSON.stringify(mainnetRequired()), { status: 402 }) : Response.json(search()) });
  await assert.rejects(api('search', {}), /payment receipt/);
});

test('swap errors preserve the next action, free quote and request ID without retrying', async () => {
  const body = { error: { code: 'quote_stale', message: 'the market moved since the quote was issued', hint: 'Review the fresh quote.' }, next: 'requote', quote: quote() };
  const records = [];
  let requests = 0;
  const api = createArcgateClient({ circle: circleSigner, wallet, config, record: entry => records.push(entry), fetchFn: async () => ++requests === 1
    ? new Response(JSON.stringify(mainnetRequired()), { status: 402 })
    : Response.json(body, { status: 409, headers: { 'x-request-id': 'request-123' } }) });
  await assert.rejects(api('swap', {}), error => {
    assert.equal(error.status, 409);
    assert.equal(error.requestId, 'request-123');
    assert.deepEqual(error.body, body);
    assert.match(error.message, /next=requote/);
    return true;
  });
  assert.equal(requests, 2);
  assert.deepEqual(records.at(-1).quote, body.quote);
});

test('pre-payment API errors retain retry guidance without asking Circle to sign', async () => {
  let signed = false;
  const api = createArcgateClient({ circle: { signTypedData() { signed = true; } }, wallet, config,
    fetchFn: async () => Response.json({ error: { code: 'swap_attempts_exhausted', message: 'this quote has used its 5 failed swap attempts', hint: 'quote again' }, next: 'requote', retryAfterSec: 5 }, { status: 429 }),
  });
  await assert.rejects(api('swap', {}), /next=requote; retryAfterSec=5/);
  assert.equal(signed, false);
});

test('empty middleware 402s retain settlement failure details and never trigger another payment', async () => {
  // Override: the captured settlement turned into a failed one, on the mainnet row's network.
  for (const failure of [null, { ...settlement(), success: false, errorReason: 'insufficient_funds', network: config.network, transaction: '' }]) {
    let requests = 0;
    const records = [];
    const api = createArcgateClient({ circle: circleSigner, wallet, config, record: entry => records.push(entry), fetchFn: async () => ++requests === 1
      ? new Response(JSON.stringify(mainnetRequired()), { status: 402 })
      : Response.json({}, { status: 402, headers: failure ? { 'payment-response': encodeHeader(failure) } : {} }),
    });
    await assert.rejects(api('search', {}), error => {
      assert.equal(error.status, 402);
      assert.deepEqual(error.body, {});
      assert.deepEqual(error.paymentResponse, failure);
      assert.match(error.message, /check the payment amount/);
      if (failure) assert.match(error.message, /payment settlement failed: insufficient_funds/);
      return true;
    });
    assert.equal(requests, 2);
    assert.deepEqual(records.at(-1).paymentResponse, failure);
  }
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
    return { data: { transaction: { state: 'COMPLETE', txHash: swapHash } } };
  } };
  assert.equal(await sendTransaction(client, wallet, { ...swap().transactions[1], value: '1000000000000000000' }, 'request-id', entry => records.push(entry)), swapHash); // override: the captured swap sends 1 native USDC (18 decimals)
  assert.equal(records[0].state, 'submitting');
  assert.equal(records[1].circleTransactionId, 'circle-tx');
  client.getTransaction = async () => ({ data: { transaction: { state: 'SENT', txHash: swapHash } } });
  await assert.rejects(sendTransaction(client, wallet, { value: '1000000000000000000' }, 'request-id'), /not confirmed success/);
});

test('Circle errors do not print credentials or SDK request objects', async () => {
  await assert.rejects(circleCall('getWallet', () => { throw new Error('secret-api-key entity-secret'); }), error => {
    assert(!error.message.includes('secret-api-key')); return true;
  });
});

test('testnet payment policy binds offers and authorizations to eip155:5042002 and the pinned pay-to', () => {
  const pinned = { ...testnetOffer, payTo: pinnedTestnetConfig.payTo };
  assert.equal(pinned.network, 'eip155:5042002');
  assert.equal(acceptOffer(pinned, pinnedTestnetConfig), true);
  // The captured localnet pay-to is the stack's own PAY_TO; it is accepted only once the override names it.
  assert.equal(acceptOffer(testnetOffer, testnetConfig), true);
  assert.equal(acceptOffer(testnetOffer, pinnedTestnetConfig), false);
  for (const change of [{ network: 'eip155:5042' }, { network: 'eip155:1' }, { payTo: other }, { asset: other }, { amount: '10001' }, { maxTimeoutSeconds: 301 }]) {
    assert.equal(acceptOffer({ ...pinned, ...change }, pinnedTestnetConfig), false, JSON.stringify(change));
  }
  // Each row refuses the other row's offer.
  assert.equal(acceptOffer(pinned, config), false);
  const mainnet = mainnetOffer();
  assert.equal(acceptOffer({ ...mainnet, payTo: pinnedTestnetConfig.payTo }, pinnedTestnetConfig), false);
  assert.equal(acceptOffer(mainnet, pinnedTestnetConfig), false);
  assert.equal(acceptOffer(mainnet, config), true);

  assertAuthorization(authorization(pinnedTestnetConfig, 5042002), wallet, pinnedTestnetConfig);
  for (const mutate of [
    data => { data.domain.chainId = 5042; }, data => { data.domain.chainId = 1; }, data => { data.message.to = other; },
    data => { data.message.to = config.payTo; },
  ]) {
    const data = authorization(pinnedTestnetConfig, 5042002); mutate(data);
    assert.throws(() => assertAuthorization(data, wallet, pinnedTestnetConfig), /unexpected x402 payment authorization/);
  }
  assert.throws(() => assertAuthorization(authorization(pinnedTestnetConfig, 5042002), wallet, config), /unexpected x402 payment authorization/);
});

test('real x402 SDK retries the captured testnet 402 once with a valid Circle-signed payment', async () => {
  const requests = [];
  const logs = [];
  // Override: the captured settlement names the captured taker as payer; these tests pay with the in-memory key.
  const settled = encodeHeader({ ...settlement(), payer: wallet.address });
  const api = createArcgateClient({ circle: circleSigner, wallet, config: testnetConfig, record: entry => logs.push(entry), fetchFn: async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Response(JSON.stringify(captured.search402.body), { status: 402, headers: { 'payment-required': encodeHeader(captured.search402.paymentRequired) } });
    const payload = JSON.parse(Buffer.from(new Headers(init.headers).get('payment-signature'), 'base64').toString());
    assert.equal(payload.accepted.network, 'eip155:5042002');
    assert.equal(payload.payload.authorization.to.toLowerCase(), testnetOffer.payTo.toLowerCase());
    const typed = authorization(testnetConfig, 5042002);
    typed.message = payload.payload.authorization;
    assert.equal(await recoverTypedDataAddress({ ...typed, signature: payload.payload.signature }), account.address);
    return Response.json(search(), { headers: { 'payment-response': settled } });
  } });
  assert.deepEqual(await api('search', run.run.search.request), search());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(logs.at(-1).transaction, settlement().transaction);
  assert.equal(logs.at(-1).network, 'eip155:5042002');
});

test('the mainnet row never signs the testnet offer, and the testnet row never signs the mainnet offer', async () => {
  for (const [cfg, challenge] of [[config, captured.search402.paymentRequired], [pinnedTestnetConfig, mainnetRequired()]]) {
    let signed = false;
    const api = createArcgateClient({ circle: { signTypedData() { signed = true; } }, wallet, config: cfg,
      fetchFn: async () => new Response(JSON.stringify(challenge), { status: 402 }) });
    await assert.rejects(api('search', {}), /payment network/);
    assert.equal(signed, false);
  }
});

test('wallet connection accepts an ARC-TESTNET EOA on the testnet row and refuses an ARC wallet there', async () => {
  assert.equal(testnetConfig.blockchain, 'ARC-TESTNET');
  const valid = { address: wallet.address, accountType: 'EOA', state: 'LIVE' };
  const client = blockchain => ({ getWallet: async () => ({ data: { wallet: { ...valid, blockchain } } }) });
  assert.deepEqual(await loadWallet(client('ARC-TESTNET'), 'id', testnetConfig.blockchain), { id: 'id', address: wallet.address, blockchain: 'ARC-TESTNET' });
  await assert.rejects(loadWallet(client('ARC'), 'id', testnetConfig.blockchain), /active ARC-TESTNET/);
  await assert.rejects(loadWallet(client('ARC-TESTNET'), 'id', config.blockchain), /active ARC\b/);
});
