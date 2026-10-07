import { getAddress, parseUnits } from 'viem';

export const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';

// The API names its payment network in /health and in the unpaid 402. Everything
// that depends on that network lives in this one table; any other network is refused.
// Fees are paid on the payment chain. The trade runs on the trade chain: on the
// testnet row that is the localnet fork of Arc mainnet, so transactions are
// broadcast there by impersonating the Circle wallet's address (src/fork.js).
export const NETWORKS = {
  'eip155:5042': {
    paymentChainId: 5042, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io', paymentRpcUrl: 'https://rpc.mainnet.arc.io',
    blockchain: 'ARC', apiKeyPrefix: 'LIVE_API_KEY:',
    payTo: '0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e', router: '0x6cf4f7785d479b9ec1c3abe2fb569525380baede',
    broadcast: 'circle',
  },
  'eip155:5042002': {
    paymentChainId: 5042002, tradeNetwork: 'eip155:5042', tradeChainId: 5042,
    rpcUrl: 'http://127.0.0.1:19845', paymentRpcUrl: 'https://rpc.testnet.arc.io',
    blockchain: 'ARC-TESTNET', apiKeyPrefix: 'TEST_API_KEY:',
    payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', router: '0x0eA7461542fE051c013AB0f5860190bC847f3271',
    broadcast: 'fork',
  },
};

function isLoopbackHttp(url) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
}

function parseUrl(value, name) {
  try { return new URL(value); } catch { throw new Error(`${name} must be a URL.`); }
}

// https anywhere, or http only on this machine; never credentials.
function checkedUrl(value, name) {
  const url = parseUrl(value, name);
  if (url.username || url.password || (url.protocol !== 'https:' && !isLoopbackHttp(url))) {
    throw new Error(`${name} must be an https URL, or http on localhost or 127.0.0.1, with no credentials.`);
  }
  return url;
}

export function assertLoopback(value, name) {
  const url = parseUrl(value, name);
  if (url.username || url.password || !isLoopbackHttp(url)) {
    throw new Error(`${name} must be http on localhost or 127.0.0.1 (loopback only), with no credentials.`);
  }
}

function apiOrigin(value) {
  const url = checkedUrl(value, 'API_URL');
  if (url.search || url.hash || url.pathname !== '/') throw new Error('API_URL must be an origin with no path or query.');
  return url.origin;
}

export function loadConfig(env = process.env) {
  const amount = env.SELL_AMOUNT || '1';
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseUnits(amount, 6) <= 0n || parseUnits(amount, 6) > 1_000_000n) {
    throw new Error('SELL_AMOUNT must be greater than zero and at most 1 USDC, with up to six decimals.');
  }
  return {
    apiUrl: apiOrigin(env.API_URL || 'https://api.arcgate.dev'),
    maxPayment: 10_000n, // 0.01 USDC per API call
    maxTotal: 25_000n, // Search + quote + swap; never reset after a timeout.
    amount,
    buyToken: getAddress(CIRBTC),
    slippageBps: 100,
  };
}

// Merge the network's row into the validated config, then apply the env overrides.
export function forNetwork(config, network, env = process.env) {
  if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
    throw new Error(`Unsupported payment network ${network ?? '(none)'}; expected ${Object.keys(NETWORKS).join(' or ')}. No payment signed.`);
  }
  const row = NETWORKS[network];
  if (env.ARC_RPC_URL) checkedUrl(env.ARC_RPC_URL, 'ARC_RPC_URL');
  const rpcUrl = env.ARC_RPC_URL || row.rpcUrl;
  return {
    ...config, ...row, network, rpcUrl,
    // Where the row pays fees from its trade RPC, an RPC override applies to both.
    paymentRpcUrl: row.paymentRpcUrl === row.rpcUrl ? rpcUrl : row.paymentRpcUrl,
    payTo: getAddress(env.ARCGATE_PAY_TO || row.payTo),
    router: getAddress(env.ARCGATE_ROUTER_ADDRESS || row.router),
  };
}

export function requireApiKey(config, env = process.env) {
  if (!env.CIRCLE_API_KEY?.startsWith(config.apiKeyPrefix)) {
    const keyType = config.apiKeyPrefix.slice(0, -1);
    throw new Error(`The API pays on ${config.network}. Use a Circle ${keyType} and an ${config.blockchain} wallet; the other key type cannot pay here.`);
  }
}

export function reportError(error, env = process.env) {
  let message = error instanceof Error ? error.message : 'Unexpected error.';
  for (const value of [env.CIRCLE_API_KEY, env.CIRCLE_ENTITY_SECRET, env.ARC_RPC_URL]) {
    if (value) message = message.split(value).join('[redacted]');
  }
  // RPC client diagnostics can include provider keys inside URLs.
  console.error(message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  process.exitCode = 1;
}
