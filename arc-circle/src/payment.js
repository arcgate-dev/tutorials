import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress } from 'viem';
import { signTypedData } from './circle.js';
import { readApiResponse } from './errors.js';

export const USDC = '0x3600000000000000000000000000000000000000';
export const authorizationTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

export function acceptOffer(offer, config) {
  try {
    return offer.scheme === 'exact' && offer.network === config.network
      && getAddress(offer.asset) === USDC && getAddress(offer.payTo) === getAddress(config.payTo)
      && /^\d+$/.test(offer.amount) && BigInt(offer.amount) > 0n && BigInt(offer.amount) <= config.maxPayment
      && Number.isInteger(offer.maxTimeoutSeconds) && offer.maxTimeoutSeconds > 0 && offer.maxTimeoutSeconds <= 300
      && offer.extra?.name === 'USDC' && offer.extra?.version === '2'
      && (offer.extra.paymentFlow === undefined || offer.extra.paymentFlow === 'authorization')
      && (offer.extra.assetTransferMethod === undefined || offer.extra.assetTransferMethod === 'eip3009');
  } catch { return false; }
}

export function assertAuthorization(data, wallet, config, now = Math.floor(Date.now() / 1000)) {
  const { domain, message, types, primaryType } = data;
  const shape = Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'EIP712Domain'));
  if (primaryType !== 'TransferWithAuthorization' || JSON.stringify(shape) !== JSON.stringify(authorizationTypes)
      || BigInt(domain.chainId) !== BigInt(config.paymentChainId) || getAddress(domain.verifyingContract) !== USDC
      || domain.name !== 'USDC' || domain.version !== '2'
      || getAddress(message.from) !== wallet.address || getAddress(message.to) !== getAddress(config.payTo)
      || BigInt(message.value) <= 0n || BigInt(message.value) > config.maxPayment
      || BigInt(message.validAfter) > BigInt(now) || BigInt(message.validAfter) < 0n
      || BigInt(message.validBefore) <= BigInt(now) || BigInt(message.validBefore) > BigInt(now + 330)
      || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) {
    throw new Error('Refusing an unexpected x402 payment authorization.');
  }
}

export async function paymentRequired(response) {
  const header = response.headers.get('payment-required');
  const body = header ? decodePaymentRequiredHeader(header) : await response.json();
  if (body.x402Version !== 2 || !Array.isArray(body.accepts)) throw new Error('Expected x402 v2 payment requirements.');
  return body;
}

export function createArcgateClient({ circle, wallet, config, fetchFn = fetch, record = () => {} }) {
  let reserved = 0n;
  const signer = {
    address: wallet.address,
    async signTypedData(data) {
      assertAuthorization(data, wallet, config);
      return signTypedData(circle, wallet, data);
    },
  };
  const client = x402Client.fromConfig({
    schemes: [{ network: config.network, client: new ExactEvmScheme(signer) }],
    policies: [(_version, offers) => offers.filter(offer => acceptOffer(offer, config))],
    spendControls: { allowedAssets: [{ network: config.network, asset: USDC, maxAmountPerPayment: String(config.maxPayment) }] },
  });
  const httpClient = new x402HTTPClient(client);

  return async function call(operation, body) {
    if (!['search', 'quote', 'swap'].includes(operation)) throw new Error('Unknown Arcgate operation.');
    const url = `${config.apiUrl}/trade/v1/${operation}`;
    const init = { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const request = headers => fetchFn(url, { ...init, headers, signal: AbortSignal.timeout(90_000) });
    const unpaid = await request(init.headers);
    if (unpaid.status !== 402) {
      await readApiResponse(operation, unpaid, record);
      throw new Error(`${operation}: expected HTTP 402, received ${unpaid.status}. No payment signed.`);
    }
    const required = await paymentRequired(unpaid);
    const offer = required.accepts.find(value => acceptOffer(value, config));
    if (!offer) throw new Error(`${operation}: payment network, asset, recipient, price or timeout differs from the configured limits. Run npm run inspect.`);
    if (reserved + BigInt(offer.amount) > config.maxTotal) throw new Error('This run would exceed the total API payment budget.');
    // Reserve before signing; a timeout must never free the budget for a replacement payment.
    reserved += BigInt(offer.amount);
    const payload = await client.createPaymentPayload({ ...required, accepts: [offer] });
    record({ operation, amount: offer.amount, network: offer.network, state: 'signed' });
    let paid;
    try { paid = await request({ ...init.headers, ...httpClient.encodePaymentSignatureHeader(payload) }); }
    catch { throw new Error(`${operation}: response lost after payment was signed. It may have settled. Do not automatically retry.`); }
    const receipt = paid.headers.get('payment-response');
    const settlement = receipt ? decodePaymentResponseHeader(receipt) : null;
    const result = await readApiResponse(operation, paid, record, settlement);
    if (!settlement?.success || settlement.network !== config.network
        || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction ?? '')
        || getAddress(settlement.payer) !== wallet.address) {
      throw new Error(`${operation}: missing or unexpected payment receipt. Payment may have settled; inspect the run log.`);
    }
    record({ operation, amount: offer.amount, network: offer.network, state: 'settled', transaction: settlement.transaction,
      requestId: paid.headers.get('x-request-id') });
    return result;
  };
}
