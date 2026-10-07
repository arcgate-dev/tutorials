import { randomBytes } from 'node:crypto';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

/** JSON with every object's keys sorted, at every depth, and no whitespace: the text arcgate hashes a body by. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, inner]) => inner !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SignedRequest {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * The one signer: an EIP-712 AgentRequest over the method, path and body of an owner call. The domain
 * has no chainId, since an agent's key signs for no chain. The path carries the lowercased address, the
 * body hash is keccak256 of the canonical JSON body (of no bytes when there is none), and the nonce is
 * one the server accepts once.
 */
export async function agentSignature(account: PrivateKeyAccount, { method, path, body }: SignedRequest, nowSec = Math.floor(Date.now() / 1000)) {
  const nonce: Hex = `0x${randomBytes(32).toString('hex')}`;
  const expiry = nowSec + 60;
  const signature = await account.signTypedData({
    domain: { name: 'arcgate', version: '1' },
    types: {
      AgentRequest: [
        { name: 'address', type: 'address' },
        { name: 'method', type: 'string' },
        { name: 'path', type: 'string' },
        { name: 'bodyHash', type: 'bytes32' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'expiry', type: 'uint64' },
      ],
    },
    primaryType: 'AgentRequest',
    message: {
      address: account.address,
      method,
      path,
      bodyHash: body === undefined ? keccak256('0x') : keccak256(toBytes(canonicalJson(body))),
      nonce,
      expiry: BigInt(expiry),
    },
  });
  return { signature, nonce, expiry };
}

export type OwnerTool = 'boxStatus' | 'watchList' | 'boxMessageList' | 'boxMessageDelete';

/**
 * What an owner call is signed over: its method and path, with the lowercased address in the path. A
 * list signs the {cursor?, limit?} it sends as its body, and no body when it sends neither. A delete
 * signs the seq in its path and no body.
 */
export function ownerRequest(tool: OwnerTool, address: Address, args: { cursor?: number; limit?: number; seq?: number }): SignedRequest {
  const base = `/agent/v1/${address.toLowerCase()}`;
  switch (tool) {
    case 'boxStatus':
      return { method: 'GET', path: `${base}/box/status` };
    case 'watchList':
      return { method: 'GET', path: `${base}/watch/list` };
    case 'boxMessageList': {
      const body = { ...(args.cursor !== undefined && { cursor: args.cursor }), ...(args.limit !== undefined && { limit: args.limit }) };
      return { method: 'GET', path: `${base}/box/messages`, body: Object.keys(body).length > 0 ? body : undefined };
    }
    case 'boxMessageDelete':
      return { method: 'DELETE', path: `${base}/box/messages/${args.seq}` };
  }
}
