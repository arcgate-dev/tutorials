// Shared test helpers: captured fixtures and the EIP-712 shapes the tests recover signatures with.
// Nothing here imports src/ or talks to a network.
import { readFileSync } from 'node:fs';
import { keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';

export const USDC: Address = '0x3600000000000000000000000000000000000000';
export const CIRBTC: Address = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
export const API_URL = 'https://api.arcgate.dev';
export const PAYMENT_META = 'x402/payment';
export const RECEIPT_META = 'x402/payment-response';

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
export function capturedOffer(name = 'trade-search.payment-required'): any {
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

/** The captured payment-required result with its offers replaced. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withOffers(name: string, accepts: unknown[]): any {
  const result = structuredClone(captured(name));
  result.structuredContent.accepts = accepts;
  result.content[0].text = JSON.stringify(result.structuredContent);
  return result;
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

/** Who an AgentRequest signature over GET /agent/v1/<address>/box/status recovers to. */
export async function recoverAgent(address: Address, signed: { signature: Hex; nonce: Hex; expiry: number }): Promise<Address> {
  return recoverTypedDataAddress({
    domain: { name: 'arcgate', version: '1' },
    types: agentRequestTypes,
    primaryType: 'AgentRequest',
    message: {
      address,
      method: 'GET',
      path: `/agent/v1/${address.toLowerCase()}/box/status`,
      bodyHash: EMPTY_BODY_HASH,
      nonce: signed.nonce,
      expiry: BigInt(signed.expiry),
    },
    signature: signed.signature,
  });
}

/** What no test may do: reach a network. Every test file assigns this to globalThis.fetch. */
export function noNetwork(): never {
  throw new Error('a test reached the network through globalThis.fetch');
}
