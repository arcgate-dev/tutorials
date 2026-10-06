import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, getAddress, zeroAddress } from 'viem';
import { forNetwork, loadConfig } from '../src/config.js';
import { routerAbi } from '../src/guards.js';
import { authorizationTypes, USDC } from '../src/payment.js';

// Random ephemeral keys exist only in memory. No account, RPC or deployment is used.
export const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
export const wallet = { id: 'test-wallet-id', address: account.address, blockchain: 'ARC' };
export const MAINNET = 'eip155:5042';
export const TESTNET = 'eip155:5042002';
export const config = forNetwork(loadConfig({}), MAINNET, {});
// Free responses captured from the arcgate localnet (never written by hand).
export const captured = JSON.parse(readFileSync(new URL('./fixtures/localnet-free.json', import.meta.url), 'utf8'));
export const testnetOffer = captured.search402.paymentRequired.accepts[0];
// The localnet stack's PAY_TO differs from the row's pinned one, so it arrives through the override.
export const testnetConfig = forNetwork(loadConfig({ API_URL: 'http://127.0.0.1:19800' }), TESTNET, { ARCGATE_PAY_TO: testnetOffer.payTo });
export const pinnedTestnetConfig = forNetwork(loadConfig({ API_URL: 'http://127.0.0.1:19800' }), TESTNET, {});
export const other = getAddress('0x1111111111111111111111111111111111111111');
export const hash = `0x${'ab'.repeat(32)}`;
export const offer = { scheme: 'exact', network: config.network, amount: '5000', asset: USDC,
  payTo: config.payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
export const required = { x402Version: 2, resource: { url: `${config.apiUrl}/trade/v1/search`, description: 'Search', mimeType: 'application/json' }, accepts: [offer] };
export const encodeHeader = data => Buffer.from(JSON.stringify(data)).toString('base64');
export const receiptHeader = encodeHeader({ success: true, transaction: hash, network: config.network, payer: wallet.address });
export const circleSigner = { signTypedData: async ({ data }) => ({ data: { signature: await account.signTypedData(JSON.parse(data)) } }) };

export function authorization(cfg = config, chainId = 5042) {
  const now = Math.floor(Date.now() / 1000);
  return { domain: { name: 'USDC', version: '2', chainId, verifyingContract: USDC },
    primaryType: 'TransferWithAuthorization', types: structuredClone(authorizationTypes),
    message: { from: wallet.address, to: cfg.payTo, value: 5000n, validAfter: BigInt(now - 10), validBefore: BigInt(now + 300), nonce: `0x${'01'.repeat(32)}` } };
}

export function quote() {
  return { quoteId: 'q_1234567890abcdef', network: 'eip155:5042', side: 'exactIn',
    sell: { address: USDC, decimals: 6, amount: '1', amountRaw: '1000000' },
    buy: { address: config.buyToken, decimals: 8 }, best: { amountOutQuoted: '0.000012', minAmountOut: '0.00001188', executable: true },
    readiness: { taker: wallet.address.toLowerCase(), balance: { token: USDC, required: '1000000', available: '3000000', enough: true },
      approval: { mode: 'permit2', needs: 'approve_and_sign_permit' }, approve: { needs: 'approve' },
      gas: { estimatedUsdc: '0.01', available: '1.98', enough: true },
      fees: { swapUsdc: '0.01', payer: wallet.address.toLowerCase(), payerAvailable: '2.99', enough: true },
      totalCostUsdc: '0.02', ready: true },
    slippageBps: 100, safety: { verdict: 'pinned' }, next: 'swap', expiresAt: new Date(Date.now() + 120_000).toISOString() };
}

export function tradeReceipt() {
  return { quoteId: 'q_1234567890abcdef', result: 'pass', token: config.buyToken.toLowerCase(),
    recipient: wallet.address.toLowerCase(), minAmountOut: '1188', delivered: '1200', block: 100,
    transactions: [{ hash, purpose: 'swap', status: 'success', block: 100 }], reason: null, next: 'done' };
}

export function swapArgs() {
  return [USDC, 1_000_000n, config.buyToken, 1188n, wallet.address, BigInt(Math.floor(Date.now() / 1000) + 300),
    [{ step: { target: other, tokenIn: USDC, mode: 0, amountOffset: 4, data: '0x12345678' }, tokenOut: config.buyToken, weight: 1n, remainingWeight: 1n, minOut: 1188n }],
    { mode: 0, permit: { details: { token: zeroAddress, amount: 0n, expiration: 0, nonce: 0 }, spender: zeroAddress, sigDeadline: 0n }, signature: '0x' }];
}

export function swap(args = swapArgs(), cfg = config) {
  return { quoteId: 'q_1234567890abcdef', recipient: wallet.address, signatures: [], safety: { verdict: 'pinned' }, next: 'send',
    expiresAt: new Date(Date.now() + 120_000).toISOString(), minAmountOut: '1188', transactions: [
      { purpose: 'approve', to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.router, 1_000_000n] }), value: '0', gas: '100000' },
      { purpose: 'swap', to: cfg.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args }), value: '0', gas: '500000' },
    ] };
}

// Answers the two free calls inspect makes with the captured localnet responses.
export function freeFetch({ health = captured.health, required = captured.search402.paymentRequired } = {}) {
  const urls = [];
  const fetchFn = async url => {
    urls.push(String(url));
    if (String(url).endsWith('/health')) return Response.json(health);
    if (String(url).endsWith('/trade/v1/search')) {
      return new Response(JSON.stringify(captured.search402.body), { status: 402,
        headers: { 'content-type': 'application/json', 'payment-required': encodeHeader(required) } });
    }
    throw new Error(`Unexpected free call ${url}`);
  };
  fetchFn.urls = urls;
  return fetchFn;
}
