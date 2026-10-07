import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_NETWORKS, apiOrigin, loadConfig, reportError } from '../src/config.js';
import { postInbound } from '../src/inbound.js';
import { loadTerms } from '../src/terms.js';
import { PAID, clone, health, loadFixture, openapi, operationOf, prices, runExchanges, staticFetch } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// API_URL ---------------------------------------------------------------------------------------

test('API_URL is an https origin, or http only for localhost and 127.0.0.1', () => {
  assert.equal(apiOrigin('https://api.arcgate.dev'), 'https://api.arcgate.dev');
  assert.equal(apiOrigin('https://api.arcgate.dev/'), 'https://api.arcgate.dev');
  assert.equal(apiOrigin('http://127.0.0.1:19800'), 'http://127.0.0.1:19800');
  assert.equal(apiOrigin('http://localhost:19800'), 'http://localhost:19800');
  assert.equal(apiOrigin('https://127.0.0.1:19800'), 'https://127.0.0.1:19800');
});

test('API_URL refuses plain http elsewhere, other schemes, credentials, a path, a query and a fragment', () => {
  for (const value of [
    'http://api.arcgate.dev', 'http://192.0.2.10', 'http://127.0.0.2:19800', 'http://[::1]:19800', 'http://0.0.0.0:19800',
    'http://localhost.example.com', 'http://127.0.0.1.example.com', 'ftp://api.arcgate.dev', 'ws://127.0.0.1:19800', 'file:///etc/passwd',
    'https://user:pass@api.arcgate.dev', 'https://user@api.arcgate.dev', 'http://user:pass@127.0.0.1:19800',
    'https://api.arcgate.dev/v1', 'http://127.0.0.1:19800/agent', 'https://api.arcgate.dev?x=1', 'https://api.arcgate.dev/?x=1', 'https://api.arcgate.dev#frag',
    'api.arcgate.dev', '',
  ]) assert.throws(() => apiOrigin(value), `${JSON.stringify(value)} must be refused`);
});

test('loadConfig reads API_URL, ARC_RPC_URL and WEBHOOK_URL, and defaults to the public API', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.apiUrl, 'https://api.arcgate.dev');
  assert.equal(new URL(defaults.rpcUrl).protocol, 'https:');
  assert.equal(new URL(defaults.webhookUrl).protocol, 'https:', 'a webhook url must be https');

  const local = loadConfig({ API_URL: 'http://127.0.0.1:19800', ARC_RPC_URL: 'http://127.0.0.1:19845', WEBHOOK_URL: 'https://192.0.2.10/somewhere' });
  assert.equal(local.apiUrl, 'http://127.0.0.1:19800');
  assert.equal(local.rpcUrl, 'http://127.0.0.1:19845');
  assert.equal(local.webhookUrl, 'https://192.0.2.10/somewhere');
  assert.throws(() => loadConfig({ API_URL: 'http://api.arcgate.dev' }));
  assert.throws(() => loadConfig({ API_URL: 'https://api.arcgate.dev/agent' }));
});

test('the default caps are positive, per run at least per call, and cover the whole captured run', () => {
  const fixture = loadFixture(), price = prices(fixture), config = loadConfig({});
  assert.equal(typeof config.maxPayment, 'bigint');
  assert.equal(typeof config.maxTotal, 'bigint');
  assert.ok(config.maxPayment > 0n && config.maxTotal >= config.maxPayment);
  for (const operationId of PAID) assert.ok(BigInt(price[operationId]) <= config.maxPayment, `${operationId} costs more than the per-call cap`);
  const paid = runExchanges(fixture).filter(e => e.status < 300 && e.headers['payment-response']);
  assert.ok(paid.length > 0);
  const total = paid.reduce((sum, e) => sum + BigInt(price[operationId(e)]), 0n);
  assert.ok(total <= config.maxTotal, `a full run pays ${total}, over the per-run cap ${config.maxTotal}`);
});

test('the per-run cap covers a run on a fresh box', () => {
  // boxCreate + inboundCreate + 3 watchCreate + tradeSearch + webhookCreate + boxTopUp, at the captured prices
  const price = prices(loadFixture());
  const run = ['boxCreate', 'inboundCreate', 'watchCreate', 'watchCreate', 'watchCreate', 'tradeSearch', 'webhookCreate', 'boxTopUp'];
  const total = run.reduce((sum, operation) => sum + BigInt(price[operation]), 0n);
  assert.ok(total <= loadConfig({}).maxTotal, `a run on a fresh box pays ${total}, over the per-run cap ${loadConfig({}).maxTotal}`);
});

function operationId(exchange) {
  return operationOf(exchange.method, exchange.path);
}

// the payment network ---------------------------------------------------------------------------

test('only Arc mainnet eip155:5042 and Arc testnet eip155:5042002 are payment networks', () => {
  assert.deepEqual(ALLOWED_NETWORKS, { 'eip155:5042': 5042, 'eip155:5042002': 5042002 });
});

test('a /health that names any other payment network is refused before anything is signed', async () => {
  const fixture = loadFixture(), config = loadConfig({ API_URL: fixture.apiUrl });
  for (const network of ['eip155:1', 'eip155:5043', 'eip155:50420020', 'eip155:11155111', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'eip155:5042 ', '5042', '']) {
    const body = clone(health(fixture));
    body.x402.network = network;
    const { fetch } = staticFetch({ health: body, openapi: openapi(fixture).body });
    await assert.rejects(loadTerms(config, fetch), `network ${JSON.stringify(network)} must be refused`);
  }
  for (const network of Object.keys(ALLOWED_NETWORKS)) {
    const body = clone(health(fixture));
    body.x402.network = network;
    const { fetch } = staticFetch({ health: body, openapi: openapi(fixture).body });
    assert.equal((await loadTerms(config, fetch)).health.x402.network, network);
  }
});

// the inbound url -------------------------------------------------------------------------------
// An inbound url is the notifier's origin and the address id, so it has one path segment. The rest of the
// rule is the API_URL rule: https, or http only on localhost and 127.0.0.1, with no credentials, query or fragment.

const id = 'AbCdEfGhIjKlMnOpQrStUv';
const inboundBody = { run: 'x' };

test('an inbound url is posted to on https, or on loopback http, and nowhere else', async () => {
  for (const url of [`https://in.arcgate.dev/${id}`, `http://127.0.0.1:19803/${id}`, `http://localhost:19803/${id}`]) {
    const urls = [];
    const fetchFn = async target => { urls.push(target); return Response.json({}, { status: 201 }); };
    assert.equal((await postInbound({ url, secret: 's', body: inboundBody, mode: 'secret', now: Date.now, fetchFn })).status, 201);
    assert.deepEqual(urls, [url]);
  }
});

test('an inbound url with plain http elsewhere, credentials, a query or a fragment is refused with nothing sent', async () => {
  for (const url of [
    `http://in.arcgate.dev/${id}`, `http://192.0.2.10/${id}`, `http://127.0.0.2:19803/${id}`, `ftp://in.arcgate.dev/${id}`,
    `https://user:pass@in.arcgate.dev/${id}`, `http://user@127.0.0.1:19803/${id}`,
    `https://in.arcgate.dev/${id}?x=1`, `https://in.arcgate.dev/${id}#frag`, id, '',
  ]) {
    let sent = 0;
    const fetchFn = async () => { sent++; return Response.json({}, { status: 201 }); };
    await assert.rejects(postInbound({ url, secret: 's', body: inboundBody, mode: 'secret', now: Date.now, fetchFn }), `${JSON.stringify(url)} must be refused`);
    assert.equal(sent, 0, `${JSON.stringify(url)} was posted to`);
  }
});

// errors ----------------------------------------------------------------------------------------

test('reportError never prints the private key, the RPC url or any other url', () => {
  const key = `0x${'ab'.repeat(32)}`, rpc = 'https://rpc.example.com/v1/apikey123';
  const printed = [], original = console.error, exitCode = process.exitCode;
  console.error = text => printed.push(text);
  try {
    reportError(new Error(`failed with ${key} at ${rpc} and also https://other.example.com/x?token=abc (see ${rpc}).`), { PRIVATE_KEY: key, ARC_RPC_URL: rpc });
    assert.equal(process.exitCode, 1);
  } finally { console.error = original; process.exitCode = exitCode; }
  assert.equal(printed.length, 1);
  assert.ok(!printed[0].includes(key.slice(2)));
  assert.ok(!printed[0].includes('apikey123') && !printed[0].includes('example.com') && !printed[0].includes('token=abc'));
  assert.ok(printed[0].includes('[URL]'));
});
