import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTypedData, canonicalJson, createAgentClient, signedPath } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ArcgateError } from '../src/http.js';
import { keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import { OPERATIONS, OWNER, SPEC, makeWallet, templateOf } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const config = loadConfig({});
const { account, wallet } = makeWallet();
const lower = account.address.toLowerCase();
const id = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url characters, the shape of an inbound, watch or channel id
assert.notEqual(account.address, lower, 'the generated address must be mixed case so lowercasing is exercised');

// canonicalJson ---------------------------------------------------------------------------------

test('canonicalJson sorts keys recursively and writes no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1},3]},"b":1}');
  assert.equal(canonicalJson({ b: 1, a: 2, B: 3, 10: 4, 9: 5 }), '{"10":4,"9":5,"B":3,"a":2,"b":1}');
  assert.equal(canonicalJson([3, { b: true, a: false }, 'x']), '[3,{"a":false,"b":true},"x"]');
  assert.equal(canonicalJson({ 'é': 'ü\n"' }), '{"é":"ü\\n\\""}');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson(5), '5');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('a b'), '"a b"');
});

test('canonicalJson gives the same text whatever order the keys were written in', () => {
  const one = { cursor: 10, limit: 50, nested: { b: [1, { y: 1, x: 2 }], a: 'q' } };
  const two = { nested: { a: 'q', b: [1, { x: 2, y: 1 }] }, limit: 50, cursor: 10 };
  assert.equal(canonicalJson(one), canonicalJson(two));
});

// the typed data --------------------------------------------------------------------------------

const nonce = `0x${'ab'.repeat(32)}`;
const expiry = 1_900_000_000;
const path = `/agent/v1/${lower}/box/messages/7`;

test('signedPath lowercases the address and fills {seq} and {id}', () => {
  assert.equal(signedPath(templateOf('boxMessageFetch'), account.address, { seq: '7' }), path);
  assert.equal(signedPath(templateOf('boxMessageFetch'), account.address, { seq: 7 }), `/agent/v1/${lower}/box/messages/7`);
  assert.equal(signedPath(templateOf('inboundRotate'), account.address, { id }), `/agent/v1/${lower}/inbound/${id}/rotate`);
  assert.equal(signedPath(templateOf('webhookDelete'), account.address, { id }), `/agent/v1/${lower}/webhook/${id}`);
  assert.equal(signedPath(templateOf('boxStatus'), account.address), `/agent/v1/${lower}/box/status`);
});

test('the typed data has the arcgate domain with no chainId and the documented AgentRequest fields', () => {
  const typed = agentTypedData({ address: account.address, method: 'DELETE', path, nonce, expiry });
  assert.deepEqual(typed.domain, SPEC.domain);
  assert.equal('chainId' in typed.domain, false);
  assert.equal(typed.primaryType, 'AgentRequest');
  assert.deepEqual(typed.types, SPEC.types);
  assert.equal(typed.message.address.toLowerCase(), lower);
  assert.equal(typed.message.method, 'DELETE');
  assert.equal(typed.message.path, path);
  assert.equal(typed.message.nonce, nonce);
  assert.equal(BigInt(typed.message.expiry), BigInt(expiry));
});

test('bodyHash is keccak256 of the canonical JSON, and keccak256 of no bytes without a body', () => {
  const body = { limit: 50, cursor: 10, deep: { b: [1, { y: 1, x: 2 }], a: 'é' } };
  const typed = agentTypedData({ address: account.address, method: 'POST', path, body, nonce, expiry });
  assert.equal(typed.message.bodyHash, keccak256(toBytes('{"cursor":10,"deep":{"a":"é","b":[1,{"x":2,"y":1}]},"limit":50}')));

  assert.equal(keccak256('0x'), SPEC.noBodyHash);
  assert.equal(agentTypedData({ address: account.address, method: 'GET', path, nonce, expiry }).message.bodyHash, SPEC.noBodyHash);
  assert.equal(agentTypedData({ address: account.address, method: 'GET', path, body: undefined, nonce, expiry }).message.bodyHash, SPEC.noBodyHash);
  // An empty object is a body: it hashes as '{}', not as no body.
  assert.equal(agentTypedData({ address: account.address, method: 'POST', path, body: {}, nonce, expiry }).message.bodyHash, keccak256(toBytes('{}')));
});

// signed owner calls ----------------------------------------------------------------------------

function expectedTyped({ method, path: signedFor, bodyHash, nonce: n, expiry: e }) {
  return { domain: { name: 'arcgate', version: '1' }, types: SPEC.types, primaryType: 'AgentRequest',
    message: { address: account.address, method, path: signedFor, bodyHash, nonce: n, expiry: BigInt(e) } };
}

function setup(respond = () => Response.json({ ok: true })) {
  const requests = [], typedData = [];
  const spy = { address: wallet.address, signTypedData: data => { typedData.push(data); return wallet.signTypedData(data); } };
  const signedCall = createAgentClient({ wallet: spy, config, fetchFn: async (url, init) => { requests.push({ url, init, headers: new Headers(init.headers) }); return respond(url, init); } });
  return { signedCall, requests, typedData };
}

async function recovers(request, { method, expectedPath, bodyHash }) {
  const signature = request.headers.get('agent-signature'), n = request.headers.get('agent-nonce'), e = request.headers.get('agent-expiry');
  assert.match(signature, /^0x[0-9a-fA-F]+$/);
  assert.match(n, /^0x[0-9a-fA-F]{64}$/);
  assert.match(e, /^\d+$/);
  const recovered = await recoverTypedDataAddress({ ...expectedTyped({ method, path: expectedPath, bodyHash, nonce: n, expiry: e }), signature });
  assert.equal(recovered, account.address);
  return { nonce: n, expiry: Number(e) };
}

const ownerCases = OPERATIONS.filter(([operationId]) => OWNER.includes(operationId)).map(([operationId, method, template]) => ({
  operationId, method, params: { seq: '7', id }, expectedPath: template.replace('{address}', lower).replace('{seq}', '7').replace('{id}', id),
}));

for (const { operationId, method, params, expectedPath } of ownerCases) {
  test(`${operationId}: a ${method} signed over its lowercased path with no body, recovering to the wallet`, async () => {
    const { signedCall, requests, typedData } = setup();
    const before = Math.floor(Date.now() / 1000);
    assert.deepEqual(await signedCall(operationId, params), { ok: true });
    const after = Math.floor(Date.now() / 1000);

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.url, `${config.apiUrl}${expectedPath}`);
    assert.equal(request.init.method, method);
    assert.equal(request.init.redirect, 'error');
    assert.ok(request.init.signal instanceof AbortSignal, 'a timeout');
    assert.equal(request.init.body, undefined);
    assert.equal(request.headers.get('payment-signature'), null);

    const { expiry: signedExpiry } = await recovers(request, { method, expectedPath, bodyHash: SPEC.noBodyHash });
    assert.ok(signedExpiry > before, 'the signature is still valid when it is sent');
    assert.ok(signedExpiry <= after + 300, 'the signature lives 300 seconds at most');
    assert.equal(typedData.length, 1);
    assert.equal('chainId' in typedData[0].domain, false);
  });
}

test('every call carries a fresh nonce', async () => {
  const { signedCall, requests } = setup();
  for (let i = 0; i < 25; i++) await signedCall('boxStatus', {});
  const nonces = requests.map(request => request.headers.get('agent-nonce'));
  assert.equal(new Set(nonces).size, 25);
});

test('the list query is the signed body, as numbers, and only what is sent', async () => {
  const cases = [
    [{ cursor: 10, limit: 50 }, '{"cursor":10,"limit":50}'],
    [{ limit: 5 }, '{"limit":5}'],
    [{ cursor: 0, limit: 5 }, '{"cursor":0,"limit":5}'],
    [{ limit: 5, cursor: 12 }, '{"cursor":12,"limit":5}'],
  ];
  for (const [query, signedBody] of cases) {
    const { signedCall, requests } = setup(() => Response.json({ messages: [], nextCursor: query.cursor ?? 0 }));
    assert.deepEqual(await signedCall('boxMessageList', {}, { query }), { messages: [], nextCursor: query.cursor ?? 0 });
    const url = new URL(requests[0].url);
    const expectedPath = `/agent/v1/${lower}/box/messages`;
    assert.equal(url.pathname, expectedPath);
    assert.deepEqual([...url.searchParams.keys()].sort(), Object.keys(query).sort());
    for (const [key, value] of Object.entries(query)) assert.equal(url.searchParams.get(key), String(value));
    assert.equal(requests[0].init.body, undefined);
    await recovers(requests[0], { method: 'GET', expectedPath, bodyHash: keccak256(toBytes(signedBody)) });
  }
});

test('a list with no query signs no body and sends no query', async () => {
  for (const options of [undefined, {}, { query: {} }]) {
    const { signedCall, requests } = setup();
    await signedCall('boxMessageList', {}, options);
    assert.equal(new URL(requests[0].url).search, '');
    await recovers(requests[0], { method: 'GET', expectedPath: `/agent/v1/${lower}/box/messages`, bodyHash: SPEC.noBodyHash });
  }
});

test('an API error reaches the caller with its status and code', async () => {
  const { signedCall } = setup(() => Response.json({ error: { code: 'signature_expired', hint: 'sign again' } }, { status: 401, headers: { 'x-request-id': 'req-1' } }));
  await assert.rejects(signedCall('boxStatus', {}), error => error instanceof ArcgateError && error.status === 401 && error.body.error.code === 'signature_expired');
});

test('only the owner operations are signed: no enable, no Telegram, no paid create', async () => {
  for (const operationId of ['webhookEnable', 'telegramCreate', 'telegramList', 'telegramDelete', 'telegramLink', 'boxCreate', 'boxTopUp', 'inboundCreate', 'watchCreate', 'webhookCreate', 'tradeSearch']) {
    const { signedCall, requests, typedData } = setup();
    await assert.rejects(signedCall(operationId, { id, seq: '1' }), `${operationId} must be refused`);
    assert.equal(requests.length, 0, `${operationId} sent a request`);
    assert.equal(typedData.length, 0, `${operationId} was signed`);
  }
});
