import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress } from 'viem';
import { ALLOWED_NETWORKS } from './config.js';
import { readApiResponse, request } from './http.js';

export const USDC = '0x3600000000000000000000000000000000000000';
export const authorizationTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

// An offer is paid only when it is exact USDC on the network /health names, for exactly the price the API
// published for this operation, within the per-call cap, to the one payTo this run has paid so far.
export function acceptOffer(offer, { network, price, payTo, maxPayment }) {
  try {
    return offer.scheme === 'exact' && offer.network === network
      && getAddress(offer.asset) === USDC && (payTo === undefined || getAddress(offer.payTo) === payTo)
      && offer.amount === price && /^\d+$/.test(offer.amount) && BigInt(offer.amount) > 0n && BigInt(offer.amount) <= maxPayment
      && Number.isInteger(offer.maxTimeoutSeconds) && offer.maxTimeoutSeconds > 0 && offer.maxTimeoutSeconds <= 300
      && offer.extra?.name === 'USDC' && offer.extra?.version === '2'
      && (offer.extra.paymentFlow === undefined || offer.extra.paymentFlow === 'authorization')
      && (offer.extra.assetTransferMethod === undefined || offer.extra.assetTransferMethod === 'eip3009');
  } catch { return false; }
}

// What the wallet is about to sign must be the accepted offer and nothing else.
export function assertAuthorization(data, wallet, { chainId, payTo, amount }, now = Math.floor(Date.now() / 1000)) {
  const { domain, message, types, primaryType } = data;
  const shape = Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'EIP712Domain'));
  if (primaryType !== 'TransferWithAuthorization' || JSON.stringify(shape) !== JSON.stringify(authorizationTypes)
      || BigInt(domain.chainId) !== BigInt(chainId) || getAddress(domain.verifyingContract) !== USDC
      || domain.name !== 'USDC' || domain.version !== '2'
      || getAddress(message.from) !== wallet.address || getAddress(message.to) !== payTo
      || BigInt(message.value) !== BigInt(amount)
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

// The one paid client: box, top-up, inbound, watch, webhook and search all pay through it. `terms` holds each
// operation's price, read from the API (see terms.js), and `health` names the payment network.
export function createArcgateClient({ wallet, config, health, terms, fetchFn = fetch, record = () => {} }) {
  const network = health.x402.network;
  let reserved = 0n;
  let payTo;

  return async function call(operationId, method, path, body) {
    const price = terms[operationId];
    if (!price) throw new Error(`${operationId}: the API published no price for this operation. No payment signed.`);
    const url = `${config.apiUrl}${path}`;
    const init = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...body !== undefined && { body: JSON.stringify(body) } };
    const unpaid = await request(fetchFn, url, init);
    // Only a 402 is an offer. Anything else is the answer, and nothing is signed.
    if (unpaid.status !== 402) return readApiResponse(operationId, unpaid, record);

    const required = await paymentRequired(unpaid);
    const offer = required.accepts.find(value => acceptOffer(value, { network, price, payTo, maxPayment: config.maxPayment }));
    if (!offer) throw new Error(`${operationId}: the payment network, asset, recipient, price or timeout differs from the API's terms and the configured limits. No payment signed.`);
    if (reserved + BigInt(offer.amount) > config.maxTotal) throw new Error('This run would exceed the total API payment budget.');
    // Reserve before signing; a timeout must never free the budget for a replacement payment.
    reserved += BigInt(offer.amount);
    payTo = getAddress(offer.payTo);

    const expected = { chainId: ALLOWED_NETWORKS[network], payTo, amount: offer.amount };
    const signer = {
      address: wallet.address,
      async signTypedData(data) {
        assertAuthorization(data, wallet, expected);
        return wallet.signTypedData(data);
      },
    };
    const client = x402Client.fromConfig({
      schemes: [{ network, client: new ExactEvmScheme(signer) }],
      spendControls: { allowedAssets: [{ network, asset: USDC, maxAmountPerPayment: String(config.maxPayment) }] },
    });
    const payload = await client.createPaymentPayload({ ...required, accepts: [offer] });
    record({ operation: operationId, amount: offer.amount, network, state: 'signed' });

    let paid;
    try { paid = await request(fetchFn, url, { ...init, headers: { ...init.headers, ...new x402HTTPClient(client).encodePaymentSignatureHeader(payload) } }); }
    catch { throw new Error(`${operationId}: response lost after payment was signed. It may have settled. Do not automatically retry.`); }
    const receipt = paid.headers.get('payment-response');
    const settlement = receipt ? decodePaymentResponseHeader(receipt) : null;
    const result = await readApiResponse(operationId, paid, record, settlement);
    if (!settlement?.success || settlement.network !== network
        || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction ?? '')
        || getAddress(settlement.payer) !== wallet.address) {
      throw new Error(`${operationId}: missing or unexpected payment receipt. Payment may have settled; inspect the run log.`);
    }
    record({ operation: operationId, amount: offer.amount, network, state: 'settled', transaction: settlement.transaction, requestId: paid.headers.get('x-request-id') });
    return result;
  };
}
