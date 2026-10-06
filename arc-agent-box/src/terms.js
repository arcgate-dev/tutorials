import { ALLOWED_NETWORKS, PAID_OPERATIONS } from './config.js';
import { readApiResponse, request } from './http.js';

// The API's own terms, read before anything is signed: /health names the payment network, and
// /openapi.json gives each paid operation's price (x-payment.baseUnits). Both are free.
export async function loadTerms(config, fetchFn) {
  const health = await readApiResponse('health', await request(fetchFn, `${config.apiUrl}/health`));
  if (!health.ok || !health.x402?.enabled || !Object.hasOwn(ALLOWED_NETWORKS, health.x402.network)) {
    throw new Error('The API is unavailable, has payments off, or uses a payment network other than Arc mainnet or Arc testnet. No payment signed.');
  }
  const spec = await readApiResponse('openapi', await request(fetchFn, `${config.apiUrl}/openapi.json`));
  const prices = {};
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(methods)) {
      if (operation['x-payment']) prices[operation.operationId] = operation['x-payment'];
    }
  }
  const terms = {};
  for (const operationId of Object.keys(PAID_OPERATIONS)) {
    const price = prices[operationId];
    if (!price || price.asset !== 'USDC' || !/^\d+$/.test(price.baseUnits) || BigInt(price.baseUnits) <= 0n || BigInt(price.baseUnits) > config.maxPayment) {
      throw new Error(`${operationId}: the API's price is missing, not in USDC or above the per-call cap. No payment signed.`);
    }
    terms[operationId] = price.baseUnits;
  }
  return { health, terms };
}
