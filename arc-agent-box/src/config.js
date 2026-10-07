export const ALLOWED_NETWORKS = { 'eip155:5042': 5042, 'eip155:5042002': 5042002 };

// Every route this tutorial calls: operationId -> [method, path template], as in arcgate's OpenAPI document.
// A paid call is authenticated by its x402 payment. An owner call is free and signed by the wallet.
export const PAID_OPERATIONS = {
  boxCreate: ['POST', '/agent/v1/{address}/box'],
  boxTopUp: ['POST', '/agent/v1/{address}/box/topup'],
  inboundCreate: ['POST', '/agent/v1/{address}/inbound'],
  watchCreate: ['POST', '/agent/v1/{address}/watch'],
  webhookCreate: ['POST', '/agent/v1/{address}/webhook'],
  tradeSearch: ['POST', '/trade/v1/search'],
};
export const OWNER_OPERATIONS = {
  boxStatus: ['GET', '/agent/v1/{address}/box/status'],
  boxMessageList: ['GET', '/agent/v1/{address}/box/messages'],
  boxMessageFetch: ['GET', '/agent/v1/{address}/box/messages/{seq}'],
  boxMessageDelete: ['DELETE', '/agent/v1/{address}/box/messages/{seq}'],
  inboundList: ['GET', '/agent/v1/{address}/inbound/list'],
  inboundDelete: ['DELETE', '/agent/v1/{address}/inbound/{id}'],
  inboundRotate: ['POST', '/agent/v1/{address}/inbound/{id}/rotate'],
  watchList: ['GET', '/agent/v1/{address}/watch/list'],
  watchDelete: ['DELETE', '/agent/v1/{address}/watch/{id}'],
  webhookList: ['GET', '/agent/v1/{address}/webhook/list'],
  webhookDelete: ['DELETE', '/agent/v1/{address}/webhook/{id}'],
  webhookRotate: ['POST', '/agent/v1/{address}/webhook/{id}/rotate'],
};

// What the watch step watches. With the indexer off, the only thing that makes the index report a token is a search
// that finds its evidence missing or stale and checks it, and a token is checked once. A pinned asset such as cirBTC
// is never checked. So the default is the token the recorded run searched, and WATCH_TOKEN picks another for a rerun.
const FAZE = '0xf81afef268aca40717e0adcae7c41514327cfaab';
export const tokenWatch = token => ({ kind: 'token', token, where: [{ field: 'volume_24h', op: 'gt', value: 100_000 }] });
export const SCREEN_WATCH = { kind: 'screen', where: [
  { field: 'volume_24h', op: 'gt', value: 100_000 },
  { field: 'safety_verdict', op: 'eq', value: 'ok' },
] };
// chainId is the agent directory's chain (Arc mainnet, the one the deployment serves, shown in boxStatus.registeredAgents), not the payment network.
export const AGENTS_WATCH = { kind: 'agents', chainId: 5042, on: ['registered'] };

// The one origin rule: https, or http only for localhost and 127.0.0.1, with no credentials, query or fragment.
function checkOrigin(url) {
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('A URL must be https (http only for localhost and 127.0.0.1) with no credentials, query or fragment.');
  }
}

export function apiOrigin(value) {
  const url = new URL(value);
  checkOrigin(url);
  if (url.pathname !== '/') throw new Error('API_URL must be an origin with no path.');
  return url.origin;
}

// An inbound address: the notifier's origin and one path segment, the address id.
export function inboundUrl(value) {
  const url = new URL(value);
  checkOrigin(url);
  if (!/^\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('An inbound url is an origin and one path segment.');
  return value;
}

function watchToken(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('WATCH_TOKEN must be a token address.');
  return value.toLowerCase();
}

export function loadConfig(env = process.env) {
  return {
    apiUrl: apiOrigin(env.API_URL || 'https://api.arcgate.dev'),
    rpcUrl: env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io',
    webhookUrl: env.WEBHOOK_URL || 'https://192.0.2.10/arc-agent-box',
    watchToken: watchToken(env.WATCH_TOKEN || FAZE),
    maxPayment: 50_000n, // 0.05 USDC per API call
    maxTotal: 160_000n, // per command run: box 0.05 + inbound 0.01 + 3 watches 0.03 + search 0.005 + webhook 0.01 + topup 0.05 = 0.155. Never reset after a timeout.
  };
}

export function reportError(error, env = process.env) {
  let message = error instanceof Error ? error.message : 'Unexpected error.';
  for (const value of [env.PRIVATE_KEY, env.ARC_RPC_URL]) {
    if (value) message = message.split(value).join('[redacted]');
  }
  // RPC client diagnostics can include provider keys inside URLs.
  console.error(message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  process.exitCode = 1;
}
