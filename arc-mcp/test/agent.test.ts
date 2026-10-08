import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, recoverTypedDataAddress } from 'viem';
import { agentSignature } from '../src/agent.ts';
import { testConfig } from './test-config.ts';
import { agentRequestTypes, EMPTY_BODY_HASH, noNetwork, recoverAgent } from './support.ts';

globalThis.fetch = noNetwork;

test('agentSignature signs AgentRequest over GET /agent/v1/<lowercased address>/box/status', async () => {
  const config = testConfig();
  const address = config.agent.address; // checksummed: the signed path must still be lowercase
  assert.notEqual(address, address.toLowerCase());

  const before = Math.floor(Date.now() / 1000);
  const signed = await agentSignature(config.agent, address);
  const after = Math.floor(Date.now() / 1000);

  assert.match(signed.signature, /^0x[0-9a-fA-F]+$/);
  assert.match(signed.nonce, /^0x[0-9a-fA-F]{64}$/, 'a 32-byte nonce');
  assert.ok(Number.isInteger(signed.expiry));
  assert.ok(signed.expiry > after, 'the expiry is in the future');
  assert.ok(signed.expiry <= before + 300, 'and within the 300 s the server allows');

  assert.equal(EMPTY_BODY_HASH, keccak256('0x'), 'the body hash is keccak256 of no bytes');
  assert.equal(await recoverAgent(address, signed), config.agent.address, 'the agent key signs it');
  assert.notEqual(await recoverAgent(address, signed), config.payer.address, 'not the payer');

  // The typed data is exactly the server's: a different domain, path casing or method recovers someone else.
  const recover = (over: { domain?: Record<string, unknown>; path?: string; method?: string }) => recoverTypedDataAddress({
    domain: { name: 'arcgate', version: '1', ...over.domain },
    types: agentRequestTypes,
    primaryType: 'AgentRequest',
    message: { address, method: over.method ?? 'GET', path: over.path ?? `/agent/v1/${address.toLowerCase()}/box/status`, bodyHash: EMPTY_BODY_HASH, nonce: signed.nonce, expiry: BigInt(signed.expiry) },
    signature: signed.signature,
  });
  assert.equal(await recover({}), config.agent.address);
  assert.notEqual(await recover({ domain: { chainId: 5042 } }), config.agent.address, 'no chainId in the domain');
  assert.notEqual(await recover({ path: `/agent/v1/${address}/box/status` }), config.agent.address, 'the path is lowercased');
  assert.notEqual(await recover({ method: 'POST' }), config.agent.address);
});

test('agentSignature takes the clock from its caller and is fresh every call', async () => {
  const config = testConfig();
  const now = 1_800_000_000;
  const first = await agentSignature(config.agent, config.agent.address, now);
  const second = await agentSignature(config.agent, config.agent.address, now);
  assert.ok(first.expiry > now && first.expiry <= now + 300);
  assert.notEqual(first.nonce, second.nonce, 'each nonce is accepted once, so each call draws its own');
  assert.notEqual(first.signature, second.signature);
  assert.equal(await recoverAgent(config.agent.address, second), config.agent.address);
});
