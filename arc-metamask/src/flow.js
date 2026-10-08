import { erc20Abi, formatUnits, getAddress, parseEventLogs, parseUnits } from 'viem';
import { USDC } from './payment.js';
import { pickToken, reviewPermit, reviewQuote, reviewSwap } from './guards.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runFlow(command, { wallet, config, api, rpc, log = console.log, sleep = pause }) {
  if (!['search', 'quote', 'preview', 'trade'].includes(command)) throw new Error('Unknown tutorial command.');
  const search = await api('search', { query: 'cirBTC', limit: 5 });
  const token = pickToken(search, config);
  log(JSON.stringify({ resolution: search.resolution, token: token.address, symbol: token.symbol }));
  if (command === 'search') return { search };
  // V3 uses ERC-20 USDC input. A native-funded V4 route would skip Permit2.
  const quote = await api('quote', { sell: USDC, buy: token.address, amount: config.amount, side: 'exactIn', venues: ['uniswap_v3'], slippageBps: config.slippageBps });
  const minimum = reviewQuote(quote, config);
  log(JSON.stringify({ quoteId: quote.quoteId, sell: quote.sell.amount, amountOutQuoted: quote.best.amountOutQuoted, minAmountOut: quote.best.minAmountOut, expiresAt: quote.expiresAt }));
  if (command === 'quote') return { quote };
  const balance = await rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  // One paid call remains (the swap); the second maxPayment is a cushion for gas, which Arc charges in USDC.
  if (balance < parseUnits(config.amount, 6) + 2n * config.maxPayment) throw new Error('Fund the wallet for the order, remaining API fees and extra USDC for gas.');
  const request = { quoteId: quote.quoteId, taker: wallet.address, recipient: wallet.address, approval: 'permit2', deadlineSec: 300 };
  const first = await api('swap', request);
  const reviewed = reviewSwap(first, quote, wallet, config, minimum);
  await wallet.decode(first.transactions, reviewed);
  const typedData = first.signatures[0].typedData;
  reviewPermit(typedData, config);
  log(JSON.stringify({ permit: { domain: typedData.domain, primaryType: typedData.primaryType, message: typedData.message } }));
  if (command === 'preview') {
    log('Preview complete. API fees were paid; the Permit2 permit was not signed and no approval or swap was sent.');
    return { quote, first };
  }

  const signature = await wallet.signTypedData(typedData);
  const signed = { typedData, signature };
  const receipts = [];
  const txHashes = [];
  async function send(tx) {
    const hash = await wallet.send(tx);
    txHashes.push(hash);
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted. Stop and inspect the run log.`);
    receipts.push(receipt);
    log(`${tx.purpose}: ${hash}`);
  }
  // Never send the first response's placeholder swap. Only its approval is executable.
  for (const tx of first.transactions.filter(value => value.purpose === 'approve')) {
    reviewSwap(first, quote, wallet, config, minimum);
    await send(tx);
  }
  reviewQuote(quote, config);
  reviewPermit(typedData, config);
  // The free second round. Same quoteId, taker and recipient as the paid call; its schema has no approval field.
  const final = await api('swap/tx', { quoteId: request.quoteId, taker: request.taker, recipient: request.recipient,
    deadlineSec: request.deadlineSec, permit: { message: typedData.message, signature } });
  const finalReview = reviewSwap(final, quote, wallet, config, minimum, signed);
  // An approval that just succeeded should not be requested again by the second round.
  if (final.transactions.some(tx => tx.purpose === 'approve')) throw new Error('Final swap unexpectedly requests another approval. Inspect the existing transaction; do not replay it.');
  await wallet.decode(final.transactions, finalReview);
  const balanceOf = () => rpc.readContract({ address: config.buyToken, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
  const before = await balanceOf();
  for (const tx of final.transactions) {
    reviewSwap(final, quote, wallet, config, minimum, signed);
    await send(tx);
  }
  const delivered = await balanceOf() - before;
  const transfers = receipts.flatMap(receipt => parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }))
    .filter(event => event.address.toLowerCase() === config.buyToken.toLowerCase() && event.args.to.toLowerCase() === wallet.address.toLowerCase())
    .reduce((total, event) => total + event.args.value, 0n);
  if (delivered < minimum || transfers !== delivered) throw new Error('Swap mined, but delivery does not match the original quote floor and Transfer logs. Inspect receipts.');
  log(`Delivered ${formatUnits(delivered, 8)} cirBTC; minimum ${formatUnits(minimum, 8)} cirBTC.`);
  const receiptCommand = `npm run receipt -- ${quote.quoteId} ${txHashes.join(' ')}`;
  log(`Check this trade again for free: ${receiptCommand}`);
  let result;
  try {
    // The chain already mined both transactions; a pending answer only means Arcgate's read lags.
    for (let attempt = 1; ; attempt++) {
      result = await api('receipt', { quoteId: quote.quoteId, txHashes });
      if (result.result !== 'pending' || attempt === 4) break;
      await sleep(6_000);
    }
  } catch (error) {
    throw new Error(`The swap already mined and local delivery checks passed. Arcgate receipt lookup failed: ${error.message} Check only the receipt with: ${receiptCommand}. Do not rerun the trade.`, { cause: error });
  }
  log(JSON.stringify({ receipt: result }, null, 2));
  if (result.result !== 'pass' || result.next !== 'done') {
    throw new Error(`The swap already mined. Arcgate receipt is ${result.result}: ${result.reason ?? 'inspect the transactions'}; next=${result.next ?? 'stop'}. Wait at least 5 seconds and run ${receiptCommand}. Do not rerun the trade.`);
  }
  if (getAddress(result.token) !== config.buyToken || getAddress(result.recipient) !== wallet.address
      || BigInt(result.minAmountOut) < minimum || BigInt(result.delivered) !== delivered) {
    throw new Error('Arcgate receipt differs from the locally verified fill. The swap already mined; inspect it and do not rerun the trade.');
  }
  return { quote, final, receipts, delivered, receipt: result };
}
