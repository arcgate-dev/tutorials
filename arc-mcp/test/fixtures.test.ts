// What the captured files must be, whatever recapturing produces: the real run's receipts, and no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, noNetwork, PAYMENT_META, RECEIPT_META } from './support.ts';

globalThis.fetch = noNetwork;

const FILES = [
  'initialize', 'tools-list', 'mcp-get.event-stream', 'health', 'trade-venues',
  'trade-search.payment-required', 'trade-search.paid',
  'trade-quote.payment-required', 'trade-quote.paid',
  'box-status.signature-required', 'box-status.not-found',
  'box-create.payment-required', 'box-create.paid',
  'box-status', 'box-create.exists',
];
const PAID = ['trade-search.paid', 'trade-quote.paid', 'box-create.paid'];

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

test('every fixture is a JSON-RPC 2.0 response', () => {
  assert.equal(FILES.length, 15);
  for (const name of FILES) {
    const body = fixture(name);
    assert.equal(body.jsonrpc, '2.0', name);
    assert.ok(typeof body.id === 'number' || body.id === null, `${name}: id`);
    assert.ok(('result' in body) !== ('error' in body), `${name}: a result or an error, not both`);
  }
});

test('the paid fixtures carry a successful Arc testnet receipt', () => {
  for (const name of PAID) {
    const result = fixture(name).result;
    assert.notEqual(result.isError, true, name);
    const receipt = result._meta?.[RECEIPT_META];
    assert.ok(receipt, `${name}: a receipt in _meta`);
    assert.equal(receipt.success, true, name);
    assert.equal(receipt.network, 'eip155:5042002', name);
    assert.match(receipt.transaction, TX, `${name}: a 32-byte transaction hash`);
    assert.match(receipt.payer, ADDRESS, `${name}: the payer`);
  }
  const transactions = PAID.map((name) => fixture(name).result._meta[RECEIPT_META].transaction);
  assert.equal(new Set(transactions).size, 3, 'three payments, three transactions');
});

test('box-create.exists is the box_exists error and was not charged', () => {
  const result = fixture('box-create.exists').result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'box_exists');
  assert.equal(result._meta?.[RECEIPT_META], undefined, 'no receipt');
});

test('box-status.not-found and box-status are the two answers to a signed boxStatus', () => {
  const notFound = fixture('box-status.not-found').result;
  assert.equal(notFound.isError, true);
  assert.equal(notFound.structuredContent.error.code, 'box_not_found');

  const status = fixture('box-status').result;
  assert.notEqual(status.isError, true);
  assert.match(status.structuredContent.address, /^0x[0-9a-f]{40}$/, 'the box address');
  assert.ok(status.structuredContent.allowance, 'the allowance');
});

test('no fixture holds a key, a payment payload or an agent signature', () => {
  const receiptTransactions = new Set(PAID.map((name) => fixture(name).result._meta[RECEIPT_META].transaction.toLowerCase()));

  // Pool ids are public on-chain identifiers (Uniswap v4 pool ids are 32-byte hex). The search and quote
  // answers carry them in venues[].poolId and hops[].poolId, and a routeId embeds one, so they are allowed.
  const walk = (value: unknown, name: string, poolIds: Set<string>): void => {
    if (Array.isArray(value)) return value.forEach((item) => walk(item, name, poolIds));
    if (typeof value !== 'object' || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key.toLowerCase() === 'poolid' && typeof inner === 'string') poolIds.add(inner.toLowerCase());
      assert.notEqual(key, PAYMENT_META, `${name}: a request payment`);
      assert.notEqual(key.toLowerCase(), 'authorization', `${name}: an EIP-3009 authorization`);
      if (key === 'agentSignature') {
        // tools-list names the argument in a schema; a signed value has a signature of its own.
        assert.notEqual(typeof (inner as { signature?: unknown })?.signature, 'string', `${name}: an agent signature`);
      }
      walk(inner, name, poolIds);
    }
  };

  for (const name of FILES) {
    const raw = text(name);
    const poolIds = new Set<string>();
    walk(JSON.parse(raw), name, poolIds);
    assert.doesNotMatch(raw, /0x[0-9a-fA-F]{128,}/, `${name}: a signature-length hex string`);
    for (const [hash] of raw.matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
      const known = receiptTransactions.has(hash.toLowerCase()) || poolIds.has(hash.toLowerCase());
      assert.ok(known, `${name}: ${hash} is a 32-byte hex string that is neither a receipt transaction nor a poolId`);
    }
    if (name !== 'tools-list') assert.doesNotMatch(raw, /agentSignature/, `${name}: an agent signature`);
  }
});
