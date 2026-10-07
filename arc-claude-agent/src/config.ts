import type { Network } from '@x402/core/types';
import { privateKeyToAccount } from 'viem/accounts';

type Env = Record<string, string | undefined>;

// Arc mainnet and Arc testnet. Arcgate's localnet settles on testnet.
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

function account(env: Env, name: 'PRIVATE_KEY') {
  const key = env[name] ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || /^0x0+$/.test(key)) throw new Error(`Set ${name} to a 0x-prefixed 32-byte hex key in .env.`);
  return privateKeyToAccount(key as `0x${string}`);
}

export function loadConfig(env: Env = process.env) {
  const apiUrl = apiOrigin(env.API_URL || 'https://api.arcgate.dev');
  return {
    apiUrl,
    mcpUrl: `${apiUrl}/mcp`,
    // One key: it signs the x402 payments, it signs the owner calls, and its address is the box.
    // watchCreate and inboundCreate accept only the box's own address as payer, so there is no second key.
    account: account(env, 'PRIVATE_KEY'),
    model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    networks: NETWORKS,
    maxPerCall: 50_000n, // 0.05 USDC per paid call
    maxPerRun: 80_000n, // 0.08 USDC per run: box 0.05 + watch 0.01 + inbound 0.01 with room for one more 0.01 call. Never reset.
    paidTools: ['boxCreate', 'watchCreate', 'inboundCreate'],
    maxTurns: 12, // the model's turns per query
    maxBudgetUsd: 0.5, // the model's own cost per query, by the SDK's estimate
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function reportError(error: unknown, env: Env = process.env) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [env.PRIVATE_KEY, env.ANTHROPIC_API_KEY]) {
    if (value) message = message.split(value).join('[redacted]');
  }
  // Diagnostics can carry provider keys inside URLs.
  console.error(message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  process.exitCode = 1;
}
