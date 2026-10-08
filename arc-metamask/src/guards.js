import { decodeFunctionData, erc20Abi, getAddress, maxUint256, parseAbi, parseUnits, zeroAddress } from 'viem';
import { USDC } from './payment.js';

// The public ArcgateRouter executeGraph interface. This is an ABI description,
// not the router implementation. No Arcgate package or ABI download is needed.
export const routerAbi = parseAbi([
  'struct Step { address target; address tokenIn; uint8 mode; uint32 amountOffset; bytes data; }',
  'struct GraphStep { Step step; address tokenOut; uint128 weight; uint128 remainingWeight; uint256 minOut; }',
  'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }',
  'struct InputPull { uint8 mode; PermitSingle permit; bytes signature; }',
  'function executeGraph(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, address recipient, uint256 deadline, GraphStep[] steps, InputPull pull) payable returns (uint256 amountOut)',
]);

const same = (left, right) => getAddress(left) === getAddress(right);
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function pickToken(search, config) {
  const expected = config.buyToken;
  ensure(search.network === config.tradeNetwork && ['verified', 'clear_leader', 'single'].includes(search.resolution), 'Search is unresolved or on another network.');
  const token = search.results?.[0];
  ensure(token && same(token.address, expected) && token.verification?.status === 'verified'
    && Array.isArray(token.flags) && token.flags.length === 0, 'Search did not resolve to the expected verified token without flags.');
  return token;
}

export function reviewQuote(quote, config) {
  ensure(quote.network === config.tradeNetwork && quote.side === 'exactIn', 'Unexpected quote network or side.');
  // Anything but next=swap is the API telling the caller not to swap.
  ensure(quote.best?.executable === true && quote.next === 'swap', 'The API does not say this quote can be swapped.');
  ensure(same(quote.sell.address, USDC) && quote.sell.decimals === 6
    && same(quote.buy.address, config.buyToken) && quote.buy.decimals === 8, 'Unexpected quote tokens or decimals.');
  ensure(quote.sell.amountRaw === parseUnits(config.amount, 6).toString()
    && parseUnits(quote.sell.amount, 6) === parseUnits(config.amount, 6), 'Quote changed the requested sell amount.');
  ensure(['ok', 'pinned'].includes(quote.safety?.verdict), 'Quote safety verdict is not accepted by this tutorial.');
  ensure(quote.slippageBps === config.slippageBps && Date.parse(quote.expiresAt) > Date.now(), 'Quote is expired or changed slippage.');
  const minOut = parseUnits(quote.best.minAmountOut, quote.buy.decimals);
  ensure(minOut > 0n, 'Quote has no positive minimum output.');
  return minOut;
}

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const permitTypes = {
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
};

export function reviewPermit(data, config, now = Math.floor(Date.now() / 1000)) {
  const { domain, message, types, primaryType } = data;
  const keys = Object.keys(types).filter(key => key !== 'EIP712Domain').sort();
  ensure(primaryType === 'PermitSingle' && keys.join(',') === 'PermitDetails,PermitSingle'
    && keys.every(key => JSON.stringify(types[key]) === JSON.stringify(permitTypes[key])), 'Unexpected Permit2 typed-data schema.');
  ensure(domain.name === 'Permit2' && domain.version === undefined
    && BigInt(domain.chainId) === BigInt(config.tradeChainId) && same(domain.verifyingContract, PERMIT2), 'Unexpected Permit2 domain.');
  const { details, spender, sigDeadline } = message;
  ensure(same(spender, config.router) && same(details.token, USDC)
    && BigInt(details.amount) === parseUnits(config.amount, 6), 'Permit2 changed the token, spender or sell amount.');
  ensure(BigInt(sigDeadline) > BigInt(now) && BigInt(sigDeadline) <= BigInt(now + 330)
    && BigInt(details.expiration) > BigInt(now) && BigInt(details.expiration) <= BigInt(now + 30 * 86400 + 30)
    && BigInt(details.nonce) >= 0n && BigInt(details.nonce) < 2n ** 48n, 'Unexpected Permit2 nonce or lifetime.');
  return message;
}

function samePermit(left, right) {
  return same(left.details.token, right.details.token) && same(left.spender, right.spender)
    && ['amount', 'expiration', 'nonce'].every(key => BigInt(left.details[key]) === BigInt(right.details[key]))
    && BigInt(left.sigDeadline) === BigInt(right.sigDeadline);
}

const emptyPermit = { details: { token: zeroAddress, amount: 0n, expiration: 0n, nonce: 0n }, spender: zeroAddress, sigDeadline: 0n };

// This tutorial deliberately requests a fresh Permit2 signature. It refuses native
// funding or a sufficient standing Permit2 allowance instead of claiming they prove signing.
export function reviewSwap(swap, quote, wallet, config, minOut, signed = null, now = Math.floor(Date.now() / 1000)) {
  ensure(swap.quoteId === quote.quoteId && same(swap.recipient, wallet.address), 'Swap changed quote or recipient.');
  ensure(['ok', 'pinned'].includes(swap.safety?.verdict), 'Swap safety verdict is not accepted.');
  ensure(Date.parse(swap.expiresAt) > now * 1000, 'Swap has expired.');
  if (signed) {
    ensure(swap.next === 'send', 'The API does not say to send the final swap.');
    ensure(swap.signatures?.length === 0, 'Final swap still asks for a signature; do not send placeholder calldata.');
    reviewPermit(signed.typedData, config, now);
  } else {
    ensure(swap.next === 'sign_permit', 'The API does not ask for a Permit2 signature.');
    ensure(swap.signatures?.length === 1 && swap.signatures[0].kind === 'permit2', 'Expected a fresh Permit2 signature. This route or allowance does not demonstrate the tutorial.');
    reviewPermit(swap.signatures[0].typedData, config, now);
  }
  const txs = swap.transactions;
  ensure(Array.isArray(txs) && txs.length >= 1 && txs.length <= 2
    && txs.at(-1).purpose === 'swap' && (txs.length === 1 || txs[0].purpose === 'approve'), 'Expected at most one approval, followed by one swap.');
  const amount = parseUnits(config.amount, 6);
  return txs.map(tx => {
    ensure(/^\d+$/.test(tx.value) && BigInt(tx.value) === 0n
      && /^\d+$/.test(tx.gas) && BigInt(tx.gas) > 0n && BigInt(tx.gas) <= 2_000_000n
      && /^0x(?:[a-fA-F0-9]{2})+$/.test(tx.data), 'Malformed transaction or unexpected value/gas.');
    if (tx.purpose === 'approve') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      ensure(same(tx.to, USDC) && decoded.functionName === 'approve'
        && same(decoded.args[0], PERMIT2) && decoded.args[1] === maxUint256, 'Expected the API\'s USDC approval to Permit2, never another spender.');
      return { purpose: 'approve', token: tx.to, spender: PERMIT2, amount: 'unlimited ERC-20 allowance to Permit2' };
    }
    ensure(same(tx.to, config.router), 'Swap destination is not the pinned router.');
    const decoded = decodeFunctionData({ abi: routerAbi, data: tx.data });
    const [tokenIn, amountIn, tokenOut, minimum, recipient, deadline, steps, pull] = decoded.args;
    ensure(same(tokenIn, USDC) && amountIn === amount && same(tokenOut, config.buyToken)
      && same(recipient, wallet.address) && minimum >= minOut && minimum > 0n
      && deadline > BigInt(now) && deadline <= BigInt(now + 330) && steps.length > 0
      && pull.mode === 1, 'Decoded swap changed the order, output floor, recipient, deadline or Permit2 pull mode.');
    if (signed) {
      ensure(pull.signature.toLowerCase() === signed.signature.toLowerCase()
        && samePermit(pull.permit, signed.typedData.message), 'Embedded permit differs from the one this wallet signed.');
    } else {
      ensure(pull.signature === '0x' && samePermit(pull.permit, emptyPermit), 'Unexpected signed permit in the first swap response.');
    }
    return { purpose: 'swap', router: tx.to, tokenIn, amountIn: String(amountIn), tokenOut,
      minOut: String(minimum), recipient, deadline: String(deadline), funding: 'Permit2',
      permitAttached: Boolean(signed), routeTargets: [...new Set(steps.map(value => value.step.target))] };
  });
}
