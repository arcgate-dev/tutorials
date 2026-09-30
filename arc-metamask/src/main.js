import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { loadConfig, reportError } from './config.js';
import { createWallet, loadWallet, runMm } from './metamask.js';
import { createArcgateClient, paymentRequired, USDC } from './payment.js';
import { proposePolicy, requirePolicy, reviewPolicy } from './policy.js';
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
  if (!['inspect', 'connect', 'policy', 'search', 'quote', 'preview', 'trade', 'receipt'].includes(command)) throw new Error('Use npm run inspect, connect, policy, search, quote, preview, trade or receipt.');
  if (command === 'trade' && !args.includes('--execute')) throw new Error('To spend real USDC, sign Permit2 and broadcast, run: npm run trade -- --execute. Preview first.');
  const config = loadConfig();
  if (command === 'inspect') return inspect(config);
  if (command === 'receipt') {
    const result = await getReceipt({ config, quoteId: args[1], txHashes: args.slice(2) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const mode = args.includes('--beast') ? 'beast' : 'guard';
  const selected = await loadWallet(runMm, mode);
  const policy = reviewPolicy(selected.policy, selected, config);
  console.log(JSON.stringify({ address: selected.address, walletMode: selected.walletMode, tradingMode: selected.tradingMode, chains: selected.chains, policy }, null, 2));
  if (command === 'policy') {
    const folder = `.runs/policy-${randomUUID()}`;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(`${folder}/before.yaml`, selected.policy, { mode: 0o600 });
    writeFileSync(`${folder}/template.yaml`, (await runMm(['wallet', 'policy', 'template'])).policyYaml, { mode: 0o600 });
    writeFileSync(`${folder}/proposed.yaml`, proposePolicy(selected.policy, selected, config), { mode: 0o600 });
    console.log(`Policy proposal: ${folder}/proposed.yaml. Compare it with before.yaml. Nothing has been applied.`);
    return;
  }
  const rpc = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0 }) });
  if (await rpc.getChainId() !== 5042) throw new Error('ARC_RPC_URL is not Arc mainnet (5042).');
  const balance = await rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [selected.address] });
  console.log(JSON.stringify({ usdcBalance: formatUnits(balance, 6) }));
  if (command === 'connect') return;
  // Beast mode does not enforce the policy document, so its review only applies in guard.
  if (command === 'trade' && mode === 'guard') requirePolicy(policy);
  await inspect(config);
  if (balance < config.maxTotal) throw new Error('Fund this MetaMask address with Arc mainnet USDC for API fees.');
  if (['preview', 'trade'].includes(command)) {
    const code = await rpc.getCode({ address: config.router });
    if (!code || code === '0x') throw new Error('The pinned router has no code on Arc mainnet.');
  }
  mkdirSync('.runs', { recursive: true, mode: 0o700 });
  const path = `.runs/${randomUUID()}.jsonl`;
  console.log(`Run log: ${path}`);
  const record = entry => {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    console.log(JSON.stringify(entry));
  };
  const wallet = createWallet(selected.address, args => runMm(args, record), record, mode);
  const api = createArcgateClient({ wallet, config, record });
  return runFlow(command, { config, wallet, api, rpc });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
