import type { PaymentRequirements } from '@x402/core/types';
import type { Config } from './config.ts';

const USDC = '0x3600000000000000000000000000000000000000';
const MAX_TIMEOUT_SECONDS = 300;

type Policy = Pick<Config, 'networks' | 'maxPerCall'>;

/** The budget refused a payment: the per-run cap would be passed. */
export class SpendCapError extends Error {}

/** Whether an offer is one this tutorial signs: USDC by `exact` on an Arc network, a whole positive amount within the per-call cap. */
export function acceptOffer(offer: PaymentRequirements, config: Policy): boolean {
  const { network, asset, scheme, amount, maxTimeoutSeconds, extra } = offer;
  return config.networks.includes(network)
    && scheme === 'exact'
    && asset === USDC
    && extra?.name === 'USDC' && extra?.version === '2'
    && typeof amount === 'string' && /^[1-9][0-9]*$/.test(amount) && BigInt(amount) <= config.maxPerCall
    && Number.isInteger(maxTimeoutSeconds) && maxTimeoutSeconds >= 1 && maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS;
}

/**
 * The offer to sign: the first accepted one. The x402 client uses this as its selector, so the offer
 * that is reserved and priced is the offer that is signed.
 */
export function selectOffer(offers: PaymentRequirements[], config: Policy): PaymentRequirements | undefined {
  return offers.find((offer) => acceptOffer(offer, config));
}

/** The per-run cap. Every signed payment is reserved and never released: a signed authorization can still settle. */
export function createBudget(config: Pick<Config, 'maxPerRun'>) {
  let reserved = 0n;
  return {
    get reserved() {
      return reserved;
    },
    reserve(amount: bigint) {
      if (reserved + amount > config.maxPerRun) {
        throw new SpendCapError(`Refusing a payment of ${amount} base units: ${reserved} are reserved and the cap for a run is ${config.maxPerRun}.`);
      }
      reserved += amount;
    },
  };
}
