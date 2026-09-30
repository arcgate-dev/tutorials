import { getAddress, parseUnits } from 'viem';

export const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
export const DEFAULT_ROUTER = '0x6cf4f7785d479b9ec1c3abe2fb569525380baede';
export const DEFAULT_PAY_TO = '0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e';

function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('API_URL must be an HTTPS origin with no credentials, path or query.');
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const amount = env.SELL_AMOUNT || '0.50';
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseUnits(amount, 6) <= 0n || parseUnits(amount, 6) > 1_000_000n) {
    throw new Error('SELL_AMOUNT must be greater than zero and at most 1 USDC, with up to six decimals.');
  }
  return {
    apiUrl: publicUrl(env.API_URL || 'https://api.arcgate.dev'),
    rpcUrl: env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io',
    chainId: 5042,
    network: 'eip155:5042',
    blockchain: 'ARC',
    payTo: getAddress(env.ARCGATE_PAY_TO || DEFAULT_PAY_TO),
    router: getAddress(env.ARCGATE_ROUTER_ADDRESS || DEFAULT_ROUTER),
    maxPayment: 10_000n, // 0.01 USDC per API call
    maxTotal: 25_000n, // Search + quote + swap; /swap/tx and /receipt are free. Never reset after a timeout.
    amount,
    buyToken: getAddress(CIRBTC),
    slippageBps: 100,
  };
}

export function reportError(error, env = process.env) {
  let message = error instanceof Error ? error.message : 'Unexpected error.';
  for (const value of [env.MM_PASSWORD, env.MM_MNEMONIC, env.ARC_RPC_URL]) {
    if (value) message = message.split(value).join('[redacted]');
  }
  // RPC client diagnostics can include provider keys inside URLs.
  console.error(message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  process.exitCode = 1;
}
