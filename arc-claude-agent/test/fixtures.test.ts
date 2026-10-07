// What the captured files must be, whatever recapturing produces: the real run's receipts and shapes, and no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, noNetwork, PAYMENT_META, RECEIPT_META } from './support.ts';

globalThis.fetch = noNetwork;

const FILES = [
  'initialize', 'tools-list', 'mcp-get.event-stream',
  'box-status',
  'box-create.payment-required', 'box-create.exists',
  'watch-list', 'watch-create.payment-required', 'watch-create.paid',
  'inbound-create.payment-required', 'inbound-create.paid',
  'box-message-list', 'box-message-delete', 'box-message-list.empty',
];
const PAID = ['watch-create.paid', 'inbound-create.paid'];

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

test('every fixture is a JSON-RPC 2.0 response', () => {
  assert.equal(FILES.length, 14);
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
  assert.equal(new Set(transactions).size, 2, 'two payments, two transactions');
});

test('the payment-required fixtures offer the prices the caps are set against, on Arc testnet in USDC', () => {
  const prices: Record<string, string> = { 'box-create.payment-required': '50000', 'watch-create.payment-required': '10000', 'inbound-create.payment-required': '10000' };
  for (const [name, amount] of Object.entries(prices)) {
    const result = fixture(name).result;
    assert.equal(result.isError, true, name);
    const [offer] = result.structuredContent.accepts;
    assert.equal(offer.amount, amount, name);
    assert.equal(offer.network, 'eip155:5042002', name);
    assert.equal(offer.scheme, 'exact', name);
    assert.equal(offer.asset, '0x3600000000000000000000000000000000000000', name);
  }
});

test('box-create.exists is the box_exists error and was not charged', () => {
  const result = fixture('box-create.exists').result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'box_exists');
  assert.equal(result._meta?.[RECEIPT_META], undefined, 'no receipt');
});

test('the owner-call fixtures are the real shapes the bridge reads', () => {
  const status = fixture('box-status').result;
  assert.notEqual(status.isError, true);
  assert.match(status.structuredContent.address, /^0x[0-9a-f]{40}$/, 'the box address');
  assert.ok(status.structuredContent.allowance, 'the allowance');

  const { watches } = fixture('watch-list').result.structuredContent;
  const created = fixture('watch-create.paid').result.structuredContent;
  assert.ok(created.id && created.condition, 'the new watch: id and condition');
  assert.ok(watches.some((watch: { id: string; condition: { kind: string } }) => watch.id === created.id && watch.condition.kind === 'screen'), 'the list holds the screen the capture made');

  const inbound = fixture('inbound-create.paid').result.structuredContent;
  assert.ok(inbound.id && inbound.url && 'secret' in inbound, 'the inbound address: id, url and a (redacted) secret');

  const list = fixture('box-message-list').result.structuredContent;
  assert.ok(list.messages.length > 0, 'the page holds what the capture posted');
  for (const message of list.messages) {
    assert.equal(message.payload.untrusted, true, `seq ${message.seq}: arcgate labels it untrusted`);
    assert.equal(typeof message.payload.content, 'string');
  }
  assert.ok(list.messages.some((m: { payload: { content: string } }) => /ignore|instruction|disregard|delete|forward/i.test(m.payload.content)), 'a message with an instruction-like note');
  const seqs: number[] = list.messages.map((m: { seq: number }) => m.seq);
  assert.ok(list.nextCursor >= Math.max(...seqs), 'the cursor is past the page');

  const deleted = fixture('box-message-delete').result.structuredContent;
  assert.equal(deleted.deleted, true);
  assert.ok(seqs.includes(deleted.seq), 'it deleted a seq the page held');

  const empty = fixture('box-message-list.empty').result.structuredContent;
  assert.deepEqual(empty.messages, []);
  assert.equal(typeof empty.nextCursor, 'number');

  const names = fixture('tools-list').result.tools.map((tool: { name: string }) => tool.name);
  for (const name of ['boxCreate', 'watchCreate', 'inboundCreate', 'boxMessageList', 'boxMessageDelete', 'boxStatus', 'watchList']) assert.ok(names.includes(name), name);
});

test('no fixture holds a key, a payment payload, an agent signature, an unredacted secret or a keyed RPC URL', () => {
  const receiptTransactions = new Set(PAID.map((name) => fixture(name).result._meta[RECEIPT_META].transaction.toLowerCase()));
  const hosts = /^(127\.0\.0\.1|localhost|json-schema\.org|(.+\.)?arcgate\.dev)$/;

  // A message's idempotencyKey is a public 32-byte hash, and a receipt's transaction is public: both are allowed.
  const walk = (value: unknown, name: string, allowed: Set<string>): void => {
    if (Array.isArray(value)) return value.forEach((item) => walk(item, name, allowed));
    if (typeof value !== 'object' || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'idempotencyKey' && typeof inner === 'string') allowed.add(inner.toLowerCase());
      assert.notEqual(key, PAYMENT_META, `${name}: a request payment`);
      assert.notEqual(key.toLowerCase(), 'authorization', `${name}: an EIP-3009 authorization`);
      if (key === 'secret') assert.equal(inner, '<redacted>', `${name}: an unredacted secret`);
      if (key === 'agentSignature') {
        // tools-list names the argument in a schema; a signed value has a signature of its own.
        assert.notEqual(typeof (inner as { signature?: unknown })?.signature, 'string', `${name}: an agent signature`);
      }
      walk(inner, name, allowed);
    }
  };

  for (const name of FILES) {
    const raw = text(name);
    const allowed = new Set<string>();
    const body = JSON.parse(raw);
    walk(body, name, allowed);
    // The text content is a second copy of structuredContent: it is JSON too, and it must be as clean.
    for (const item of body.result?.content ?? []) {
      if (item.type === 'text') walk(JSON.parse(item.text), `${name} (text)`, allowed);
    }
    assert.doesNotMatch(raw, /0x[0-9a-fA-F]{128,}/, `${name}: a signature-length hex string`);
    for (const [hash] of raw.matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
      const known = receiptTransactions.has(hash.toLowerCase()) || allowed.has(hash.toLowerCase());
      assert.ok(known, `${name}: ${hash} is a 32-byte hex string that is neither a receipt transaction nor a message's idempotencyKey: a private key looks like this`);
    }
    if (name !== 'tools-list') assert.doesNotMatch(raw, /agentSignature/, `${name}: an agent signature`);

    // A URL: no credentials, no query (an RPC key rides in one), and only hosts this tutorial talks to.
    for (const [href] of raw.matchAll(/https?:\/\/[^"\\\s)]+/g)) {
      const url = new URL(href);
      assert.equal(url.username + url.password, '', `${name}: credentials in ${href}`);
      assert.equal(url.search, '', `${name}: a query string in ${href}`);
      assert.match(url.hostname, hosts, `${name}: ${href} is not a host the fixtures name`);
    }
  }
});
