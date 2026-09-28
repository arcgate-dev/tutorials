import { circleClient, circleCall, loadWallet } from './circle.js';
import { loadConfig, reportError, requireLiveKey } from './config.js';

async function main() {
  requireLiveKey();
  const client = circleClient();
  const config = loadConfig();
  if (process.env.CIRCLE_WALLET_ID) {
    const wallet = await loadWallet(client, process.env.CIRCLE_WALLET_ID, config.blockchain);
    console.log(`Existing wallet: ${wallet.address}. Nothing created.`);
    return;
  }
  const result = await circleCall('createWalletSet', () => client.createWalletSet({ name: 'arc-circle' }));
  const walletSetId = result.data?.walletSet?.id;
  if (!walletSetId) throw new Error('Circle returned no wallet set ID.');
  console.log(`Wallet set: ${walletSetId}`);
  const created = await circleCall('createWallets', () => client.createWallets({
    walletSetId, blockchains: [config.blockchain], accountType: 'EOA', count: 1,
  }));
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id) throw new Error('Circle returned no wallet. Inspect the wallet set in Circle Console before rerunning.');
  console.log(`CIRCLE_WALLET_ID=${wallet.id}`);
  console.log(`Address: ${wallet.address} (${wallet.blockchain}). Paste the wallet ID into .env.`);
  console.log('Fund this address with USDC on Arc mainnet. Leave additional USDC for transaction fees.');
}

main().catch(reportError);
