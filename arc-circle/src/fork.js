import { createPublicClient, createTestClient, createWalletClient, custom, http } from 'viem';
import { assertLoopback } from './config.js';

// The only localnet-specific module. It impersonates the Circle wallet's address on
// the arcgate localnet fork (anvil, chain 5042) because Circle cannot sign or
// broadcast for a fork-only router. `request` is injectable for tests; by default
// it is the node at rpcUrl.
async function connect(rpcUrl, request) {
  assertLoopback(rpcUrl, 'ARC_RPC_URL');
  const transport = request ? custom({ request }, { retryCount: 0 }) : http(rpcUrl, { retryCount: 0 });
  const test = createTestClient({ mode: 'anvil', transport, pollingInterval: 250 });
  try { await test.request({ method: 'anvil_nodeInfo' }); }
  catch { throw new Error('ARC_RPC_URL is not an anvil node; refusing to impersonate on it.'); }
  const chainId = await createPublicClient({ transport }).getChainId();
  if (chainId !== 5042) throw new Error(`ARC_RPC_URL is chain ${chainId}, not the Arc mainnet fork (5042); refusing to impersonate on it.`);
  return { test, transport };
}

export async function sendOnFork(rpcUrl, address, tx, request) {
  const { test, transport } = await connect(rpcUrl, request);
  const client = createWalletClient({ account: address, transport });
  await test.impersonateAccount({ address });
  try {
    const hash = await client.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas) });
    await createPublicClient({ transport, pollingInterval: 250 }).waitForTransactionReceipt({ hash, timeout: 60_000 });
    return hash;
  } finally {
    await test.stopImpersonatingAccount({ address });
  }
}

// Give the wallet native USDC (18 decimals) on the fork, then mine the block that records it.
export async function fundOnFork(rpcUrl, address, amount, request) {
  const { test } = await connect(rpcUrl, request);
  await test.setBalance({ address, value: amount });
  await test.mine({ blocks: 1 });
}
