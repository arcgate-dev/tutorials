import { randomUUID } from 'node:crypto';
import { erc20Abi, formatUnits, parseEventLogs, parseUnits } from 'viem';
import { USDC } from './payment.js';
import { pickToken, reviewQuote, reviewSwap } from './guards.js';

// Dependencies are explicit so the entire tutorial can be tested without any
// deployed service, RPC, Circle account or funded wallet.
export async function runFlow(command, { wallet, config, api, rpc, send, log = console.log }) {
  if (!['search', 'quote', 'preview', 'trade'].includes(command)) throw new Error('Unknown tutorial command.');
  const search = await api('search', { query: 'cirBTC', limit: 5 });
  log(JSON.stringify({ resolution: search.resolution, results: search.results.map(({ address, symbol, verification, flags }) => ({ address, symbol, verification, flags })) }, null, 2));
  const token = pickToken(search, config.buyToken);
  if (command === 'search') return { search };

  const quote = await api('quote', { sell: USDC, buy: token.address, amount: config.amount, side: 'exactIn', slippageBps: config.slippageBps });
  const minOut = reviewQuote(quote, config);
  log(JSON.stringify({ quoteId: quote.quoteId, expiresAt: quote.expiresAt, sell: quote.sell.amount,
    amountOutQuoted: quote.best.amountOutQuoted, minAmountOut: quote.best.minAmountOut, safety: quote.safety.verdict }, null, 2));
  if (command === 'quote') return { quote };

  // /swap simulates from the taker's real balance, even for a preview.
  const balance = await rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  if (balance < parseUnits(config.amount, 6) + config.maxPayment) throw new Error('Fund the wallet with the sell amount, remaining API fee and extra USDC for gas before requesting a swap.');
  const swap = await api('swap', { quoteId: quote.quoteId, taker: wallet.address, recipient: wallet.address, approval: 'approve', deadlineSec: 300 });
  const decoded = reviewSwap(swap, quote, wallet, config, minOut);
  log(JSON.stringify({ transactions: decoded }, null, 2));
  if (command === 'preview') {
    log('Preview complete. API fees were paid; no approval or swap transaction was sent.');
    return { quote, swap };
  }

  const before = await rpc.readContract({ address: config.buyToken, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  const receipts = [];
  for (const tx of swap.transactions) {
    reviewSwap(swap, quote, wallet, config, minOut); // Refuse an expired deadline before each send.
    const hash = await send(tx, randomUUID());
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted. Stop and inspect the run log.`);
    receipts.push(receipt);
    log(`${tx.purpose}: ${hash}`);
  }
  const after = await rpc.readContract({ address: config.buyToken, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  const delivered = after - before;
  const transfers = receipts.flatMap(receipt => parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }))
    .filter(event => event.address.toLowerCase() === config.buyToken.toLowerCase() && event.args.to.toLowerCase() === wallet.address.toLowerCase())
    .reduce((total, event) => total + event.args.value, 0n);
  if (delivered < minOut || transfers !== delivered) throw new Error('Swap mined, but delivery did not match the minimum and Transfer logs. Inspect the receipts.');
  log(`Delivered ${formatUnits(delivered, 8)} cirBTC; minimum ${formatUnits(minOut, 8)} cirBTC.`);
  return { quote, swap, delivered, receipts };
}
