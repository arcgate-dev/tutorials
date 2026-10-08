// Shared test helpers: captured fixtures and the EIP-712 shapes the tests recover signatures with.
// Nothing here imports src/ or talks to a network. The signature helpers are written from the server's
// rule (sorted keys, no whitespace, the hash of no bytes), not from src/agent.ts, so the signer is not
// verified by itself.
import { readFileSync } from 'node:fs';
import { keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';

export const USDC: Address = '0x3600000000000000000000000000000000000000';
export const API_URL = 'https://api.arcgate.dev';
export const PAYMENT_META = 'x402/payment';
export const RECEIPT_META = 'x402/payment-response';

/** The request the README makes: a screen on 24 hour volume and a verified safety verdict. */
export const REQUEST_SCREEN = {
  kind: 'screen',
  where: [
    { field: 'volume_24h', op: 'gt', value: 50000 },
    { field: 'safety_verdict', op: 'eq', value: 'ok' },
  ],
};

// A fixture file is one captured JSON-RPC response body, byte for byte. See fixtures/README.md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

/** The `result` member of a captured JSON-RPC response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function captured(name: string): any {
  return fixture(name).result;
}

/** The first offer of a captured payment-required tool result. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function capturedOffer(name = 'watch-create.payment-required'): any {
  return captured(name).structuredContent.accepts[0];
}

/** The captured payment-required result with its first offer changed: a variation of a real offer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withOffer(name: string, patch: Record<string, unknown>): any {
  const result = structuredClone(captured(name));
  Object.assign(result.structuredContent.accepts[0], patch);
  result.content[0].text = JSON.stringify(result.structuredContent);
  return result;
}

/** The captured box_exists error result with another code and message: a variation of a real arcgate error. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function errorResult(code: string, message = `test: ${code}`): any {
  const result = structuredClone(captured('box-create.exists'));
  result.structuredContent.error = { code, message };
  result.content[0].text = JSON.stringify(result.structuredContent);
  return result;
}

/** The captured inbound-create.paid result with another secret: the fixture holds '<redacted>', the live answer a real one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSecret(secret: string): any {
  const result = structuredClone(captured('inbound-create.paid'));
  result.structuredContent.secret = secret;
  result.content[0].text = JSON.stringify(result.structuredContent);
  return result;
}

/** The captured box-message-list result with the first message's content replaced. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withContent(content: string): any {
  const result = structuredClone(captured('box-message-list'));
  result.structuredContent.messages[0].payload.content = content;
  result.content[0].text = JSON.stringify(result.structuredContent);
  return result;
}

/** The same JSON value with every object's keys in reverse order: it is equal, and `JSON.stringify` of it is not. */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]));
}

/** The box's screen watch from the captured watch list, and a condition that differs from every watch in it. */
export function watchConditions() {
  const list = captured('watch-list').structuredContent.watches;
  const existing = list.find((watch: { condition: { kind: string } }) => watch.condition.kind === 'screen');
  if (!existing) throw new Error('the capture makes a screen, so the captured watch list holds one');
  const different = { ...existing.condition, where: [...existing.condition.where, { field: 'traders_24h', op: 'gt', value: 123456789 }] };
  return { existing, different };
}

export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Who an x402 `_meta["x402/payment"]` payload's EIP-3009 authorization recovers to. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recoverPayer(payment: any, chainId = 5042): Promise<Address> {
  const a = payment.payload.authorization;
  return recoverTypedDataAddress({
    domain: { name: 'USDC', version: '2', chainId, verifyingContract: USDC },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: payment.payload.signature,
  });
}

export const agentRequestTypes = {
  AgentRequest: [
    { name: 'address', type: 'address' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'bodyHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export const EMPTY_BODY_HASH: Hex = keccak256('0x');

/** The hash the server checks: keccak256 of the canonical JSON text the test spells out, or of no bytes. */
export function bodyHash(canonicalBody?: string): Hex {
  return canonicalBody === undefined ? EMPTY_BODY_HASH : keccak256(toBytes(canonicalBody));
}

/**
 * Who an AgentRequest signature over `request` recovers to. `body` is the canonical JSON text of the
 * request body (sorted keys, no whitespace), spelled out by the test, or absent when there is no body.
 */
export async function recoverAgent(
  address: Address,
  signed: { signature: Hex; nonce: Hex; expiry: number },
  request: { method: string; path: string; body?: string },
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: { name: 'arcgate', version: '1' },
    types: agentRequestTypes,
    primaryType: 'AgentRequest',
    message: { address, method: request.method, path: request.path, bodyHash: bodyHash(request.body), nonce: signed.nonce, expiry: BigInt(signed.expiry) },
    signature: signed.signature,
  });
}

export interface OwnerRequest {
  method: string;
  path: string;
  /** The canonical JSON text of the body, absent when there is none. */
  body?: string;
}

/** The method, path and canonical body of each owner call, by the server's rule. */
export const OWNER_REQUESTS: {
  boxStatus: (address: Address) => OwnerRequest;
  watchList: (address: Address) => OwnerRequest;
  boxMessageList: (address: Address, sent: { cursor?: number; limit?: number }) => OwnerRequest;
  boxMessageDelete: (address: Address, seq: number) => OwnerRequest;
} = {
  boxStatus: (address: Address) => ({ method: 'GET', path: `/agent/v1/${address.toLowerCase()}/box/status` }),
  watchList: (address: Address) => ({ method: 'GET', path: `/agent/v1/${address.toLowerCase()}/watch/list` }),
  boxMessageList: (address: Address, sent: { cursor?: number; limit?: number }) => {
    // The body is the cursor and limit actually sent: cursor sorts before limit.
    const body: Record<string, number> = {};
    if (sent.cursor !== undefined) body.cursor = sent.cursor;
    if (sent.limit !== undefined) body.limit = sent.limit;
    return { method: 'GET', path: `/agent/v1/${address.toLowerCase()}/box/messages`, body: Object.keys(body).length ? JSON.stringify(body) : undefined };
  },
  boxMessageDelete: (address: Address, seq: number) => ({ method: 'DELETE', path: `/agent/v1/${address.toLowerCase()}/box/messages/${seq}` }),
};

/** Who a recorded owner-call tools/call (boxStatus, watchList, boxMessageList or boxMessageDelete) was signed by. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recoverOwnerCall(call: { tool?: string; args?: Record<string, any> }): Promise<Address> {
  const args = call.args!;
  const address: Address = args.address;
  const expected = {
    boxStatus: () => OWNER_REQUESTS.boxStatus(address),
    watchList: () => OWNER_REQUESTS.watchList(address),
    boxMessageList: () => OWNER_REQUESTS.boxMessageList(address, args),
    boxMessageDelete: () => OWNER_REQUESTS.boxMessageDelete(address, args.seq),
  }[call.tool as 'boxStatus'];
  if (!expected) throw new Error(`${call.tool} is not an owner call`);
  return recoverAgent(address, args.agentSignature, expected());
}

/** What no test may do: reach a network. Every test file assigns this to globalThis.fetch. */
export function noNetwork(): never {
  throw new Error('a test reached the network through globalThis.fetch');
}
