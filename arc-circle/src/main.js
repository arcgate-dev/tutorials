import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { COMMAND_CAPS, commandConfig, forNetwork, loadConfig, reportError, requireApiKey } from './config.js';
import { circleSigner, createAgentClient } from './agent.js';
import { circleClient, loadWallet, sendTransaction } from './circle.js';
import { fundOnFork, sendOnFork } from './fork.js';
import { checkFunds, createArcgateClient, fundedOnce, paymentRequired } from './payment.js';
import { request } from './http.js';
import { STEPS } from './box.js';
import { runFlow } from './flow.js';
import { getReceipt } from './receipt.js';

// Native USDC (18 decimals) given to the Circle wallet's address on the localnet fork.
const FORK_FUNDING = 10n * 10n ** 18n;

// Reads the payment network from /health and the unpaid 402, requires them to agree,
// and resolves that network's row. Nothing here signs or pays.
export async function inspect(config, fetchFn = fetch, log = console.log, env = process.env) {
  const healthResponse = await request(fetchFn, `${config.apiUrl}/health`, {}, 20_000);
  if (!healthResponse.ok) throw new Error(`Health returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  log(JSON.stringify({ api: config.apiUrl, ok: health.ok, x402: health.x402, commit: health.commit, rulesVersion: health.rulesVersion }, null, 2));
  if (!health.ok || !health.x402?.enabled) throw new Error('The API is unavailable or has payments disabled. No payment signed.');
  const unpaid = await request(fetchFn, `${config.apiUrl}/trade/v1/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'cirBTC', limit: 5 }),
  }, 20_000);
  if (unpaid.status !== 402) throw new Error(`Expected HTTP 402 from search, received ${unpaid.status}.`);
  const required = await paymentRequired(unpaid);
  if (required.accepts.length < 1 || required.accepts.some(offer => offer.network !== health.x402.network)) {
    throw new Error('The payment network in /health differs from the one in the 402 offer. No payment signed.');
  }
  const resolved = forNetwork(config, health.x402.network, env);
  log(JSON.stringify({ network: resolved.network, paymentRequired: required.accepts, configuredPayTo: resolved.payTo }, null, 2));
  return resolved;
}

// The network row decides how a transaction is sent: impersonated on the localnet fork,
// or signed and broadcast by Circle. `forkRequest` lets tests stand in for the fork node.
export function broadcaster(config, { circle, wallet, record, forkRequest }) {
  return config.broadcast === 'fork'
    ? tx => sendOnFork(config.rpcUrl, wallet.address, tx, forkRequest)
    : (tx, key) => sendTransaction(circle, wallet, tx, key, record);
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!['inspect', 'connect', 'search', 'quote', 'preview', 'trade', 'receipt', ...Object.keys(STEPS)].includes(command)) throw new Error('Use npm run inspect, connect, search, quote, preview, trade, receipt, box, inbound, messages or cleanup.');
  if (command === 'trade' && !args.includes('--execute')) {
    throw new Error('To spend real USDC and broadcast the swap, run: npm run trade -- --execute. Use npm run preview to inspect it first.');
  }
  const base = loadConfig();
  if (command === 'inspect') return inspect(base);
  if (command === 'receipt') {
    const result = await getReceipt({ config: base, quoteId: args[1], txHashes: args.slice(2) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  // The network decides the key type and wallet chain, so resolve it before any Circle call.
  // Each command carries its own spending cap; the trade commands keep loadConfig's.
  const config = commandConfig(await inspect(base), command);
  requireApiKey(config);
  const circle = circleClient();
  const wallet = await loadWallet(circle, process.env.CIRCLE_WALLET_ID, config.blockchain);
  // The box commands work on the trade chain's identity only: no trade RPC, and only box and inbound pay a fee.
  const owner = Object.hasOwn(STEPS, command);
  const pays = !owner || Object.hasOwn(COMMAND_CAPS, command);
  let rpc;
  if (!owner) {
    rpc = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0 }) });
    if (await rpc.getChainId() !== config.tradeChainId) throw new Error(`ARC_RPC_URL is not the trade chain (${config.tradeChainId}).`);
  }
  // API fees are paid on the payment chain, which is not always the trade chain.
  const feeRpc = !pays ? undefined : rpc && config.paymentRpcUrl === config.rpcUrl ? rpc : createPublicClient({ transport: http(config.paymentRpcUrl, { retryCount: 0 }) });
  const funds = () => checkFunds({ feeRpc, wallet, config, enforce: command !== 'connect' });
  // The trade commands check the balance up front; box and inbound only before their first payment.
  if (pays && !owner) await funds();
  if (command === 'connect') return;
  if (config.broadcast === 'fork' && ['quote', 'preview', 'trade'].includes(command)) await fundOnFork(config.rpcUrl, wallet.address, FORK_FUNDING);
  if (['preview', 'trade'].includes(command)) {
    const code = await rpc.getCode({ address: config.router });
    if (!code || code === '0x') throw new Error('The configured ArcgateRouter has no code on the trade chain.');
  }

  mkdirSync('.runs', { recursive: true, mode: 0o700 });
  const path = `.runs/${randomUUID()}.jsonl`;
  console.log(`Run log: ${path}`);
  const record = entry => {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    console.log(JSON.stringify(entry));
  };
  const client = pays ? createArcgateClient({ circle, wallet, config, record }) : undefined;
  const api = owner && pays ? fundedOnce(client, funds) : client;
  if (owner) {
    return STEPS[command]({ api, own: createAgentClient({ signer: circleSigner({ circle, wallet, config }), config, record }), log: console.log });
  }
  return runFlow(command, { config, wallet, rpc, api, record,
    readReceipt: request => getReceipt({ config, ...request, record }),
    send: broadcaster(config, { circle, wallet, record }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
