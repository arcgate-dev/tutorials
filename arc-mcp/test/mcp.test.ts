import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, getAddress } from 'viem';
import { connect } from './connect.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import {
  captured, capturedOffer, CIRBTC, noNetwork, PAYMENT_META, RECEIPT_META, recoverPayer, USDC, withOffer, withOffers,
} from './support.ts';

globalThis.fetch = noNetwork;

const search = { query: 'cirBTC', limit: 5 };

// The lines about money: the others (progress, tool output) are the tour's own business.
const money = (fake: ReturnType<typeof fakeMcp>) => fake.lines().filter((line) => /^(price|receipt|not charged|not settled):/.test(line));

test('paid call: price line before the paid request, receipt line after', async (t) => {
  const { config, fake, arcgate } = await connect(t);
  const offer = capturedOffer();
  const receipt = captured('trade-search.paid')._meta[RECEIPT_META];
  assert.equal(receipt.success, true);

  const out = await arcgate.call('tradeSearch', search);

  const price = `price: tradeSearch ${offer.amount} base units (${formatUnits(BigInt(offer.amount), 6)} USDC) on ${offer.network} to ${offer.payTo}`;
  const receiptLine = `receipt: tradeSearch tx ${receipt.transaction} on ${receipt.network} payer ${receipt.payer}`;
  assert.deepEqual(money(fake), [price, receiptLine], 'one price line and one receipt line');

  // The order of events on the one timeline: probe, price, paid request, receipt.
  const at = (match: (e: (typeof fake.timeline)[number]) => boolean) => fake.timeline.findIndex(match);
  const probe = at((e) => e.kind === 'request' && e.tool === 'tradeSearch' && !e.paid);
  const priceAt = at((e) => e.kind === 'log' && e.line === price);
  const paidAt = at((e) => e.kind === 'request' && e.tool === 'tradeSearch' && e.paid === true);
  const receiptAt = at((e) => e.kind === 'log' && e.line === receiptLine);
  assert.ok(probe >= 0 && probe < priceAt, 'the price is known once the server has asked');
  assert.ok(priceAt < paidAt, 'the price is printed before the paid request is sent');
  assert.ok(paidAt < receiptAt, 'the receipt is printed after it');

  // What the call returns.
  assert.equal(out.charged, true);
  assert.deepEqual(out.receipt, receipt);
  assert.deepEqual(out.result.content, captured('trade-search.paid').content);
  assert.equal(fake.requests().every((r) => r.url === config.mcpUrl), true, 'every request goes to <API_URL>/mcp');

  // The payment payload is the payer's: its EIP-3009 authorization recovers to config.payer.
  const [paidCall] = fake.paidCalls();
  const payment = paidCall.meta![PAYMENT_META];
  assert.equal(await recoverPayer(payment), config.payer.address);
  assert.notEqual(await recoverPayer(payment), config.agent.address, 'the agent never pays');
  assert.equal(getAddress(payment.payload.authorization.from), config.payer.address);
  assert.equal(getAddress(payment.payload.authorization.to), getAddress(offer.payTo));
  assert.equal(payment.payload.authorization.value, offer.amount);
  assert.equal(payment.accepted.network, offer.network);
});

test('success without a receipt throws payment-may-have-settled; a receipt on another network is refused', async (t) => {
  const paid = captured('trade-search.paid');

  // The captured paid result with its _meta removed: success, but nothing proves a settlement.
  {
    const { fake, arcgate } = await connect(t);
    const { _meta, ...withoutReceipt } = structuredClone(paid);
    assert.ok(_meta, 'the captured result had a receipt to remove');
    fake.set('tradeSearch', 'paid', withoutReceipt);
    await assert.rejects(arcgate.call('tradeSearch', search), /payment may have settled; no receipt/);
    assert.equal(fake.paidCalls().length, 1, 'the payment was sent, so the run says it may have settled');
    assert.equal(money(fake).some((line) => line.startsWith('receipt:')), false);
    assert.equal(arcgate.budget.reserved, 5_000n, 'and its reservation stays');
  }

  // The captured receipt with a different (but valid Arc) network.
  {
    const { fake, arcgate } = await connect(t);
    const wrongNetwork = structuredClone(paid);
    assert.equal(wrongNetwork._meta[RECEIPT_META].network, 'eip155:5042002');
    wrongNetwork._meta[RECEIPT_META].network = 'eip155:5042';
    fake.set('tradeSearch', 'paid', wrongNetwork);
    await assert.rejects(arcgate.call('tradeSearch', search));
    assert.equal(money(fake).some((line) => line.startsWith('receipt:')), false, 'it is not reported as a paid success');
  }

  // A receipt that says the settlement failed is no receipt either.
  {
    const { fake, arcgate } = await connect(t);
    const failed = structuredClone(paid);
    failed._meta[RECEIPT_META].success = false;
    fake.set('tradeSearch', 'paid', failed);
    await assert.rejects(arcgate.call('tradeSearch', search));
    assert.equal(money(fake).some((line) => line.startsWith('receipt:')), false);
  }
});

test('free tools never pay', async (t) => {
  const { fake, arcgate } = await connect(t);

  for (const [tool, file] of [['health', 'health'], ['tradeVenues', 'trade-venues']] as const) {
    const out = await arcgate.call(tool, {});
    assert.deepEqual(out.result.content, captured(file).content, `${tool} returns the captured result`);
    assert.equal(out.charged, false);
    assert.ok(!out.receipt);
  }
  assert.deepEqual(money(fake), [], 'no price line');
  assert.deepEqual(fake.toolCalls().map((c) => [c.tool, c.paid]), [['health', false], ['tradeVenues', false]]);
  assert.equal(fake.toolCalls().some((c) => c.meta?.[PAYMENT_META]), false, 'no _meta payment');

  // A free tool that answers payment-required is not paid: here health answers with tradeSearch's offer.
  fake.set('health', 'unpaid', captured('trade-search.payment-required'));
  await assert.rejects(arcgate.call('health', {}));
  assert.equal(fake.paidCalls().length, 0, 'refused without signing');
  assert.deepEqual(money(fake), []);
  assert.equal(arcgate.budget.reserved, 0n);
});

test('an offer on another network never reaches signing', async (t) => {
  const { fake, arcgate } = await connect(t);
  fake.set('tradeSearch', 'unpaid', withOffer('trade-search.payment-required', { network: 'eip155:8453' }));
  await assert.rejects(arcgate.call('tradeSearch', search));
  assert.equal(fake.toolCalls().length, 1, 'the unpaid probe was answered');
  assert.equal(fake.paidCalls().length, 0, 'no paid request is sent');
  assert.deepEqual(money(fake), []);
  assert.equal(arcgate.budget.reserved, 0n);
});

test('an offer with another asset, scheme, timeout or amount never reaches signing', async (t) => {
  const cap = testConfig().maxPerCall;
  for (const patch of [
    { asset: CIRBTC },
    { scheme: 'upto' },
    { maxTimeoutSeconds: 3600 },
    { amount: String(cap + 1n) },
    { amount: '0' },
  ]) {
    const { fake, arcgate } = await connect(t);
    fake.set('tradeSearch', 'unpaid', withOffer('trade-search.payment-required', patch));
    await assert.rejects(arcgate.call('tradeSearch', search), Error, JSON.stringify(patch));
    assert.equal(fake.paidCalls().length, 0, JSON.stringify(patch));
    assert.deepEqual(money(fake), [], JSON.stringify(patch));
    assert.equal(arcgate.budget.reserved, 0n, JSON.stringify(patch));
  }
});

test('the budget counts the offer that gets signed, chosen by the same selectOffer as the policy', async (t) => {
  const { config, fake, arcgate } = await connect(t);
  const good = capturedOffer();
  const overCap = { ...good, amount: String(config.maxPerCall + 1n) };
  const mainnet = { ...good, network: 'eip155:5042', amount: '4000' };
  // The first offer is over the cap: the one signed is the first acceptable one, and it is what is reserved and priced.
  fake.set('tradeSearch', 'unpaid', withOffers('trade-search.payment-required', [overCap, mainnet, good]));
  const settled = structuredClone(captured('trade-search.paid'));
  settled._meta[RECEIPT_META].network = 'eip155:5042';
  fake.set('tradeSearch', 'paid', settled);

  await arcgate.call('tradeSearch', search);

  const [paidCall] = fake.paidCalls();
  const payment = paidCall.meta![PAYMENT_META];
  assert.equal(payment.accepted.network, 'eip155:5042');
  assert.equal(payment.accepted.amount, '4000');
  assert.equal(payment.payload.authorization.value, '4000');
  assert.equal(await recoverPayer(payment, 5042), config.payer.address);
  assert.equal(arcgate.budget.reserved, 4_000n, 'the budget holds exactly what was signed');
  assert.equal(money(fake)[0], `price: tradeSearch 4000 base units (0.004 USDC) on eip155:5042 to ${mainnet.payTo}`);
});

test('an error result after payment is not charged', async (t) => {
  const { config, fake, arcgate } = await connect(t);
  const exists = captured('box-create.exists');
  assert.equal(exists.isError, true);
  fake.set('boxCreate', 'paid', exists);

  const out = await arcgate.call('boxCreate', { address: config.agent.address });

  assert.equal(out.charged, false);
  assert.ok(!out.receipt);
  assert.equal(fake.paidCalls().length, 1, 'the payment was signed and sent; the server refused the call');
  const lines = money(fake);
  assert.equal(lines.length, 2, 'a price line and the not-charged line, no receipt');
  assert.match(lines[0], /^price: boxCreate 50000 base units \(0\.05 USDC\) on eip155:5042002 to /);
  assert.equal(lines[1], 'not charged: boxCreate box_exists');
  assert.equal(arcgate.budget.reserved, 50_000n, 'and the reservation is not released');
});

test('a settlement failure after payment is not settled, and the reservation stays', async (t) => {
  const { fake, arcgate } = await connect(t);
  const offer = capturedOffer();
  // @x402/mcp answers a failed settlement with a payment-required result whose error is a plain string.
  fake.set('tradeSearch', 'paid', captured('trade-search.payment-required'));

  const out = await arcgate.call('tradeSearch', search);

  assert.equal(out.charged, false);
  assert.deepEqual(money(fake), [
    `price: tradeSearch ${offer.amount} base units (${formatUnits(BigInt(offer.amount), 6)} USDC) on ${offer.network} to ${offer.payTo}`,
    'not settled: tradeSearch payment_required (check the balance before running again)',
  ]);
  assert.equal(arcgate.budget.reserved, 5_000n, 'and the reservation is not released');
});
