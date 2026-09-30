import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, getAddress, maxUint256, zeroAddress } from 'viem';
import { loadConfig } from '../src/config.js';
import { PERMIT2, permitTypes, routerAbi } from '../src/guards.js';
import { authorizationTypes, USDC } from '../src/payment.js';

// Ephemeral signing key generated in memory. No deployed contract, CLI or network.
export const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
export const wallet = { address: account.address, signTypedData: data => account.signTypedData(data) };
export const config = loadConfig({});
export const other = getAddress('0x1111111111111111111111111111111111111111');
export const hash = `0x${'ab'.repeat(32)}`;
export const offer = { scheme: 'exact', network: config.network, amount: '5000', asset: USDC, payTo: config.payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
export const required = { x402Version: 2, resource: { url: `${config.apiUrl}/trade/v1/search`, description: 'Search', mimeType: 'application/json' }, accepts: [offer] };
export const encodeHeader = data => Buffer.from(JSON.stringify(data)).toString('base64');
export const receiptHeader = encodeHeader({ success: true, transaction: hash, network: config.network, payer: wallet.address });

export function authorization() {
  const now = Math.floor(Date.now() / 1000);
  return { domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: USDC }, types: structuredClone(authorizationTypes), primaryType: 'TransferWithAuthorization',
    message: { from: wallet.address, to: config.payTo, value: 5000n, validAfter: BigInt(now - 10), validBefore: BigInt(now + 300), nonce: `0x${'01'.repeat(32)}` } };
}

export function permit() {
  const now = Math.floor(Date.now() / 1000);
  return { domain: { name: 'Permit2', chainId: 5042, verifyingContract: PERMIT2 }, types: structuredClone(permitTypes), primaryType: 'PermitSingle',
    message: { details: { token: USDC, amount: '500000', expiration: String(now + 30 * 86400), nonce: '0' }, spender: config.router, sigDeadline: String(now + 300) } };
}

export function quote() {
  return { quoteId: 'q_1234567890abcdef', network: 'eip155:5042', side: 'exactIn', sell: { address: USDC, decimals: 6, amount: '0.50', amountRaw: '500000' },
    buy: { address: config.buyToken, decimals: 8 }, best: { amountOutQuoted: '0.000006', minAmountOut: '0.00000594' }, slippageBps: 100, safety: { verdict: 'pinned' }, expiresAt: new Date(Date.now() + 120_000).toISOString() };
}

export function swapArgs(signed = null) {
  return [USDC, 500000n, config.buyToken, 594n, wallet.address, BigInt(Math.floor(Date.now() / 1000) + 300),
    [{ step: { target: other, tokenIn: USDC, mode: 0, amountOffset: 4, data: '0x12345678' }, tokenOut: config.buyToken, weight: 1n, remainingWeight: 1n, minOut: 594n }],
    { mode: 1, permit: signed?.typedData.message ?? { details: { token: zeroAddress, amount: 0n, expiration: 0, nonce: 0 }, spender: zeroAddress, sigDeadline: 0n }, signature: signed?.signature ?? '0x' }];
}

export function swap(signed = null, args = swapArgs(signed), typedData = permit()) {
  return { quoteId: 'q_1234567890abcdef', recipient: wallet.address, signatures: signed ? [] : [{ kind: 'permit2', typedData }], safety: { verdict: 'pinned' }, expiresAt: new Date(Date.now() + 120000).toISOString(), transactions: [
    ...signed ? [] : [{ purpose: 'approve', to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }), value: '0', gas: '100000' }],
    { purpose: 'swap', to: config.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args }), value: '0', gas: '500000' },
  ] };
}

export function initialPolicy() {
  return { schema_version: 1, wallet_address: wallet.address, addresses: { allowlist: [], blocklist: [] }, evm: { allowed_chains: [1, 11155111], outflow_limits_usd: { rolling_24h: 0 } } };
}

export function tradeReceipt() {
  return { quoteId: 'q_1234567890abcdef', result: 'pass', token: config.buyToken.toLowerCase(), recipient: wallet.address.toLowerCase(), minAmountOut: '594',
    delivered: '600', block: 23352609, transactions: [{ hash, purpose: 'swap', status: 'success' }], reason: null };
}
