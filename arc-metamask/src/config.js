import { getAddress, parseUnits } from 'viem';

export const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
export const DEFAULT_ROUTER = '0x6cf4f7785d479b9ec1c3abe2fb569525380baede';
export const DEFAULT_PAY_TO = '0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e';

// https anywhere; plain http only to a local stack. Never credentials, a path, a query or a fragment.
function apiOrigin(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('API_URL must be an HTTPS origin (or http on localhost or 127.0.0.1) with no credentials, path or query.');
  }
  return url.origin;
}

// The two networks the API can name. Production pays x402 on Arc mainnet; the localnet pays it on Arc testnet and
// trades on a fork of Arc mainnet (chain 5042). Everything the API reports is checked against this table.
const NETWORKS = {
  'eip155:5042': { paymentChainId: 5042, tradeChainId: 5042, tradeNetwork: 'eip155:5042',
    rpcUrl: 'https://rpc.mainnet.arc.io', paymentRpcUrl: 'https://rpc.mainnet.arc.io',
    payTo: DEFAULT_PAY_TO, router: DEFAULT_ROUTER },
  'eip155:5042002': { paymentChainId: 5042002, tradeChainId: 5042, tradeNetwork: 'eip155:5042',
    rpcUrl: 'http://127.0.0.1:19845', paymentRpcUrl: 'https://rpc.testnet.arc.io',
    payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', router: '0x0eA7461542fE051c013AB0f5860190bC847f3271' },
};

export function loadConfig(env = process.env) {
  const amount = env.SELL_AMOUNT || '0.50';
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseUnits(amount, 6) <= 0n || parseUnits(amount, 6) > 1_000_000n) {
    throw new Error('SELL_AMOUNT must be greater than zero and at most 1 USDC, with up to six decimals.');
  }
  return {
    apiUrl: apiOrigin(env.API_URL || 'https://api.arcgate.dev'),
    maxPayment: 10_000n, // 0.01 USDC per API call
    maxTotal: 25_000n, // Search + quote + swap; /swap/tx and /receipt are free. Never reset after a timeout.
    amount,
    buyToken: getAddress(CIRBTC),
    slippageBps: 100,
  };
}

// The network row for what /health and the 402 reported. Any other network is refused.
export function forNetwork(config, network, env = process.env) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error(`Unsupported payment network ${JSON.stringify(network)}. Expected eip155:5042 or eip155:5042002.`);
  const row = NETWORKS[network];
  return { ...config, network, ...row,
    rpcUrl: env.ARC_RPC_URL || row.rpcUrl,
    payTo: getAddress(env.ARCGATE_PAY_TO || row.payTo),
    router: getAddress(env.ARCGATE_ROUTER_ADDRESS || row.router) };
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
