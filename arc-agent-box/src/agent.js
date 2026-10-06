import { randomBytes } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { OWNER_OPERATIONS } from './config.js';
import { readApiResponse, request } from './http.js';

// Deterministic JSON with recursively sorted keys and no whitespace: the bytes arcgate hashes
// (behaviour of arcgate's packages/core/src/canonicalJson.ts, written out here).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The AgentRequest an owner call signs: who, what, where, a hash of the body, a nonce and an expiry.
// The domain has no chainId: an agent's key signs for no chain.
export function agentTypedData({ address, method, path, body, nonce, expiry }) {
  return {
    domain: { name: 'arcgate', version: '1' },
    types: { AgentRequest: [
      { name: 'address', type: 'address' }, { name: 'method', type: 'string' }, { name: 'path', type: 'string' },
      { name: 'bodyHash', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint64' },
    ] },
    primaryType: 'AgentRequest',
    message: {
      address, method, path,
      bodyHash: body === undefined ? keccak256('0x') : keccak256(toBytes(canonicalJson(body))),
      nonce, expiry: BigInt(expiry),
    },
  };
}

// The path an owner call signs and sends: the address lowercased, {seq} and {id} filled in.
export function signedPath(template, address, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = key === 'address' ? address.toLowerCase() : params[key];
    if (value === undefined || !/^[\w-]+$/.test(String(value))) throw new Error(`The ${key} for a path must be letters, digits, - or _.`);
    return String(value);
  });
}

// The one owner-call function: free calls the box's own address signs, never a paid one.
export function createAgentClient({ wallet, config, fetchFn = fetch, record = () => {} }) {
  return async function signedCall(operationId, params = {}, { query = {} } = {}) {
    const operation = OWNER_OPERATIONS[operationId];
    if (!operation) throw new Error(`${operationId} is not an owner call this tutorial signs.`);
    const [method, template] = operation;
    const path = signedPath(template, wallet.address, params);
    // The query is the signed body: the cursor and limit actually sent, as numbers. With none, no body.
    const sent = Object.keys(query).length > 0 ? query : undefined;
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const signature = await wallet.signTypedData(agentTypedData({ address: wallet.address, method, path, body: sent, nonce, expiry }));
    const search = sent ? `?${new URLSearchParams(Object.entries(sent).map(([key, value]) => [key, String(value)]))}` : '';
    const response = await request(fetchFn, `${config.apiUrl}${path}${search}`, {
      method, headers: { 'AGENT-SIGNATURE': signature, 'AGENT-NONCE': nonce, 'AGENT-EXPIRY': String(expiry) },
    });
    return readApiResponse(operationId, response, record);
  };
}
