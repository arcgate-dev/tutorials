import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { forNetwork, loadConfig, reportError } from './config.js';
import { createWallet, loadWallet, runMm } from './metamask.js';
import { createArcgateClient, paymentRequired, USDC } from './payment.js';
import { runFlow } from './flow.js';
import { getReceipt } from './receipt.js';

// /health and the unpaid 402 name the network the API charges on. That network picks the row of chains, RPCs,
// payee and router this run uses; a disagreement, or a network outside the table, is refused before anything is signed.
export async function inspect(config, fetchFn = fetch, log = console.log) {
  const healthResponse = await fetchFn(`${config.apiUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!healthResponse.ok) throw new Error(`Health returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  log(JSON.stringify({ api: config.apiUrl, ok: health.ok, commit: health.commit, rulesVersion: health.rulesVersion, x402: health.x402 }, null, 2));
  if (!health.ok || !health.x402?.enabled) throw new Error('The API is unavailable or has x402 payments disabled. No payment signed.');
  const row = forNetwork(config, health.x402.network, process.env);
  const unpaid = await fetchFn(`${config.apiUrl}/trade/v1/search`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'cirBTC', limit: 5 }), signal: AbortSignal.timeout(20_000),
  });
  if (unpaid.status !== 402) throw new Error(`Expected HTTP 402 from search, received ${unpaid.status}.`);
  const required = await paymentRequired(unpaid);
  log(JSON.stringify({ paymentRequired: required.accepts, configuredPayTo: row.payTo }, null, 2));
  if (!required.accepts.length || required.accepts.some(offer => offer.network !== row.network)) {
    throw new Error(`The 402 offers a payment network other than the one /health reports (${row.network}). No payment signed.`);
  }
  return row;
}

export async function main(args = process.argv.slice(2), { run = runMm } = {}) {
  const [command] = args;
  if (!['inspect', 'connect', 'search', 'quote', 'preview', 'trade', 'receipt'].includes(command)) throw new Error('Use npm run inspect, connect, search, quote, preview, trade or receipt.');
  if (command === 'trade' && !args.includes('--execute')) throw new Error('To spend real USDC, sign Permit2 and broadcast, run: npm run trade -- --execute. Preview first.');
  const base = loadConfig();
  if (command === 'inspect') return inspect(base);
  if (command === 'receipt') {
    const result = await getReceipt({ config: base, quoteId: args[1], txHashes: args.slice(2) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  // Beast Mode first: in Guard Mode nothing else runs, not even a network request.
  const selected = await loadWallet(run);
  console.log(JSON.stringify({ address: selected.address, walletMode: selected.walletMode, tradingMode: selected.tradingMode, chains: selected.chains }, null, 2));
  const config = await inspect(base);
  // mm broadcasts to the real chain, which a local fork never sees, so a trade can only run where the API pays on Arc mainnet.
  if (command === 'trade' && config.paymentChainId !== config.tradeChainId) {
    throw new Error(`The API pays on ${config.network} but trades on ${config.tradeNetwork}. mm broadcasts to the real chain, so the trade runs only where the API pays on Arc mainnet. Use npm run preview here. No payment signed.`);
  }
  const rpc = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0 }) });
  if (await rpc.getChainId() !== config.tradeChainId) throw new Error(`ARC_RPC_URL is not the trade chain (${config.tradeChainId}).`);
  // API fees are paid on the payment chain, which is not the trade RPC's chain when the API runs on Arc testnet.
  const feeRpc = config.paymentRpcUrl === config.rpcUrl ? rpc : createPublicClient({ transport: http(config.paymentRpcUrl, { retryCount: 0 }) });
  if (await feeRpc.getChainId() !== config.paymentChainId) throw new Error(`The payment RPC is not the payment chain (${config.paymentChainId}).`);
  const balance = await feeRpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [selected.address] });
  console.log(JSON.stringify({ paymentChain: config.network, usdcBalance: formatUnits(balance, 6) }));
  if (command === 'connect') return;
  if (balance < config.maxTotal) throw new Error(`Fund this MetaMask address with ${config.paymentChainId === 5042 ? 'Arc mainnet' : 'Arc testnet'} USDC for API fees.`);
  if (['preview', 'trade'].includes(command)) {
    const code = await rpc.getCode({ address: config.router });
    if (!code || code === '0x') throw new Error('The pinned router has no code on the trade chain.');
  }
  mkdirSync('.runs', { recursive: true, mode: 0o700 });
  const path = `.runs/${randomUUID()}.jsonl`;
  console.log(`Run log: ${path}`);
  const record = entry => {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    console.log(JSON.stringify(entry));
  };
  const wallet = createWallet(selected.address, args => run(args, record), record, config);
  const api = createArcgateClient({ wallet, config, record });
  return runFlow(command, { config, wallet, api, rpc });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
