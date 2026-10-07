import { randomBytes } from 'node:crypto';
import { keccak256, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

/**
 * The agent's signature for boxStatus: an EIP-712 AgentRequest over GET /agent/v1/<address>/box/status.
 * The domain has no chainId, since an agent's key signs for no chain. The path carries the lowercased
 * address, the body is empty, and the nonce is one the server accepts once.
 */
export async function agentSignature(account: PrivateKeyAccount, address: Address, nowSec = Math.floor(Date.now() / 1000)) {
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
      address,
      method: 'GET',
      path: `/agent/v1/${address.toLowerCase()}/box/status`,
      bodyHash: keccak256('0x'),
      nonce,
      expiry: BigInt(expiry),
    },
  });
  return { signature, nonce, expiry };
}
