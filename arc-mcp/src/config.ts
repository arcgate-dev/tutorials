import type { Network } from '@x402/core/types';
import { privateKeyToAccount } from 'viem/accounts';

type Env = Record<string, string | undefined>;

// Arc mainnet, where api.arcgate.dev settles, and Arc testnet, where arcgate's localnet settles.
const NETWORKS: Network[] = ['eip155:5042', 'eip155:5042002'];

// The API origin: https, or http only for localhost and 127.0.0.1, with no credentials, path, query or fragment.
function apiOrigin(value: string): string {
  const fail = () => new Error('API_URL must be an origin: https, or http for localhost and 127.0.0.1, with no credentials, path or query.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!scheme || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail();
  return url.origin;
}

function account(env: Env, name: 'PRIVATE_KEY' | 'AGENT_PRIVATE_KEY') {
  const key = env[name] ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || /^0x0+$/.test(key)) throw new Error(`Set ${name} to a 0x-prefixed 32-byte hex key in .env.`);
  return privateKeyToAccount(key as `0x${string}`);
}

export function loadConfig(env: Env = process.env) {
  const apiUrl = apiOrigin(env.API_URL || 'https://api.arcgate.dev');
  return {
    apiUrl,
    mcpUrl: `${apiUrl}/mcp`,
    payer: account(env, 'PRIVATE_KEY'), // signs the x402 payments
    agent: account(env, 'AGENT_PRIVATE_KEY'), // the box's address: signs boxStatus, owns the box
    networks: NETWORKS,
    maxPerCall: 50_000n, // 0.05 USDC per paid call
    maxPerRun: 70_000n, // 0.07 USDC per run: search 0.005 + quote 0.01 + box 0.05 with room for one more search or quote. Never reset.
    paidTools: ['tradeSearch', 'tradeQuote', 'boxCreate'],
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function reportError(error: unknown, env: Env = process.env) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [env.PRIVATE_KEY, env.AGENT_PRIVATE_KEY]) {
    if (value) message = message.split(value).join('[redacted]');
  }
  // Diagnostics can carry provider keys inside URLs.
  console.error(message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  process.exitCode = 1;
}
