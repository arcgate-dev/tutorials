import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { formatUnits, getAddress, recoverTypedDataAddress } from 'viem';

export function circleClient(env = process.env) {
  if (!env.CIRCLE_API_KEY || !/^[a-fA-F0-9]{64}$/.test(env.CIRCLE_ENTITY_SECRET ?? '')) {
    throw new Error('Set CIRCLE_API_KEY and your registered, 64-character CIRCLE_ENTITY_SECRET in .env.');
  }
  return initiateDeveloperControlledWalletsClient({
    apiKey: env.CIRCLE_API_KEY,
    entitySecret: env.CIRCLE_ENTITY_SECRET,
  });
}

// Keep SDK errors (which can contain HTTP request configuration) out of logs.
export async function circleCall(operation, call) {
  try { return await call(); }
  catch (error) {
    const status = error?.response?.status;
    throw new Error(`Circle ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}. Check the wallet, credentials and Circle Console.`);
  }
}

export async function loadWallet(client, id, blockchain) {
  if (!id) throw new Error('Set CIRCLE_WALLET_ID to your existing Circle wallet ID, or run npm run wallet:create.');
  const { data } = await circleCall('getWallet', () => client.getWallet({ id }));
  const wallet = data?.wallet;
  if (!wallet || wallet.blockchain !== blockchain || wallet.accountType !== 'EOA' || wallet.state !== 'LIVE') {
    throw new Error(`Use an active ${blockchain} developer-controlled EOA wallet. Smart contract wallets and wallets on other networks do not work in this example.`);
  }
  return { id, address: getAddress(wallet.address), blockchain };
}

export function typedDataJson(typedData) {
  const domainFields = [
    ['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
    ['verifyingContract', 'address'], ['salt', 'bytes32'],
  ];
  return JSON.stringify({
    ...typedData,
    types: {
      ...typedData.types,
      EIP712Domain: domainFields.filter(([name]) => name in typedData.domain)
        .map(([name, type]) => ({ name, type })),
    },
  }, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}

export function normalizeSignature(value) {
  const hex = typeof value === 'string' ? value.replace(/^0x/, '') : '';
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error('Circle returned an invalid signature.');
  let v = Number.parseInt(hex.slice(128), 16);
  if (v < 2) v += 27;
  if (v !== 27 && v !== 28) throw new Error('Circle returned an invalid signature recovery ID.');
  return `0x${hex.slice(0, 128)}${v.toString(16)}`;
}

export async function signTypedData(client, wallet, typedData) {
  const result = await circleCall('signTypedData', () => client.signTypedData({
    walletId: wallet.id,
    data: typedDataJson(typedData),
  }));
  const signature = normalizeSignature(result.data?.signature);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (getAddress(recovered) !== wallet.address) throw new Error('Signature does not recover to the Circle wallet.');
  return signature;
}

// Circle signs AND broadcasts on the wallet's blockchain. A transaction ID or hash
// alone is not success. The caller checks the chain receipt after COMPLETE, too.
export async function sendTransaction(client, wallet, tx, idempotencyKey, record = () => {}) {
  record({ purpose: tx.purpose, idempotencyKey, state: 'submitting' });
  let created;
  try { created = await client.createContractExecutionTransaction({
    walletId: wallet.id,
    contractAddress: tx.to,
    callData: tx.data,
    amount: formatUnits(BigInt(tx.value), 18),
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey,
  }); } catch {
    throw new Error(`Circle submission has an uncertain outcome (idempotency key ${idempotencyKey}). Check Circle Console before retrying; it may already have been accepted.`);
  }
  const id = created.data?.id;
  if (!id) throw new Error('Circle returned no transaction ID. Inspect Circle Console before retrying.');
  record({ circleTransactionId: id, purpose: tx.purpose, idempotencyKey });
  let result;
  try {
    result = await client.getTransaction({ id, waitForState: 'COMPLETE', signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error(`Circle transaction ${id} is not confirmed. Inspect it in Circle Console before retrying; it may still execute.`);
  }
  const transaction = result.data?.transaction;
  if (transaction?.state !== 'COMPLETE' || !/^0x[0-9a-fA-F]{64}$/.test(transaction.txHash ?? '')) {
    throw new Error(`Circle transaction ${id} has state ${transaction?.state ?? 'unknown'}, not confirmed success.`);
  }
  record({ circleTransactionId: id, purpose: tx.purpose, txHash: transaction.txHash, state: transaction.state });
  return transaction.txHash;
}
