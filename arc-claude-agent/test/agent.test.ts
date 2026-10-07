import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import { agentSignature } from '../src/agent.ts';
import { testConfig } from './test-config.ts';
import { agentRequestTypes, bodyHash, EMPTY_BODY_HASH, noNetwork, OWNER_REQUESTS, recoverAgent } from './support.ts';

globalThis.fetch = noNetwork;

test('agentSignature signs AgentRequest over GET /agent/v1/<lowercased address>/box/status', async () => {
  const { account } = testConfig();
  const address = account.address; // checksummed: the signed path must still be lowercase
  assert.notEqual(address, address.toLowerCase());
  const request = OWNER_REQUESTS.boxStatus(address);

  const before = Math.floor(Date.now() / 1000);
  const signed = await agentSignature(account, request);
  const after = Math.floor(Date.now() / 1000);

  assert.match(signed.signature, /^0x[0-9a-fA-F]+$/);
  assert.match(signed.nonce, /^0x[0-9a-fA-F]{64}$/, 'a 32-byte nonce');
  assert.ok(Number.isInteger(signed.expiry));
  assert.ok(signed.expiry > after, 'the expiry is in the future');
  assert.ok(signed.expiry <= before + 300, 'and within the 300 s the server allows');

  assert.equal(EMPTY_BODY_HASH, keccak256('0x'), 'the body hash is keccak256 of no bytes');
  assert.equal(await recoverAgent(address, signed, request), address, 'the key signs it');

  // The typed data is exactly the server's: a different domain, path casing or method recovers someone else.
  const recover = (over: { domain?: Record<string, unknown>; path?: string; method?: string }) => recoverTypedDataAddress({
    domain: { name: 'arcgate', version: '1', ...over.domain },
    types: agentRequestTypes,
    primaryType: 'AgentRequest',
    message: { address, method: over.method ?? 'GET', path: over.path ?? request.path, bodyHash: EMPTY_BODY_HASH, nonce: signed.nonce, expiry: BigInt(signed.expiry) },
    signature: signed.signature,
  });
  assert.equal(await recover({}), address);
  assert.notEqual(await recover({ domain: { chainId: 5042002 } }), address, 'no chainId in the domain');
  assert.notEqual(await recover({ path: `/agent/v1/${address}/box/status` }), address, 'the path is lowercased');
  assert.notEqual(await recover({ method: 'POST' }), address);
});

test('every signed tool recovers to the key under its own method, path and body hash', async () => {
  const { account } = testConfig();
  const address = account.address;
  const requests = {
    'boxStatus: GET, no body': OWNER_REQUESTS.boxStatus(address),
    'watchList: GET, no body': OWNER_REQUESTS.watchList(address),
    'boxMessageList: GET, no query sent, no body': OWNER_REQUESTS.boxMessageList(address, {}),
    'boxMessageList: cursor only': OWNER_REQUESTS.boxMessageList(address, { cursor: 4 }),
    'boxMessageList: limit only': OWNER_REQUESTS.boxMessageList(address, { limit: 25 }),
    'boxMessageList: cursor and limit': OWNER_REQUESTS.boxMessageList(address, { cursor: 4, limit: 25 }),
    'boxMessageDelete: DELETE, seq in the path, no body': OWNER_REQUESTS.boxMessageDelete(address, 7),
  };
  for (const [what, request] of Object.entries(requests)) {
    const signed = await agentSignature(account, request.body === undefined ? { method: request.method, path: request.path } : { method: request.method, path: request.path, body: JSON.parse(request.body) });
    assert.equal(await recoverAgent(address, signed, request), address, what);
  }
  assert.equal(requests['boxMessageList: cursor only'].body, '{"cursor":4}', 'the cursor-only list signs {"cursor":N}');
  assert.equal(requests['boxMessageList: limit only'].body, '{"limit":25}');
  assert.equal(requests['boxMessageList: cursor and limit'].body, '{"cursor":4,"limit":25}');
  assert.equal(requests['boxMessageList: GET, no query sent, no body'].body, undefined);
});

test('the body hash is the keccak256 of the canonical JSON: sorted keys at every depth, no whitespace', async () => {
  const { account } = testConfig();
  const address = account.address;
  const request = { method: 'GET', path: `/agent/v1/${address.toLowerCase()}/box/messages` };

  // Keys given in reverse order recover under the sorted text, and under no other.
  const signed = await agentSignature(account, { ...request, body: { limit: 5, cursor: 3 } });
  assert.equal(await recoverAgent(address, signed, { ...request, body: '{"cursor":3,"limit":5}' }), address);
  assert.notEqual(await recoverAgent(address, signed, { ...request, body: '{"limit":5,"cursor":3}' }), address, 'not JSON.stringify of the keys as given');
  assert.notEqual(await recoverAgent(address, signed, { ...request, body: '{"cursor": 3, "limit": 5}' }), address, 'no whitespace');
  assert.notEqual(await recoverAgent(address, signed, request), address, 'a body is not the empty hash');

  const nested = await agentSignature(account, { ...request, body: { z: 1, b: { y: [{ d: 1, c: 2 }], x: null }, a: 'é"\n' } });
  const text = '{"a":"é\\"\\n","b":{"x":null,"y":[{"c":2,"d":1}]},"z":1}';
  assert.equal(bodyHash(text), keccak256(toBytes(text)));
  assert.equal(await recoverAgent(address, nested, { ...request, body: text }), address, 'nested keys are sorted, arrays keep their order');
});

test('every call draws a fresh nonce and an expiry within the 300 s the server allows', async () => {
  const { account } = testConfig();
  const request = OWNER_REQUESTS.watchList(account.address);
  const first = await agentSignature(account, request);
  const second = await agentSignature(account, request);
  assert.notEqual(first.nonce, second.nonce, 'each nonce is accepted once, so each call draws its own');
  assert.notEqual(first.signature, second.signature);
  assert.equal(await recoverAgent(account.address, second, request), account.address);
  const now = Math.floor(Date.now() / 1000);
  for (const { expiry } of [first, second]) assert.ok(expiry > now - 1 && expiry <= now + 300, 'within the 300 s the server allows');
});
