import { parse, stringify } from 'yaml';
import { getAddress } from 'viem';
import { PERMIT2 } from './guards.js';
import { USDC } from './payment.js';

export function reviewPolicy(yaml, wallet, config) {
  const policy = parse(yaml);
  if (policy?.schema_version !== 1 || getAddress(policy.wallet_address) !== wallet.address) throw new Error('Unexpected wallet policy owner or schema.');
  const problems = [];
  if (!policy.evm?.allowed_chains?.includes(5042)) problems.push('Arc mainnet (5042) is absent from evm.allowed_chains');
  const limit = policy.evm?.outflow_limits_usd?.rolling_24h;
  if (limit !== null && (typeof limit !== 'number' || limit < Number(config.amount) + Number(config.maxTotal) / 1e6)) problems.push('the rolling_24h outflow limit is below the order plus API fees');
  const relevant = [USDC, PERMIT2, config.router, config.buyToken, config.payTo, wallet.address];
  const covers = (entry, address) => [0, 5042].includes(entry.chain_id) && getAddress(entry.address) === getAddress(address);
  for (const address of relevant) {
    if (policy.addresses?.blocklist?.some(entry => covers(entry, address))) problems.push(`blocklist covers ${address}`);
    const allowlist = policy.addresses?.allowlist;
    if (allowlist?.length && !allowlist.some(entry => covers(entry, address))) problems.push(`nonempty allowlist does not cover ${address}`);
  }
  return { chainId: 5042, rolling24hUsd: limit, problems,
    note: 'This is a local configuration check. MetaMask Shield, route targets, recipient risk and spent daily budget are checked by the service when submitting.' };
}

export function requirePolicy(review) {
  if (review.problems.length) throw new Error(`Review mm wallet policy before trading: ${review.problems.join('; ')}. See the tutorial policy section.`);
}

// Build a reviewable proposal from the current document. Never apply it, remove
// blocklist entries, discard custom restrictions or switch out of guard mode.
export function proposePolicy(yaml, wallet, config) {
  reviewPolicy(yaml, wallet, config);
  const policy = parse(yaml);
  if (!policy.evm || !Array.isArray(policy.evm.allowed_chains)
    || !policy.addresses || !Array.isArray(policy.addresses.allowlist) || !Array.isArray(policy.addresses.blocklist)) throw new Error('Unexpected policy shape; edit the original document manually.');
  const relevant = [USDC, PERMIT2, config.router, config.buyToken, config.payTo, wallet.address];
  const covers = (entry, address) => [0, 5042].includes(entry.chain_id) && getAddress(entry.address) === getAddress(address);
  if (relevant.some(address => policy.addresses.blocklist.some(entry => covers(entry, address)))) throw new Error('An existing blocklist entry prevents this trade. Review it manually; the proposal will not remove it.');
  if (!policy.evm.allowed_chains.includes(5042)) policy.evm.allowed_chains.push(5042);
  const current = policy.evm.outflow_limits_usd?.rolling_24h;
  if (current !== null) {
    if (typeof current !== 'number' || current < 0) throw new Error('Unexpected outflow limit; edit manually.');
    policy.evm.outflow_limits_usd.rolling_24h = Math.max(current, 2);
  }
  if (policy.addresses.allowlist.length) {
    for (const address of relevant) {
      if (!policy.addresses.allowlist.some(entry => covers(entry, address))) policy.addresses.allowlist.push({ address, chain_id: 5042 });
    }
  }
  return '# Review before applying. MetaMask requires MFA for broadening changes.\n' + stringify(policy);
}
