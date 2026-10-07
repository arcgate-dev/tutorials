import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, maxUint256 } from 'viem';
import { forNetwork, loadConfig } from '../src/config.js';
import { PERMIT2, routerAbi } from '../src/guards.js';
import { authorizationTypes, USDC } from '../src/payment.js';

// Ephemeral signing key generated in memory. No deployed contract, CLI or network.
export const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
// The payment and mm tests sign with this key; the captured taker's key does not exist here.
export const wallet = { address: account.address, signTypedData: data => account.signTypedData(data) };
export const other = getAddress('0x1111111111111111111111111111111111111111');
export const encodeHeader = data => Buffer.from(JSON.stringify(data)).toString('base64');

// Every API response below is cloned from a capture: the paid production run on Arc mainnet (mainnet-run.json) and the paid
// localnet run on Arc testnet (localnet-run.json). A test that needs a variant mutates its own clone and says why on that line.
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const production = load('mainnet-run.json');
export const localnet = load('localnet-run.json');

// The two rows the API can name: production pays on Arc mainnet, the localnet on Arc testnet. Both trade on Arc mainnet (chain 5042).
export const config = forNetwork(loadConfig({}), 'eip155:5042', {});
export const testnetOffer = structuredClone(localnet.search.unpaid.paymentRequired.accepts[0]);
// The localnet stack's PAY_TO differs from the row's pinned one, so it arrives through the override.
export const testnetConfig = forNetwork(loadConfig({}), 'eip155:5042002', { ARCGATE_PAY_TO: testnetOffer.payTo });

// The flow's wallet is the captured taker; it never signs here, the tests answer with a signature of their own.
export const taker = getAddress(production.taker);
export const trader = { address: taker };

// A capture's expiries and deadlines are only valid at the moment it was taken, so time is pinned to the production run.
// The quote (expires 00:25:10Z), the swap (expires 00:28:18Z) and its deadline all lie after it, within the guard's window.
export const capturedMs = Date.parse(production.capturedAt);
export const pinTime = t => t.mock.timers.enable({ apis: ['Date'], now: capturedMs });

export const required = structuredClone(production.search.unpaid.paymentRequired);
export const offer = required.accepts[0];
export const testnetRequired = structuredClone(localnet.search.unpaid.paymentRequired);
// Override: these tests pay with the in-memory key, not the captured taker.
export const settlementHeader = row => encodeHeader({ ...(row.network === config.network ? production : localnet).search.paid.paymentResponse, payer: wallet.address });
export const receiptHeader = settlementHeader(config);
export const hash = production.search.paid.paymentResponse.transaction;
export const quoteId = production.quote.paid.body.quoteId;
export const minimum = BigInt(production.swap.paid.body.minAmountOut);

export const search = () => structuredClone(production.search.paid.body);
export const quote = () => structuredClone(production.quote.paid.body);
const first = () => structuredClone(production.swap.paid.body);

// Signing inputs for the ephemeral key, not API responses.
export function authorization(row = config) {
  const now = Math.floor(Date.now() / 1000);
  return { domain: { name: 'USDC', version: '2', chainId: row.paymentChainId, verifyingContract: USDC }, types: structuredClone(authorizationTypes), primaryType: 'TransferWithAuthorization',
    message: { from: wallet.address, to: row.payTo, value: 5000n, validAfter: BigInt(now - 10), validBefore: BigInt(now + 300), nonce: `0x${'01'.repeat(32)}` } };
}

// The captured Permit2 typed data. Override: the testnet row's spender is its own router, not the production one.
export function permit(row = config) {
  const typedData = first().signatures[0].typedData;
  if (row !== config) typedData.message.spender = row.router;
  return typedData;
}

// The captured swap calldata, decoded. Variants change one argument and re-encode with routerAbi.
export function swapArgs(signed = null) {
  const args = decodeFunctionData({ abi: routerAbi, data: first().transactions[0].data }).args.map(value => structuredClone(value));
  // Override: /swap/tx answers with the signed permit and signature embedded in the pull.
  if (signed) args[7] = { mode: 1, permit: signed.typedData.message, signature: signed.signature };
  return args;
}

// The first /swap response as captured: it asks for a signature and carries the placeholder swap. The captured wallet already held a
// Permit2 allowance, so it has no approval. Overrides: `approval` adds the approval-required variant (the API's own shape, USDC to Permit2
// for the maximum); `args` re-encodes the swap calldata with a changed argument.
export function swap({ args, approval = false } = {}) {
  const response = first(), [placeholder] = response.transactions;
  if (args) placeholder.data = encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args });
  if (approval) response.transactions.unshift({ ...placeholder, to: USDC, purpose: 'approve', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }) });
  return response;
}

// TODO(#11): the /swap/tx answer and the /receipt answer below are not captured. /swap/tx needs a Permit2 signature for chain 5042, and the
// localnet's fork router stands in for the real mainnet router, so that permit must not be signed there. Replace both with clones of the
// Beast Mode mainnet trade capture when #11 records it. Until then they are the captured first swap with only the fields the final round changes.
export function finalSwap(signed, args = swapArgs(signed)) {
  const response = first();
  delete response.next; // the deployed API omits next on /swap/tx; the local one says send
  response.signatures = [];
  response.transactions[0].data = encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args });
  return response;
}

export function tradeReceipt() {
  const body = first();
  return { quoteId: body.quoteId, result: 'pass', token: config.buyToken.toLowerCase(), recipient: taker.toLowerCase(), minAmountOut: String(minimum),
    delivered: body.amountOutSimulated, block: body.block, transactions: [{ hash, purpose: 'swap', status: 'success' }], reason: null };
}
