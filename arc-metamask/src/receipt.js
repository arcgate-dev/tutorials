import { postFree } from './http.js';

// A plain, free HTTP call. Never sign an x402 payment to check a trade's result.
export async function getReceipt({ config, quoteId, txHashes, fetchFn = fetch, record = () => {} }) {
  if (!/^q_[0-9a-f]{16,}$/.test(quoteId ?? '') || !Array.isArray(txHashes)
      || txHashes.length < 1 || txHashes.length > 4
      || txHashes.some(hash => !/^0x[0-9a-fA-F]{64}$/.test(hash))) {
    throw new Error('Use npm run receipt -- <quoteId> <swapTxHash> [approvalTxHash ...] (1 to 4 onchain hashes, not MetaMask polling IDs).');
  }
  const result = await postFree({ config, operation: 'receipt', body: { quoteId, txHashes }, fetchFn, record });
  if (result.quoteId !== quoteId || !['pass', 'fail', 'pending'].includes(result.result)) {
    throw new Error('Unexpected Arcgate receipt. Inspect the onchain transactions before taking further action.');
  }
  record({ operation: 'receipt', ...result });
  return result;
}
