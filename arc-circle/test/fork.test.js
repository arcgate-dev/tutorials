import test from 'node:test';
import assert from 'node:assert/strict';
import * as fork from '../src/fork.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const RPC = 'http://127.0.0.1:19845';
// The sender needs only an address, a router address and a hash; none of it touches the config table.
const wallet = { address: '0xA1b2C3d4E5f60718293a4B5c6D7e8F9012345678' };
const hash = `0x${'ab'.repeat(32)}`;
const tx = { purpose: 'swap', to: '0x0eA7461542fE051c013AB0f5860190bC847f3271', data: '0x12345678', value: '1000000000000000000', gas: '500000' };
const receipt = { transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', transactionIndex: '0x0',
  from: wallet.address, to: tx.to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [],
  logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2', contractAddress: null };

// An in-memory EIP-1193 node: no socket is opened and nothing outside this process answers.
function node({ chainId = '0x13b2', anvil = true, failSend = false } = {}) {
  const calls = [];
  const request = async ({ method, params = [] }) => {
    calls.push({ method, params });
    switch (method) {
      case 'anvil_nodeInfo':
        if (!anvil) throw Object.assign(new Error('Method not found'), { code: -32601 });
        return { currentBlockNumber: '0x1', environment: { chainId: 5042 } };
      case 'eth_chainId': return chainId;
      case 'anvil_impersonateAccount': case 'anvil_stopImpersonatingAccount': case 'anvil_setBalance':
      case 'anvil_mine': case 'evm_mine': return null;
      case 'eth_sendTransaction':
        if (failSend) throw Object.assign(new Error('execution reverted'), { code: 3 });
        return hash;
      case 'eth_blockNumber': return '0x1';
      case 'eth_getTransactionByHash': return { hash, blockNumber: '0x1', blockHash: receipt.blockHash, from: wallet.address, to: tx.to, input: tx.data,
        value: '0x0', gas: '0x7a120', nonce: '0x0', transactionIndex: '0x0', type: '0x2', gasPrice: '0x1', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' };
      case 'eth_getTransactionReceipt': return receipt;
      case 'eth_getBlockByNumber': return { number: '0x1', hash: receipt.blockHash, timestamp: '0x1', transactions: [hash] };
      default: throw new Error(`Unexpected RPC method ${method}`);
    }
  };
  const named = method => calls.filter(call => call.method === method);
  return { calls, request, named, methods: () => calls.map(call => call.method) };
}
const lower = value => String(value).toLowerCase();

test('sendOnFork refuses non-loopback, non-anvil and non-5042 nodes before impersonating', async () => {
  for (const [rpcUrl, options, pattern] of [
    ['https://rpc.mainnet.arc.io', {}, /loopback/i],
    ['https://rpc.testnet.arc.io', {}, /loopback/i],
    ['http://127.0.0.1.example.com:19845', {}, /loopback/i],
    ['http://user:pass@127.0.0.1:19845', {}, /loopback|credentials/i],
    [RPC, { anvil: false }, /anvil/i],
    [RPC, { chainId: '0x4ced32' }, /5042/],
    [RPC, { chainId: '0x1' }, /5042/],
  ]) {
    const rpc = node(options);
    await assert.rejects(fork.sendOnFork(rpcUrl, wallet.address, tx, rpc.request), pattern, rpcUrl + JSON.stringify(options));
    assert.deepEqual(rpc.named('anvil_impersonateAccount'), [], rpcUrl);
    assert.deepEqual(rpc.named('eth_sendTransaction'), [], rpcUrl);
    if (/loopback/.test(String(pattern))) assert.equal(rpc.calls.length, 0, 'a non-loopback URL is refused before any request');
  }
});

test('sendOnFork impersonates only the wallet address, sends the transaction and returns the hash', async () => {
  const rpc = node();
  assert.equal(await fork.sendOnFork(RPC, wallet.address, tx, rpc.request), hash);
  const methods = rpc.methods();
  assert.equal(rpc.named('anvil_impersonateAccount').length, 1);
  assert.equal(rpc.named('eth_sendTransaction').length, 1);
  assert.equal(rpc.named('anvil_stopImpersonatingAccount').length, 1);
  assert(methods.indexOf('anvil_nodeInfo') < methods.indexOf('anvil_impersonateAccount'));
  assert(methods.indexOf('anvil_impersonateAccount') < methods.indexOf('eth_sendTransaction'));
  assert(methods.indexOf('eth_sendTransaction') < methods.indexOf('anvil_stopImpersonatingAccount'));
  assert(methods.indexOf('eth_sendTransaction') < methods.indexOf('eth_getTransactionReceipt'), 'it waits for the receipt');
  assert.deepEqual(rpc.named('anvil_impersonateAccount')[0].params.map(lower), [lower(wallet.address)]);
  assert.deepEqual(rpc.named('anvil_stopImpersonatingAccount')[0].params.map(lower), [lower(wallet.address)]);
  const sent = rpc.named('eth_sendTransaction')[0].params[0];
  assert.equal(lower(sent.from), lower(wallet.address));
  assert.equal(lower(sent.to), lower(tx.to));
  assert.equal(sent.data, tx.data);
  assert.equal(BigInt(sent.value), 10n ** 18n);
  assert.equal(BigInt(sent.gas), 500_000n);
});

test('sendOnFork stops impersonating even when the send throws', async () => {
  const rpc = node({ failSend: true });
  await assert.rejects(fork.sendOnFork(RPC, wallet.address, tx, rpc.request), /reverted/);
  assert.equal(rpc.named('anvil_impersonateAccount').length, 1);
  assert.deepEqual(rpc.named('anvil_stopImpersonatingAccount').map(call => call.params.map(lower)), [[lower(wallet.address)]]);
  assert(rpc.methods().indexOf('anvil_stopImpersonatingAccount') > rpc.methods().indexOf('eth_sendTransaction'));
});

test('fundOnFork sets the native balance and mines one block', async () => {
  const rpc = node();
  await fork.fundOnFork(RPC, wallet.address, 10n * 10n ** 18n, rpc.request);
  const methods = rpc.methods();
  assert.equal(rpc.named('anvil_setBalance').length, 1);
  const [address, balance] = rpc.named('anvil_setBalance')[0].params;
  assert.equal(lower(address), lower(wallet.address));
  assert.equal(BigInt(balance), 10n * 10n ** 18n);
  const mined = rpc.calls.filter(call => ['anvil_mine', 'evm_mine'].includes(call.method));
  assert.equal(mined.length, 1);
  if (mined[0].method === 'anvil_mine') assert.equal(BigInt(mined[0].params[0]), 1n);
  assert(methods.indexOf('anvil_setBalance') < methods.indexOf(mined[0].method));
  assert.equal(rpc.named('anvil_impersonateAccount').length, 0);
});

test('fundOnFork refuses a non-loopback RPC before any request', async () => {
  const rpc = node();
  await assert.rejects(fork.fundOnFork('https://rpc.testnet.arc.io', wallet.address, 10n ** 19n, rpc.request), /loopback/i);
  assert.equal(rpc.calls.length, 0);
});
