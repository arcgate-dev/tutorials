import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { forNetwork, loadConfig } from '../src/config.js';
import { routerAbi } from '../src/guards.js';
import { authorizationTypes, USDC } from '../src/payment.js';

// Random ephemeral keys exist only in memory. No account, RPC or deployment is used.
export const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
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
export const encodeHeader = data => Buffer.from(JSON.stringify(data)).toString('base64');
export const circleSigner = { signTypedData: async ({ data }) => ({ data: { signature: await account.signTypedData(JSON.parse(data)) } }) };

// Every API response below is cloned from the paid localnet run (search -> quote -> swap -> receipt).
// A test that needs a variant mutates its own clone and says why on the line that does it.
export const run = JSON.parse(readFileSync(new URL('./fixtures/localnet-run.json', import.meta.url), 'utf8'));
export const taker = getAddress(run.taker);
// The flow's wallet is the captured taker, on the testnet row's Circle blockchain.
export const wallet = { id: 'test-wallet-id', address: taker, blockchain: 'ARC-TESTNET' };
// The payment tests sign with the in-memory ephemeral key above; the captured taker's key does not exist here.
export const paymentWallet = { id: 'test-wallet-id', address: account.address, blockchain: 'ARC' };

// Time is pinned to the moment the run was captured. The quote (expires 22:11:14Z), the swap (expires 22:14:19Z)
// and the swap's own deadline (22:14:19Z, 280 seconds on, inside the guard's 630-second window) all lie after it,
// so every guard sees the same clock it saw when the localnet answered.
export const capturedMs = Date.parse(run.capturedAt);
export const now = Math.floor(capturedMs / 1000);
export const pinTime = t => t.mock.timers.enable({ apis: ['Date'], now: capturedMs });

export const search = () => structuredClone(run.run.search.body);
export const quote = () => structuredClone(run.run.quote.body);
export const tradeReceipt = () => structuredClone(run.run.receipt.body);
export const receiptCommand = () => structuredClone(run.run.receiptCommand);
export const required = () => structuredClone(run.run.search.paymentRequired);
export const offer = () => required().accepts[0];
export const settlement = () => structuredClone(run.run.search.paymentResponse);
export const [approveHash, swapHash] = run.run.receipt.body.transactions.map(tx => tx.hash);
export const minOut = BigInt(run.run.swap.body.minAmountOut);
export const delivered = BigInt(run.run.receipt.body.delivered);

// Override: the captured challenge is on eip155:5042002; the mainnet-row cases need the same offer on eip155:5042 paying the row's pinned recipient.
export function mainnetRequired() {
  const challenge = required();
  for (const accepted of challenge.accepts) { accepted.network = config.network; accepted.payTo = config.payTo; }
  return challenge;
}
export const mainnetOffer = () => mainnetRequired().accepts[0];
// Override: these tests pay with the in-memory key, not the captured taker, and the mainnet row settles on eip155:5042.
export const receiptHeader = (cfg = config) => encodeHeader({ ...settlement(), payer: paymentWallet.address, network: cfg.network });

export function authorization(cfg = config, chainId = 5042) {
  const issued = Math.floor(Date.now() / 1000);
  return { domain: { name: 'USDC', version: '2', chainId, verifyingContract: USDC },
    primaryType: 'TransferWithAuthorization', types: structuredClone(authorizationTypes),
    message: { from: paymentWallet.address, to: cfg.payTo, value: BigInt(offer().amount), validAfter: BigInt(issued - 10), validBefore: BigInt(issued + 300), nonce: `0x${'01'.repeat(32)}` } };
}

// The captured swap's router call, decoded. A refusal case mutates one argument and re-encodes it.
export const swapArgs = () => decodeFunctionData({ abi: routerAbi, data: run.run.swap.body.transactions[1].data }).args;

// The captured swap targets the localnet router, which is the testnet row's. Without arguments it is returned as captured.
export function swap(args, cfg = testnetConfig) {
  const body = structuredClone(run.run.swap.body);
  const [approve, trade] = body.transactions;
  if (getAddress(trade.to) !== getAddress(cfg.router)) {
    // Override: re-point the approval spender and the swap target at this row's router.
    approve.data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.router, decodeFunctionData({ abi: erc20Abi, data: approve.data }).args[1]] });
    trade.to = cfg.router;
  }
  // Override: re-encode the swap calldata with the caller's (mutated) decoded arguments.
  if (args) trade.data = encodeFunctionData({ abi: routerAbi, functionName: 'executeGraph', args });
  return body;
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
