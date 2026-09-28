import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, getAddress, zeroAddress } from 'viem';
import { loadConfig } from '../src/config.js';
import { routerAbi } from '../src/guards.js';
import { authorizationTypes, USDC } from '../src/payment.js';

// Random ephemeral keys exist only in memory. No account, RPC or deployment is used.
export const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
export const wallet = { id: 'test-wallet-id', address: account.address, blockchain: 'ARC' };
export const config = loadConfig({});
export const other = getAddress('0x1111111111111111111111111111111111111111');
export const hash = `0x${'ab'.repeat(32)}`;
export const offer = { scheme: 'exact', network: config.network, amount: '5000', asset: USDC,
  payTo: config.payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
export const required = { x402Version: 2, resource: { url: `${config.apiUrl}/trade/v1/search`, description: 'Search', mimeType: 'application/json' }, accepts: [offer] };
export const encodeHeader = data => Buffer.from(JSON.stringify(data)).toString('base64');
export const receiptHeader = encodeHeader({ success: true, transaction: hash, network: config.network, payer: wallet.address });
export const circleSigner = { signTypedData: async ({ data }) => ({ data: { signature: await account.signTypedData(JSON.parse(data)) } }) };

export function authorization() {
  const now = Math.floor(Date.now() / 1000);
  return { domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: USDC },
    primaryType: 'TransferWithAuthorization', types: structuredClone(authorizationTypes),
    message: { from: wallet.address, to: config.payTo, value: 5000n, validAfter: BigInt(now - 10), validBefore: BigInt(now + 300), nonce: `0x${'01'.repeat(32)}` } };
}

export function quote() {
  return { quoteId: 'q_1234567890abcdef', network: 'eip155:5042', side: 'exactIn',
    sell: { address: USDC, decimals: 6, amount: '1', amountRaw: '1000000' },
    buy: { address: config.buyToken, decimals: 8 }, best: { amountOutQuoted: '0.000012', minAmountOut: '0.00001188' },
    slippageBps: 100, safety: { verdict: 'pinned' }, expiresAt: new Date(Date.now() + 120_000).toISOString() };
}

export function swapArgs() {
  return [USDC, 1_000_000n, config.buyToken, 1188n, wallet.address, BigInt(Math.floor(Date.now() / 1000) + 300),
    [{ step: { target: other, tokenIn: USDC, mode: 0, amountOffset: 4, data: '0x12345678' }, tokenOut: config.buyToken, weight: 1n, remainingWeight: 1n, minOut: 1188n }],
    { mode: 0, permit: { details: { token: zeroAddress, amount: 0n, expiration: 0, nonce: 0 }, spender: zeroAddress, sigDeadline: 0n }, signature: '0x' }];
}

export function swap(args = swapArgs()) {
  return { quoteId: 'q_1234567890abcdef', recipient: wallet.address, signatures: [], safety: { verdict: 'pinned' },
    expiresAt: new Date(Date.now() + 120_000).toISOString(), minAmountOut: '1188', transactions: [
      { purpose: 'approve', to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [config.router, 1_000_000n] }), value: '0', gas: '100000' },
      { purpose: 'swap', to: config.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args }), value: '0', gas: '500000' },
    ] };
}
