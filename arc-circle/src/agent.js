import { randomBytes } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { signTypedData } from './circle.js';
import { agentRequestTypes, OWNER_OPERATIONS } from './config.js';
import { assertAgentRequest } from './guards.js';
import { readApiResponse } from './errors.js';
import { request } from './http.js';

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
// The ONE place the domain is built. Circle's signTypedData refuses a domain with no chainId matching the wallet's
// chain, so chainId is the Arc/trade chain (config.tradeChainId, 5042 on mainnet and on the localnet fork of it): the
// chain arcgate's notifier serves. It is NOT the x402 payment network (5042002 on the localnet row).
export function agentTypedData({ address, method, path, body, nonce, expiry, chainId }) {
  return {
    domain: { name: 'arcgate', version: '1', chainId },
    types: structuredClone(agentRequestTypes),
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

// The owner calls' signer: only an AgentRequest for this wallet and this chain goes to Circle.
export function circleSigner({ circle, wallet, config }) {
  return {
    address: wallet.address,
    signTypedData(data) {
      assertAgentRequest(data, wallet, config);
      return signTypedData(circle, wallet, data);
    },
  };
}

// The one owner-call function: free calls the wallet's own address signs, never a paid one.
// `signer` is { address, signTypedData(typedData) }.
export function createAgentClient({ signer, config, fetchFn = fetch, record = () => {} }) {
  return async function signedCall(operationId, params = {}, { query = {} } = {}) {
    if (!Object.hasOwn(OWNER_OPERATIONS, operationId)) throw new Error(`${operationId} is not an owner call this tutorial signs.`);
    const [method, template] = OWNER_OPERATIONS[operationId];
    const path = signedPath(template, signer.address, params);
    // The query is the signed body: the cursor and limit actually sent, as numbers. With none, no body.
    const sent = Object.keys(query).length > 0 ? query : undefined;
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const signature = await signer.signTypedData(agentTypedData({ address: signer.address, method, path, body: sent, nonce, expiry, chainId: config.tradeChainId }));
    const search = sent ? `?${new URLSearchParams(Object.entries(sent).map(([key, value]) => [key, String(value)]))}` : '';
    const response = await request(fetchFn, `${config.apiUrl}${path}${search}`, {
      method, headers: { 'AGENT-SIGNATURE': signature, 'AGENT-NONCE': nonce, 'AGENT-EXPIRY': String(expiry) },
    });
    const result = await readApiResponse(operationId, response, record);
    record({ operation: operationId, state: 'ok', status: response.status });
    return result;
  };
}
