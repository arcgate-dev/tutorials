import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../src/agent.js';
import { createArcgateClient } from '../src/payment.js';
import { ALLOWED_NETWORKS, loadConfig } from '../src/config.js';
import { ArcgateError } from '../src/http.js';
import { loadTerms } from '../src/terms.js';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { getAddress, recoverTypedDataAddress } from 'viem';
import { PAID, SPEC, acceptedOf, clone, createReplay, health, loadFixture, makeWallet, openapi, operationOf, prices, staticFetch, templateOf } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// Everything below starts from the captured run: the API's own terms (/health, /openapi.json) and the
// 402 and settlement it answered the start run's boxTopUp with. Tests change copies of those, never invent values.
let memo;
function world() {
  memo ??= (() => {
    const fixture = loadFixture();
    const config = loadConfig({ API_URL: fixture.apiUrl });
    const at = fixture.exchanges.findIndex(e => e.status === 402 && operationOf(e.method, e.path) === 'boxTopUp');
    assert.ok(at >= 0, 'the capture holds a 402 for boxTopUp');
    const unpaid = fixture.exchanges[at], paid = fixture.exchanges[at + 1];
    assert.ok(paid.status < 300 && paid.headers['payment-response'], 'the 402 is followed by the paid answer');
    const required = decodePaymentRequiredHeader(unpaid.headers['payment-required']);
    return { fixture, config, price: prices(fixture), unpaid, paid, required, offer: required.accepts[0], settlement: decodePaymentResponseHeader(paid.headers['payment-response']) };
  })();
  return memo;
}

const loaded = async w => loadTerms(w.config, createReplay(w.fixture).fetch);
const respond = (exchange, headers = {}) => () => new Response(exchange.body === undefined ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: { ...exchange.headers, ...headers } });
const challenge = (w, { offer = w.offer, accepts = [offer] } = {}) => () => new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({ ...w.required, accepts }) } });
const settled = (w, change = {}) => () => new Response(JSON.stringify(w.paid.body ?? {}), { status: w.paid.status, headers: { ...w.paid.headers, 'payment-response': encodePaymentResponseHeader({ ...w.settlement, ...change }) } });

function scripted(...handlers) {
  const requests = [];
  const fetchFn = async (url, init = {}) => {
    const handler = handlers[requests.length];
    requests.push({ url, init, headers: new Headers(init.headers) });
    if (!handler) throw new Error(`unexpected request ${requests.length}: ${init.method} ${url}`);
    return handler(url, init);
  };
  return { fetchFn, requests };
}

async function setup(w, fetchFn, { config = w.config } = {}) {
  const { health: h, terms } = await loaded(w);
  const { account, wallet } = makeWallet(w.fixture.address);
  let signed = 0;
  const records = [];
  const spy = { address: wallet.address, signTypedData: data => { signed++; return wallet.signTypedData(data); } };
  const call = createArcgateClient({ wallet: spy, config, health: h, terms, fetchFn, record: entry => records.push(entry) });
  return { call, account, wallet: spy, signed: () => signed, records, terms };
}

const topUp = w => ['boxTopUp', 'POST', w.unpaid.path, undefined];
const noPayment = requests => requests.every(request => request.headers.get('payment-signature') === null);

// a paid call -----------------------------------------------------------------------------------

test('a paid call signs the offer the API made, once, and retries the identical request', async () => {
  const w = world();
  const { fetchFn, requests } = scripted(respond(w.unpaid), respond(w.paid));
  const { call, account, wallet, records, signed } = await setup(w, fetchFn);
  assert.deepEqual(await call(...topUp(w)), w.paid.body);

  assert.equal(requests.length, 2);
  assert.equal(signed(), 1);
  assert.equal(requests[0].headers.get('payment-signature'), null, 'the first request carries no payment');
  assert.equal(requests[0].url, `${w.config.apiUrl}${w.unpaid.path}`);
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(requests[1].init.method, requests[0].init.method);
  assert.equal(requests[1].init.body, requests[0].init.body);
  for (const request of requests) {
    assert.equal(request.init.redirect, 'error');
    assert.ok(request.init.signal instanceof AbortSignal, 'a timeout');
    assert.equal(request.headers.get('agent-signature'), null, 'a paid call is authenticated by its payment, not an agent signature');
  }

  const payload = acceptedOf({ headers: { 'payment-signature': requests[1].headers.get('payment-signature') } });
  assert.equal(payload.accepted.network, w.offer.network);
  assert.equal(payload.accepted.amount, w.offer.amount);
  assert.equal(payload.accepted.payTo, w.offer.payTo);
  const authorization = payload.payload.authorization;
  assert.equal(getAddress(authorization.from), wallet.address);
  assert.equal(getAddress(authorization.to), getAddress(w.offer.payTo));
  assert.equal(authorization.value, w.offer.amount);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Number(authorization.validBefore) > now && Number(authorization.validBefore) <= now + w.offer.maxTimeoutSeconds + 30);

  const recovered = await recoverTypedDataAddress({
    domain: { name: w.offer.extra.name, version: w.offer.extra.version, chainId: ALLOWED_NETWORKS[w.offer.network], verifyingContract: w.offer.asset },
    types: SPEC.authorizationTypes, primaryType: 'TransferWithAuthorization',
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
    signature: payload.payload.signature,
  });
  assert.equal(recovered, account.address);

  const settlement = records.find(entry => entry.transaction === w.settlement.transaction);
  assert.ok(settlement, 'the settlement transaction is in the run log');
});

test('a POST with a body retries the same body', async () => {
  const w = world();
  const body = { query: 'x', limit: 5 };
  const { fetchFn, requests } = scripted(challenge(w), settled(w));
  const { call } = await setup(w, fetchFn);
  await call('boxTopUp', 'POST', w.unpaid.path, body);
  assert.deepEqual(JSON.parse(requests[0].init.body), body);
  assert.equal(requests[1].init.body, requests[0].init.body);
  assert.equal(requests[1].headers.get('content-type'), requests[0].headers.get('content-type'));
});

// prices come from the API's terms ---------------------------------------------------------------

test('the terms are one free GET /health and one free GET /openapi.json, with the price of each paid operation', async () => {
  const w = world();
  const { fetch, requests } = staticFetch({ health: health(w.fixture), openapi: openapi(w.fixture).body });
  const { health: h, terms } = await loadTerms(w.config, fetch);
  assert.deepEqual(requests.map(r => `${r.method} ${r.path}`).sort(), ['GET /health', 'GET /openapi.json']);
  for (const request of requests) {
    assert.equal(request.headers['payment-signature'], undefined);
    assert.equal(request.redirect, 'error');
    assert.ok(request.hasSignal, 'a timeout');
  }
  assert.deepEqual(h, health(w.fixture));
  for (const operationId of PAID) {
    assert.equal(typeof w.price[operationId], 'string', `${operationId} has a price in the captured terms`);
    assert.equal(terms[operationId], w.price[operationId]);
  }
});

function editOperation(spec, operationId, change) {
  for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) if (operation.operationId === operationId) change(operation);
}

test('terms that are missing, not USDC or above the per-call cap stop the run before anything is signed', async () => {
  const w = world();
  const load = async (edit, config = w.config) => {
    const spec = clone(openapi(w.fixture).body), status = clone(health(w.fixture));
    edit(spec, status);
    return loadTerms(config, staticFetch({ health: status, openapi: spec }).fetch);
  };
  await load(() => {}); // the unchanged capture loads
  for (const operationId of PAID) {
    await assert.rejects(load(spec => editOperation(spec, operationId, op => { delete op['x-payment']; })), `${operationId} without a price`);
    await assert.rejects(load(spec => editOperation(spec, operationId, op => { op['x-payment'].asset = 'EURC'; })), `${operationId} priced in another asset`);
    await assert.rejects(load(spec => editOperation(spec, operationId, op => { op['x-payment'].baseUnits = String(w.config.maxPayment + 1n); })), `${operationId} above the cap`);
  }
  await assert.rejects(load(() => {}, { ...w.config, maxPayment: BigInt(w.price.boxTopUp) - 1n }), 'a cap below the price');
  await assert.rejects(load((spec, status) => { status.ok = false; }), 'an unhealthy API');
  await assert.rejects(load((spec, status) => { status.x402.enabled = false; }), 'x402 off');
  await assert.rejects(load((spec, status) => { delete status.x402; }), 'no x402 section');
});

test('an offer is paid only when its amount equals the operation price and is within the per-call cap', async () => {
  const w = world();
  const price = BigInt(w.price.boxTopUp);
  assert.equal(String(price), w.offer.amount, 'the captured offer is the captured price');
  const roomy = { ...w.config, maxPayment: price * 2n, maxTotal: price * 8n };
  for (const amount of [String(price - 1n), String(price + 1n), String(price * 2n), '0', '-1', '1e6', '']) {
    const { fetchFn, requests } = scripted(challenge(w, { offer: { ...w.offer, amount } }));
    const { call, signed } = await setup(w, fetchFn, { config: roomy });
    await assert.rejects(call(...topUp(w)), `amount ${JSON.stringify(amount)}`);
    assert.equal(signed(), 0, `amount ${JSON.stringify(amount)} was signed`);
    assert.equal(requests.length, 1);
    assert.ok(noPayment(requests));
  }
  // The price is the API's own terms, but a cap below it still refuses it.
  const { fetchFn, requests } = scripted(challenge(w));
  const { call, signed } = await setup(w, fetchFn, { config: { ...w.config, maxPayment: price - 1n } });
  await assert.rejects(call(...topUp(w)));
  assert.equal(signed(), 0);
  assert.ok(noPayment(requests));
});

test("an offer priced for another operation is not paid", async () => {
  const w = world();
  assert.notEqual(w.price.watchCreate, w.price.boxTopUp, 'the capture prices these operations differently');
  const { fetchFn, requests } = scripted(challenge(w));
  const { call, signed } = await setup(w, fetchFn);
  await assert.rejects(call('watchCreate', 'POST', templateOf('watchCreate').replace('{address}', w.fixture.address.toLowerCase()), { condition: {} }));
  assert.equal(signed(), 0);
  assert.ok(noPayment(requests));
});

test('the offer must be exact USDC on the network /health names', async () => {
  const w = world();
  const other = Object.keys(ALLOWED_NETWORKS).find(network => network !== w.offer.network);
  assert.ok(other, 'there is another allowed network to be refused');
  for (const change of [{ network: other }, { network: 'eip155:1' }, { asset: getAddress(`0x${'11'.repeat(20)}`) }, { scheme: 'upto' }]) {
    const { fetchFn, requests } = scripted(challenge(w, { offer: { ...w.offer, ...change } }));
    const { call, signed } = await setup(w, fetchFn);
    await assert.rejects(call(...topUp(w)), JSON.stringify(change));
    assert.equal(signed(), 0, `${JSON.stringify(change)} was signed`);
    assert.ok(noPayment(requests));
  }
  for (const accepts of [[], [{ ...w.offer, network: other }, { ...w.offer, asset: getAddress(`0x${'22'.repeat(20)}`) }]]) {
    const { fetchFn } = scripted(challenge(w, { accepts }));
    const { call, signed } = await setup(w, fetchFn);
    await assert.rejects(call(...topUp(w)));
    assert.equal(signed(), 0);
  }
});

test('the payment network in /health is the one every offer must name', async () => {
  const w = world();
  const other = Object.keys(ALLOWED_NETWORKS).find(network => network !== health(w.fixture).x402.network);
  const spec = openapi(w.fixture).body, status = clone(health(w.fixture));
  status.x402.network = other;
  const { health: h, terms } = await loadTerms(w.config, staticFetch({ health: status, openapi: spec }).fetch);
  const { fetchFn } = scripted(challenge(w));
  const { account, wallet } = makeWallet(w.fixture.address);
  let signed = 0;
  const call = createArcgateClient({ wallet: { address: wallet.address, signTypedData: data => { signed++; return account.signTypedData(data); } }, config: w.config, health: h, terms, fetchFn });
  await assert.rejects(call(...topUp(w)));
  assert.equal(signed, 0);
});

// the run ---------------------------------------------------------------------------------------

const inbound = w => ['inboundCreate', 'POST', templateOf('inboundCreate').replace('{address}', w.fixture.address.toLowerCase()), undefined];
const inboundOffer = w => ({ ...w.offer, amount: w.price.inboundCreate });

test('payTo stays the same for every payment in a run', async () => {
  const w = world();
  const { fetchFn, requests } = scripted(challenge(w), settled(w), challenge(w, { offer: inboundOffer(w) }), settled(w));
  const same = await setup(w, fetchFn);
  await same.call(...topUp(w));
  await same.call(...inbound(w));
  assert.equal(same.signed(), 2, 'with an unchanged payTo the run pays twice');
  assert.equal(requests.length, 4);

  const moved = scripted(challenge(w), settled(w), challenge(w, { offer: { ...inboundOffer(w), payTo: getAddress(`0x${'33'.repeat(20)}`) } }));
  const run = await setup(w, moved.fetchFn);
  await run.call(...topUp(w));
  await assert.rejects(run.call(...inbound(w)));
  assert.equal(run.signed(), 1);
  assert.equal(moved.requests.length, 3);
  assert.equal(moved.requests[2].headers.get('payment-signature'), null);
});

test('the per-run cap holds: a payment that would pass it is not signed', async () => {
  const w = world();
  const total = BigInt(w.price.boxTopUp) + BigInt(w.price.inboundCreate);
  const run = async maxTotal => {
    const { fetchFn, requests } = scripted(challenge(w), settled(w), challenge(w, { offer: inboundOffer(w) }), settled(w));
    const client = await setup(w, fetchFn, { config: { ...w.config, maxTotal } });
    await client.call(...topUp(w));
    const error = await client.call(...inbound(w)).then(() => null, failure => failure);
    return { client, requests, error };
  };
  const exact = await run(total);
  assert.equal(exact.error, null);
  assert.equal(exact.client.signed(), 2, 'a run exactly at the cap completes');

  const over = await run(total - 1n);
  assert.ok(over.error, 'a run one unit over the cap is refused');
  assert.equal(over.client.signed(), 1);
  assert.equal(over.requests.length, 3);
  assert.equal(over.requests[2].headers.get('payment-signature'), null);
});

test('a paid response that is lost is not retried and keeps its share of the run cap', async () => {
  const w = world();
  const price = BigInt(w.price.boxTopUp);
  const { fetchFn, requests } = scripted(challenge(w), () => { throw new Error('socket hang up'); }, challenge(w));
  const client = await setup(w, fetchFn, { config: { ...w.config, maxPayment: price * 2n, maxTotal: price * 2n - 1n } });
  await assert.rejects(client.call(...topUp(w)), /settle/i);
  assert.equal(requests.length, 2, 'the paid request is not sent again');
  await assert.rejects(client.call(...topUp(w)));
  assert.equal(client.signed(), 1, 'the second payment is not signed');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].headers.get('payment-signature'), null);
});

// the settlement --------------------------------------------------------------------------------

test('a paid answer without a matching settlement is not success', async () => {
  const w = world();
  const other = Object.keys(ALLOWED_NETWORKS).find(network => network !== w.settlement.network);
  const answers = {
    'a different payer': settled(w, { payer: getAddress(`0x${'44'.repeat(20)}`) }),
    'a different network': settled(w, { network: other }),
    'a malformed transaction': settled(w, { transaction: '0x1234' }),
    'success false': settled(w, { success: false, errorReason: 'insufficient_funds' }),
    'no receipt header': () => new Response(JSON.stringify(w.paid.body ?? {}), { status: w.paid.status }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const { fetchFn } = scripted(challenge(w), answer);
    const { call, signed } = await setup(w, fetchFn);
    await assert.rejects(call(...topUp(w)), /receipt|settle|payment/i, name);
    assert.equal(signed(), 1, name);
  }
});

// a non-402 answer ------------------------------------------------------------------------------

test('a non-402 answer to the first request signs nothing: a body comes back, an error is thrown with its status and code', async () => {
  const w = world();
  const ok = scripted(() => Response.json({ address: w.fixture.address.toLowerCase(), granted: { messages: 1, days: 1 } }));
  const first = await setup(w, ok.fetchFn);
  assert.deepEqual(await first.call(...topUp(w)), { address: w.fixture.address.toLowerCase(), granted: { messages: 1, days: 1 } });
  assert.equal(first.signed(), 0);
  assert.equal(ok.requests.length, 1);
  assert.ok(noPayment(ok.requests));

  for (const [status, code] of [[409, 'allowance_full'], [404, 'box_not_found'], [429, 'rate_limited'], [500, 'internal']]) {
    const bad = scripted(() => Response.json({ error: { code, hint: 'h' } }, { status, headers: { 'x-request-id': 'req-9' } }));
    const run = await setup(w, bad.fetchFn);
    await assert.rejects(run.call(...topUp(w)), error => error instanceof ArcgateError && error.status === status && error.body.error.code === code);
    assert.equal(run.signed(), 0);
    assert.equal(bad.requests.length, 1);
  }
});

// a paid answer that may have settled -----------------------------------------------------------

// Override: the x402 middleware's own 502 body, a plain string, not an Arcgate { code, message, hint } error.
const middleware502 = () => new Response(JSON.stringify({ error: 'X402MiddlewareError: facilitator verify failed' }), { status: 502, headers: { 'x-request-id': 'abc12345' } });
// Override: a 402 whose settlement is the captured one turned into a failed one.
const refused = (w, errorReason) => () => new Response('{}', { status: 402, headers: { 'payment-response': encodePaymentResponseHeader({ ...w.settlement, success: false, errorReason, transaction: '' }) } });

test('a paid 502 X402MiddlewareError may have settled', async () => {
  const w = world();
  const { fetchFn, requests } = scripted(respond(w.unpaid), middleware502);
  const { call, signed } = await setup(w, fetchFn);
  await assert.rejects(call(...topUp(w)), error => {
    assert.ok(error instanceof ArcgateError);
    assert.equal(error.status, 502);
    assert.match(error.message, /X402MiddlewareError: facilitator verify failed/);
    assert.doesNotMatch(error.message, /request_failed/);
    assert.match(error.message, /may have settled/);
    assert.match(error.message, /PAYMENT-RESPONSE|balance/);
    assert.match(error.message, /No automatic retry/);
    return true;
  });
  assert.equal(signed(), 1);
  assert.equal(requests.length, 2, 'the paid request is not sent again');
});

test('a payment_response_expired settlement may have settled', async () => {
  const w = world();
  const { fetchFn, requests } = scripted(respond(w.unpaid), refused(w, 'payment_response_expired'));
  const { call } = await setup(w, fetchFn);
  await assert.rejects(call(...topUp(w)), error => {
    assert.ok(error instanceof ArcgateError);
    assert.equal(error.status, 402);
    assert.match(error.message, /payment_response_expired/);
    assert.match(error.message, /may have settled/);
    return true;
  });
  assert.equal(requests.length, 2);
});

test('other failures do not say may have settled', async () => {
  const w = world();
  const fails = async (run, requests) => {
    const error = await run().then(() => assert.fail('expected a refusal'), failure => failure);
    assert.ok(error instanceof ArcgateError);
    assert.doesNotMatch(error.message, /may have settled/);
    assert.equal(requests.length, 1);
    return error;
  };
  // An ordinary settlement failure on a paid call.
  const insufficient = scripted(respond(w.unpaid), refused(w, 'insufficient_funds'));
  const paid = await setup(w, insufficient.fetchFn);
  const settlementError = await paid.call(...topUp(w)).then(() => assert.fail('expected a refusal'), failure => failure);
  assert.ok(settlementError instanceof ArcgateError);
  assert.match(settlementError.message, /insufficient_funds/);
  assert.doesNotMatch(settlementError.message, /may have settled/);
  assert.equal(insufficient.requests.length, 2);

  // The same 502 on a free owner call.
  const owner = scripted(middleware502);
  const ownerClient = createAgentClient({ wallet: makeWallet().wallet, config: w.config, fetchFn: owner.fetchFn });
  const ownerError = await fails(() => ownerClient('boxStatus'), owner.requests);
  assert.equal(ownerError.status, 502);
  assert.match(ownerError.message, /X402MiddlewareError: facilitator verify failed/);

  // The same 502 on the free /health read.
  const health502 = scripted(middleware502);
  const healthError = await fails(() => loadTerms(w.config, health502.fetchFn), health502.requests);
  assert.equal(healthError.status, 502);
  assert.match(healthError.message, /X402MiddlewareError: facilitator verify failed/);

  // The same 502 on the first, unsigned request of a paid operation: nothing was signed, so nothing may have settled.
  const unsigned = scripted(middleware502);
  const unsignedClient = await setup(w, unsigned.fetchFn);
  const unsignedError = await unsignedClient.call(...topUp(w)).then(() => assert.fail('expected a refusal'), failure => failure);
  assert.ok(unsignedError instanceof ArcgateError);
  assert.equal(unsignedError.status, 502);
  assert.match(unsignedError.message, /X402MiddlewareError: facilitator verify failed/);
  assert.doesNotMatch(unsignedError.message, /may have settled/);
  assert.equal(unsignedClient.signed(), 0, 'nothing was signed');
  assert.equal(unsigned.requests.length, 1);

  // The same 502 on a paid call does warn, so the checks above are not satisfied by a warning that never appears.
  const control = scripted(respond(w.unpaid), middleware502);
  const controlClient = await setup(w, control.fetchFn);
  await assert.rejects(controlClient.call(...topUp(w)), /may have settled/);
});
