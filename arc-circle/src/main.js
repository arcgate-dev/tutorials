import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { loadConfig, reportError, requireLiveKey } from './config.js';
import { circleClient, loadWallet, sendTransaction } from './circle.js';
import { createArcgateClient, paymentRequired, USDC } from './payment.js';
import { runFlow } from './flow.js';
import { getReceipt } from './receipt.js';

export async function inspect(config, fetchFn = fetch, log = console.log) {
  const healthResponse = await fetchFn(`${config.apiUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!healthResponse.ok) throw new Error(`Health returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  log(JSON.stringify({ api: config.apiUrl, ok: health.ok, x402: health.x402 }, null, 2));
  if (!health.ok || !health.x402?.enabled || health.x402.network !== config.network) {
    throw new Error('The API is unavailable or uses a different payment network. No payment signed.');
  }
  const unpaid = await fetchFn(`${config.apiUrl}/trade/v1/search`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'cirBTC', limit: 5 }), signal: AbortSignal.timeout(20_000),
  });
  if (unpaid.status !== 402) throw new Error(`Expected HTTP 402 from search, received ${unpaid.status}.`);
  const required = await paymentRequired(unpaid);
  log(JSON.stringify({ paymentRequired: required.accepts, configuredPayTo: config.payTo }, null, 2));
  return health;
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!['inspect', 'connect', 'search', 'quote', 'preview', 'trade', 'receipt'].includes(command)) throw new Error('Use npm run inspect, connect, search, quote, preview, trade or receipt.');
  if (command === 'trade' && !args.includes('--execute')) {
    throw new Error('To spend real USDC and broadcast the swap, run: npm run trade -- --execute. Use npm run preview to inspect it first.');
  }
  const config = loadConfig();
  if (command === 'inspect') return inspect(config);
  if (command === 'receipt') {
    const result = await getReceipt({ config, quoteId: args[1], txHashes: args.slice(2) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  requireLiveKey();
  const circle = circleClient();
  const wallet = await loadWallet(circle, process.env.CIRCLE_WALLET_ID, config.blockchain);
  const rpc = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0 }) });
  if (await rpc.getChainId() !== config.chainId) throw new Error('ARC_RPC_URL is not Arc mainnet (5042).');
  const balance = await rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  console.log(JSON.stringify({ address: wallet.address, blockchain: wallet.blockchain, usdcBalance: formatUnits(balance, 6) }, null, 2));
  if (command === 'connect') return;
  await inspect(config);
  if (balance < config.maxTotal) throw new Error('Fund your ARC wallet with USDC for API fees. Arc testnet USDC cannot pay the public API.');
  if (['preview', 'trade'].includes(command)) {
    const code = await rpc.getCode({ address: config.router });
    if (!code || code === '0x') throw new Error('The configured ArcgateRouter has no code on Arc mainnet.');
  }

  mkdirSync('.runs', { recursive: true, mode: 0o700 });
  const path = `.runs/${randomUUID()}.jsonl`;
  console.log(`Run log: ${path}`);
  const record = entry => {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    console.log(JSON.stringify(entry));
  };
  const api = createArcgateClient({ circle, wallet, config, record });
  return runFlow(command, { config, wallet, rpc, api, record,
    readReceipt: request => getReceipt({ config, ...request, record }),
    send: (tx, key) => sendTransaction(circle, wallet, tx, key, record),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
