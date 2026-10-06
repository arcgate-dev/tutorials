import { decodeFunctionData, erc20Abi, getAddress, parseAbi, parseUnits } from 'viem';
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

export function pickToken(search, expected) {
  ensure(search.network === 'eip155:5042' && ['verified', 'clear_leader', 'single'].includes(search.resolution), 'Search is unresolved or on another network.');
  const token = search.results?.[0];
  ensure(token && same(token.address, expected) && token.verification?.status === 'verified'
    && Array.isArray(token.flags) && token.flags.length === 0, 'Search did not resolve to the expected verified token without flags.');
  return token;
}

export function reviewQuote(quote, config, wallet, now = Math.floor(Date.now() / 1000)) {
  ensure(quote.network === config.tradeNetwork && quote.side === 'exactIn', 'Unexpected quote network or side.');
  ensure(same(quote.sell.address, USDC) && quote.sell.decimals === 6
    && same(quote.buy.address, config.buyToken) && quote.buy.decimals === 8, 'Unexpected quote tokens or decimals.');
  ensure(quote.sell.amountRaw === parseUnits(config.amount, 6).toString()
    && parseUnits(quote.sell.amount, 6) === parseUnits(config.amount, 6), 'Quote changed the requested sell amount.');
  ensure(['ok', 'pinned'].includes(quote.safety?.verdict), 'Quote safety verdict is not accepted by this tutorial.');
  ensure(quote.next === 'swap', 'Quote does not say to swap (it may say stop, requote or fix_request). Review its warnings.');
  ensure(quote.best.executable !== false, 'Quote says to stop or has no executable route. Review its warnings.');
  if (quote.readiness) {
    ensure(!wallet || same(quote.readiness.taker, wallet.address), 'Quote readiness is for another wallet.');
    ensure(quote.readiness.ready === true, 'Wallet readiness failed. Review the input balance, gas and swap fee before continuing.');
  }
  ensure(quote.slippageBps === config.slippageBps && Date.parse(quote.expiresAt) > now * 1000, 'Quote is expired or changed slippage.');
  const minOut = parseUnits(quote.best.minAmountOut, quote.buy.decimals);
  ensure(minOut > 0n, 'Quote has no positive minimum output.');
  return minOut;
}

export function reviewSwap(swap, quote, wallet, config, minOut, now = Math.floor(Date.now() / 1000)) {
  ensure(swap.quoteId === quote.quoteId && same(swap.recipient, wallet.address), 'Swap changed quote or recipient.');
  ensure(swap.signatures?.length === 0, 'Expected approval="approve" with no Permit2 signatures.');
  ensure(swap.next === 'send', 'Swap requires another action; do not send its transactions.');
  ensure(['ok', 'pinned'].includes(swap.safety?.verdict), 'Swap safety verdict is not accepted.');
  ensure(Date.parse(swap.expiresAt) > now * 1000, 'Swap has expired.');
  const txs = swap.transactions;
  ensure(Array.isArray(txs) && txs.length >= 1 && txs.length <= 2
    && txs.at(-1).purpose === 'swap' && (txs.length === 1 || txs[0].purpose === 'approve'), 'Expected at most one approval, followed by one swap.');
  const amount = parseUnits(config.amount, 6);
  return txs.map(tx => {
    ensure(/^\d+$/.test(tx.value) && /^0x(?:[a-fA-F0-9]{2})+$/.test(tx.data), 'Malformed transaction.');
    if (tx.purpose === 'approve') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      ensure(same(tx.to, USDC) && BigInt(tx.value) === 0n && decoded.functionName === 'approve'
        && same(decoded.args[0], config.router) && decoded.args[1] === amount, 'Approval must allow only the configured router and exact sell amount.');
      return { purpose: 'approve', token: tx.to, spender: decoded.args[0], amount: decoded.args[1].toString() };
    }
    const decoded = decodeFunctionData({ abi: routerAbi, data: tx.data });
    const [tokenIn, amountIn, tokenOut, minimum, recipient, deadline, steps, pull] = decoded.args;
    ensure(same(tx.to, config.router) && same(tokenIn, USDC) && amountIn === amount
      && same(tokenOut, config.buyToken) && same(recipient, wallet.address)
      && minimum >= minOut && minimum > 0n && deadline > BigInt(now) && deadline <= BigInt(now + 630)
      && steps.length > 0, 'Decoded swap does not match the order, minimum output, recipient or deadline.');
    const native = BigInt(tx.value) === amount * 10n ** 12n && pull.mode === 2;
    const erc20 = BigInt(tx.value) === 0n && pull.mode === 0;
    ensure(native || erc20, 'Unexpected native value or input pull mode.');
    ensure(pull.signature === '0x', 'Unexpected embedded permit signature.');
    return { purpose: 'swap', router: tx.to, tokenIn, amountIn: String(amountIn), tokenOut,
      minOut: String(minimum), recipient, deadline: String(deadline), funding: native ? 'native USDC (18 decimals)' : 'ERC-20 USDC (6 decimals)', steps: steps.length };
  });
}
