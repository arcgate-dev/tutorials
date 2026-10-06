import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Offline replay of test/fixtures/localnet.json, the exchanges the tutorial's own capture mode
// recorded during the localnet run. Nothing here talks to a network. Every value a test needs
// (address, ids, prices, payTo, network, secrets' shape) comes from the fixture, never a literal.
//
// Fixture shape (written by src/capture.js):
//   { capturedAt, apiUrl, apiCommit, address, exchanges: [
//       { method, path, requestBody?, status, headers, body? } ] }
// `path` is the pathname plus query with the origin stripped. `requestBody` is the JSON request body,
// when there was one. `headers` are the response headers payment-required, payment-response,
// x-request-id and content-type (lowercase names). `body` is the parsed JSON response body.
//
// Capture contract: the capture is `start`, then `topup` run twice more under the same recorder, each as
// its own command run with its own paid client and per-run cap. The first extra topup is charged and
// grants the messages used during the run; the second is answered 409 allowance_full. So the fixture
// ends with a trailing block of boxTopUp exchanges (and the free reads each command run makes first),
// after the start run's final signed GETs. runExchanges() returns the start run without that block.

export const SPEC = {
  domain: { name: 'arcgate', version: '1' },
  types: { AgentRequest: [
    { name: 'address', type: 'address' }, { name: 'method', type: 'string' }, { name: 'path', type: 'string' },
    { name: 'bodyHash', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint64' },
  ] },
  noBodyHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', // keccak256('0x')
  usdc: '0x3600000000000000000000000000000000000000',
  authorizationTypes: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
};

// operationId, method, path template: copied from arcgate's OpenAPI document (/agent/v1) and /trade/v1/search.
export const OPERATIONS = [
  ['boxStatus', 'GET', '/agent/v1/{address}/box/status'],
  ['boxCreate', 'POST', '/agent/v1/{address}/box'],
  ['boxTopUp', 'POST', '/agent/v1/{address}/box/topup'],
  ['boxMessageList', 'GET', '/agent/v1/{address}/box/messages'],
  ['boxMessageFetch', 'GET', '/agent/v1/{address}/box/messages/{seq}'],
  ['boxMessageDelete', 'DELETE', '/agent/v1/{address}/box/messages/{seq}'],
  ['inboundCreate', 'POST', '/agent/v1/{address}/inbound'],
  ['inboundList', 'GET', '/agent/v1/{address}/inbound/list'],
  ['inboundDelete', 'DELETE', '/agent/v1/{address}/inbound/{id}'],
  ['inboundRotate', 'POST', '/agent/v1/{address}/inbound/{id}/rotate'],
  ['watchCreate', 'POST', '/agent/v1/{address}/watch'],
  ['watchList', 'GET', '/agent/v1/{address}/watch/list'],
  ['watchDelete', 'DELETE', '/agent/v1/{address}/watch/{id}'],
  ['webhookCreate', 'POST', '/agent/v1/{address}/webhook'],
  ['webhookList', 'GET', '/agent/v1/{address}/webhook/list'],
  ['webhookDelete', 'DELETE', '/agent/v1/{address}/webhook/{id}'],
  ['webhookRotate', 'POST', '/agent/v1/{address}/webhook/{id}/rotate'],
  ['webhookEnable', 'POST', '/agent/v1/{address}/webhook/{id}/enable'],
  ['tradeSearch', 'POST', '/trade/v1/search'],
];
export const PAID = ['boxCreate', 'boxTopUp', 'inboundCreate', 'watchCreate', 'webhookCreate', 'tradeSearch'];
export const OWNER = OPERATIONS.map(([id]) => id).filter(id => !PAID.includes(id) && id !== 'webhookEnable');

const pattern = template => new RegExp(`^${template.replace('{address}', '0x[0-9a-fA-F]{40}').replace('{seq}', '\\d+').replace('{id}', '[A-Za-z0-9_-]{22}')}$`);
const PATTERNS = OPERATIONS.map(([id, method, template]) => ({ id, method, regex: pattern(template) }));
export const INBOUND_POST = /^\/[A-Za-z0-9_-]{22}$/;

// The operationId of a request, or 'inboundPost' for a post to an inbound address, or null.
export function operationOf(method, path) {
  const pathname = path.split('?')[0];
  if (method === 'POST' && INBOUND_POST.test(pathname)) return 'inboundPost';
  return PATTERNS.find(p => p.method === method && p.regex.test(pathname))?.id ?? null;
}

export function templateOf(operationId) {
  return OPERATIONS.find(([id]) => id === operationId)[2];
}

export function loadFixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/localnet.json', import.meta.url), 'utf8'));
}

export const isFree = exchange => exchange.method === 'GET' && (exchange.path === '/health' || exchange.path === '/openapi.json');

// The exchanges of the start run: the fixture with its trailing block of boxTopUp exchanges (the two
// extra topup command runs, and the free reads they begin with) cut off. start ends with signed GETs,
// so the boundary is clean.
export function runExchanges(fixture) {
  const end = fixture.exchanges.findLastIndex(exchange => !isFree(exchange) && operationOf(exchange.method, exchange.path) !== 'boxTopUp');
  return fixture.exchanges.slice(0, end + 1);
}

// operationId -> x-payment baseUnits, read straight from the captured /openapi.json.
export function prices(fixture) {
  const spec = fixture.exchanges.find(e => e.method === 'GET' && e.path === '/openapi.json').body;
  const out = {};
  for (const methods of Object.values(spec.paths)) {
    for (const operation of Object.values(methods)) if (operation['x-payment']) out[operation.operationId] = operation['x-payment'].baseUnits;
  }
  return out;
}

export const health = fixture => fixture.exchanges.find(e => e.method === 'GET' && e.path === '/health').body;
export const openapi = fixture => fixture.exchanges.find(e => e.method === 'GET' && e.path === '/openapi.json');

export function makeWallet(address) {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  return { account, wallet: { address: getAddress(address ?? account.address), signTypedData: data => account.signTypedData(data) } };
}

export const acceptedOf = entry => decodePaymentSignatureHeader(entry.headers['payment-signature']);
export const hmacHex = (secret, timestamp, body) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${timestamp}.`).update(Buffer.from(body)).digest('hex');
export const clone = value => structuredClone(value);

function replayError(code, message) {
  return Object.assign(new Error(`replay: ${message}`), { code });
}

// A fetch that serves the captured exchanges in order and records every request it saw.
//  - GET /health and GET /openapi.json are free reads: served from the fixture's first capture of each,
//    any number of times, outside the ordered queue (a step may load the terms itself).
//  - Every other request must be the next queued exchange: same method and path, and, for the API's
//    own origin, the same JSON body when the capture recorded one. Anything else throws.
//  - Once the queue is spent, `pool` answers by method and path, as often as asked (polling scenarios).
//  - More than `limit` requests throws code REPLAY_LIMIT: a runaway loop in the code under test.
export function createReplay(fixture, { queue = fixture.exchanges, pool = [], limit = 500 } = {}) {
  const apiOrigin = new URL(fixture.apiUrl).origin;
  const free = new Map();
  for (const exchange of fixture.exchanges) if (isFree(exchange) && !free.has(exchange.path)) free.set(exchange.path, exchange);
  const ordered = queue.filter(exchange => !isFree(exchange));
  const trace = [], consumed = [];
  let index = 0, requests = 0;

  async function fetch(url, init = {}) {
    const target = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = target.pathname + target.search;
    const headers = Object.fromEntries(new Headers(init.headers));
    const entry = { method, path, origin: target.origin, headers, body: init.body == null ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'), redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal,
      operation: null, free: false, status: null, response: null };
    trace.push(entry);
    if (++requests > limit) throw replayError('REPLAY_LIMIT', `more than ${limit} requests; ${method} ${path}`);

    let exchange;
    if (method === 'GET' && target.origin === apiOrigin && free.has(target.pathname) && !target.search) {
      exchange = free.get(target.pathname);
      entry.free = true;
    } else {
      entry.operation = operationOf(method, path);
      if (index < ordered.length) {
        exchange = ordered[index];
        if (exchange.method !== method || exchange.path !== path) {
          throw replayError('REPLAY_MISMATCH', `expected ${exchange.method} ${exchange.path} but got ${method} ${path} (request ${index + 1} of ${ordered.length})`);
        }
        index++;
        consumed.push(exchange);
      } else {
        exchange = pool.find(candidate => candidate.method === method && candidate.path === path);
        if (!exchange) throw replayError('REPLAY_UNEXPECTED', `no captured exchange left for ${method} ${path}`);
      }
      if (target.origin === apiOrigin) {
        if (exchange.requestBody === undefined) {
          if (init.body != null) throw replayError('REPLAY_BODY', `${method} ${path} sent a body, the capture had none`);
        } else if (JSON.stringify(canonical(JSON.parse(init.body ?? 'null'))) !== JSON.stringify(canonical(exchange.requestBody))) {
          throw replayError('REPLAY_BODY', `${method} ${path} sent a body that differs from the capture: ${init.body}`);
        }
      }
    }
    entry.status = exchange.status;
    entry.response = exchange.body;
    return new Response(exchange.body === undefined ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
  }

  return { fetch, trace, consumed, leftover: () => ordered.slice(index) };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export const operations = trace => trace.filter(entry => !entry.free).map(entry => entry.operation);
export const apiTrace = trace => trace.filter(entry => !entry.free);

// A fetch answering GET /health and GET /openapi.json with the given bodies (copies of the captured
// ones, edited by the test). Anything else throws.
export function staticFetch({ health: healthBody, openapi: openapiBody }) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    requests.push({ method: (init.method ?? 'GET').toUpperCase(), path: target.pathname + target.search, headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
    if (requests.at(-1).method === 'GET' && target.pathname === '/health') return Response.json(healthBody);
    if (requests.at(-1).method === 'GET' && target.pathname === '/openapi.json') return Response.json(openapiBody);
    throw new Error(`staticFetch: unexpected request ${target.pathname}`);
  };
  return { fetch, requests };
}
