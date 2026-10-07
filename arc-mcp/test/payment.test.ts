import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptOffer, createBudget, selectOffer } from '../src/payment.ts';
import { connect } from './connect.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, capturedOffer, CIRBTC, noNetwork, USDC } from './support.ts';

globalThis.fetch = noNetwork;

const search = { query: 'cirBTC', limit: 5 };
const quote = { sell: USDC, buy: CIRBTC, amount: '1' };

test('a payment above the per-call cap is refused before signing', async (t) => {
  const offer = capturedOffer(); // tradeSearch: 5000 base units
  assert.equal(offer.amount, '5000');
  const config = { ...testConfig(), maxPerCall: BigInt(offer.amount) - 1n };
  const fake = fakeMcp();
  const { arcgate } = await connect(t, config, fake);

  await assert.rejects(arcgate.call('tradeSearch', search));

  // The refusal came after the server asked for payment, and before anything was signed or sent.
  const calls = fake.toolCalls();
  assert.equal(calls.length, 1, 'only the unpaid probe reached the server');
  assert.equal(calls[0].tool, 'tradeSearch');
  assert.equal(fake.paidCalls().length, 0, 'no tools/call carries _meta["x402/payment"]');
  assert.equal(arcgate.budget.reserved, 0n, 'a refused payment reserves nothing');
  assert.deepEqual(fake.lines().filter((line) => line.startsWith('price:')), [], 'no price is announced for a payment that will not be made');
});

test('the per-run cap counts every signed payment and is never released', async (t) => {
  const config = { ...testConfig(), maxPerRun: 70_000n };
  const exists = captured('box-create.exists'); // the captured 409 box_exists result: charged=false

  // 5000 + 10000 + 50000 is 65000 signed. A second boxCreate would reach 115000: refused before signing.
  {
    const fake = fakeMcp();
    const { arcgate } = await connect(t, config, fake);
    await arcgate.call('tradeSearch', search);
    await arcgate.call('tradeQuote', quote);
    await arcgate.call('boxCreate', { address: config.agent.address });
    assert.equal(arcgate.budget.reserved, 65_000n);
    assert.equal(fake.paidCalls().length, 3);

    fake.set('boxCreate', 'paid', exists);
    await assert.rejects(arcgate.call('boxCreate', { address: config.agent.address }));
    assert.equal(fake.paidCalls().length, 3, 'the refused payment was never sent');
    assert.equal(arcgate.budget.reserved, 65_000n);
  }

  // A payment answered with a not-charged error keeps its reservation: the signed authorization
  // is out and could still settle, so the run never frees it.
  {
    const fake = fakeMcp();
    fake.set('boxCreate', 'paid', exists);
    const { arcgate } = await connect(t, config, fake);
    const answered = await arcgate.call('boxCreate', { address: config.agent.address });
    assert.equal(answered.charged, false);
    assert.equal(arcgate.budget.reserved, 50_000n, 'box_exists was not charged, and the 50000 stays reserved');

    await arcgate.call('tradeQuote', quote);
    await arcgate.call('tradeSearch', search);
    assert.equal(arcgate.budget.reserved, 65_000n);
    assert.equal(fake.paidCalls().length, 3);

    // Another tradeQuote would reach 75000. Had box_exists released its 50000 it would be allowed.
    await assert.rejects(arcgate.call('tradeQuote', quote));
    assert.equal(fake.paidCalls().length, 3, 'refused before any paid request was sent');
    assert.equal(arcgate.budget.reserved, 65_000n);

    // The cap is exact: 65000 + 5000 is 70000, which fits.
    await arcgate.call('tradeSearch', search);
    assert.equal(arcgate.budget.reserved, 70_000n);
    await assert.rejects(arcgate.call('tradeSearch', search));
    assert.equal(fake.paidCalls().length, 4);
  }
});

test('createBudget reserves up to the per-run cap and refuses the reservation that would pass it', () => {
  const budget = createBudget({ ...testConfig(), maxPerRun: 70_000n });
  assert.equal(budget.reserved, 0n);
  budget.reserve(5_000n);
  budget.reserve(65_000n);
  assert.equal(budget.reserved, 70_000n, 'reaching the cap exactly is allowed');
  assert.throws(() => budget.reserve(1n));
  assert.equal(budget.reserved, 70_000n, 'a refused reservation changes nothing');
});

test('acceptOffer takes both Arc networks and refuses other networks, assets, schemes, timeouts and zero/over-cap amounts', () => {
  const config = { ...testConfig(), maxPerCall: 5_000n };
  const offer = capturedOffer();
  const variant = (patch: Record<string, unknown>) => ({ ...offer, ...patch });

  assert.equal(acceptOffer(offer, config), true, 'the captured Arc testnet offer');
  assert.equal(acceptOffer(variant({ network: 'eip155:5042' }), config), true, 'Arc mainnet');
  assert.equal(acceptOffer(variant({ amount: '1' }), config), true);
  assert.equal(acceptOffer(variant({ amount: '5000' }), config), true, 'the cap itself');
  assert.equal(acceptOffer(variant({ maxTimeoutSeconds: 1 }), config), true);
  assert.equal(acceptOffer(variant({ maxTimeoutSeconds: 300 }), config), true);

  const refused: Record<string, Record<string, unknown>> = {
    'Ethereum mainnet': { network: 'eip155:1' },
    'Base': { network: 'eip155:8453' },
    'a non-CAIP network': { network: 'arc' },
    'another asset': { asset: CIRBTC },
    'no asset': { asset: undefined },
    'another scheme': { scheme: 'upto' },
    'a zero amount': { amount: '0' },
    'an amount over the cap': { amount: '5001' },
    'a decimal amount': { amount: '1.5' },
    'a negative amount': { amount: '-5' },
    'a non-numeric amount': { amount: 'five' },
    'no amount': { amount: undefined },
    'a zero timeout': { maxTimeoutSeconds: 0 },
    'a timeout over 300 s': { maxTimeoutSeconds: 301 },
    'a fractional timeout': { maxTimeoutSeconds: 1.5 },
    'no timeout': { maxTimeoutSeconds: undefined },
    'another token name': { extra: { name: 'USD Coin', version: '2' } },
    'another token version': { extra: { name: 'USDC', version: '1' } },
    'no token domain': { extra: undefined },
  };
  for (const [what, patch] of Object.entries(refused)) {
    assert.equal(acceptOffer(variant(patch), config), false, what);
  }
});

test('selectOffer is the first accepted offer, and none when nothing is accepted', () => {
  const config = testConfig();
  const good = capturedOffer();
  const overCap = { ...good, amount: String(config.maxPerCall + 1n) };
  const otherNetwork = { ...good, network: 'eip155:8453' };
  const mainnet = { ...good, network: 'eip155:5042', amount: '4000' };

  assert.deepEqual(selectOffer([otherNetwork, overCap, good, mainnet], config), good);
  assert.deepEqual(selectOffer([otherNetwork, overCap, mainnet, good], config), mainnet);
  assert.ok(selectOffer([otherNetwork, overCap], config) == null);
  assert.ok(selectOffer([], config) == null);
});
