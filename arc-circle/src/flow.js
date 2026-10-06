import { randomUUID } from 'node:crypto';
import { erc20Abi, formatUnits, getAddress, parseEventLogs, parseUnits } from 'viem';
import { USDC } from './payment.js';
import { pickToken, reviewQuote, reviewSwap } from './guards.js';

// Dependencies are explicit so the entire tutorial can be tested without any
// deployed service, RPC, Circle account or funded wallet.
export async function runFlow(command, { wallet, config, api, rpc, send, readReceipt, record = () => {}, log = console.log }) {
  if (!['search', 'quote', 'preview', 'trade'].includes(command)) throw new Error('Unknown tutorial command.');
  const search = await api('search', { query: 'cirBTC', limit: 5 });
  log(JSON.stringify({ resolution: search.resolution, results: search.results.map(({ address, symbol, verification, flags }) => ({ address, symbol, verification, flags })) }, null, 2));
  const token = pickToken(search, config.buyToken);
  if (command === 'search') return { search };

  const quote = await api('quote', { sell: USDC, buy: token.address, amount: config.amount, side: 'exactIn', slippageBps: config.slippageBps, taker: wallet.address });
  record({ operation: 'quote', quoteId: quote.quoteId, expiresAt: quote.expiresAt, readiness: quote.readiness, next: quote.next });
  log(JSON.stringify({ quoteId: quote.quoteId, expiresAt: quote.expiresAt, sell: quote.sell.amount,
    amountOutQuoted: quote.best.amountOutQuoted, minAmountOut: quote.best.minAmountOut, safety: quote.safety.verdict,
    readiness: quote.readiness, warnings: quote.warnings, next: quote.next }, null, 2));
  const minOut = reviewQuote(quote, config, wallet);
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
  const txHashes = [];
  for (const tx of swap.transactions) {
    reviewSwap(swap, quote, wallet, config, minOut); // Refuse an expired deadline before each send.
    const hash = await send(tx, randomUUID());
    txHashes.push(hash);
    record({ quoteId: quote.quoteId, purpose: tx.purpose, txHash: hash });
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
  const receiptCommand = `npm run receipt -- ${quote.quoteId} ${txHashes.join(' ')}`;
  log(`Check this trade again for free: ${receiptCommand}`);
  let result;
  try { result = await readReceipt({ quoteId: quote.quoteId, txHashes }); }
  catch (error) {
    throw new Error(`The swap already mined and local delivery checks passed. Arcgate receipt lookup failed: ${error.message} Check only the receipt with: ${receiptCommand}. Do not rerun the trade.`, { cause: error });
  }
  log(JSON.stringify({ receipt: result }, null, 2));
  if (result.result !== 'pass') {
    throw new Error(`The swap already mined. Arcgate receipt is ${result.result}: ${result.reason ?? 'inspect the transactions'}; next=${result.next ?? 'stop'}. For pending, wait at least 5 seconds and run ${receiptCommand}. Do not rerun the trade.`);
  }
  if (result.quoteId !== quote.quoteId || getAddress(result.token) !== config.buyToken
      || getAddress(result.recipient) !== wallet.address || BigInt(result.minAmountOut) < minOut
      || result.next !== 'done' || BigInt(result.delivered) !== delivered || delivered < BigInt(result.minAmountOut)) {
    throw new Error('Arcgate receipt differs from the locally verified fill. The swap already mined; inspect it and do not rerun the trade.');
  }
  return { quote, swap, delivered, receipts, receipt: result };
}
