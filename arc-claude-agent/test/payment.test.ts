import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSignature } from '../src/agent.ts';
import { connectArcgate } from '../src/mcp.ts';
import { acceptOffer, createBudget, selectOffer } from '../src/payment.ts';
import { connect } from './connect.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { capturedOffer, noNetwork, OWNER_REQUESTS, PAYMENT_META, recoverPayer, REQUEST_SCREEN, RECEIPT_META, captured, withOffer } from './support.ts';

globalThis.fetch = noNetwork;

const WATCH = 'watch-create.payment-required';
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';

test('the captured prices are the ones the caps are set against', () => {
  assert.equal(capturedOffer('box-create.payment-required').amount, '50000');
  assert.equal(capturedOffer(WATCH).amount, '10000');
  assert.equal(capturedOffer('inbound-create.payment-required').amount, '10000');
});

test('a payment above the per-call cap is refused before signing', async (t) => {
  const offer = capturedOffer(WATCH);
  const config = { ...testConfig(), maxPerCall: BigInt(offer.amount) - 1n };
  const fake = fakeMcp();
  const { arcgate } = await connect(t, config, fake);

  await assert.rejects(arcgate.call('watchCreate', { address: config.account.address, condition: REQUEST_SCREEN }));

  // The refusal came after the server asked for payment, and before anything was signed or sent.
  const calls = fake.toolCalls();
  assert.equal(calls.length, 1, 'only the unpaid probe reached the server');
  assert.equal(calls[0].tool, 'watchCreate');
  assert.equal(fake.paidCalls().length, 0, 'no tools/call carries _meta["x402/payment"]');
  assert.equal(arcgate.budget.reserved, 0n, 'a refused payment reserves nothing');
  assert.deepEqual(fake.lines().filter((line) => line.startsWith('price:')), [], 'no price is announced for a payment that will not be made');
});

test('an off-policy offer is never signed: network, asset, scheme, timeout, amount', async (t) => {
  const offer = capturedOffer(WATCH);
  const cases: Record<string, Record<string, unknown>> = {
    'Ethereum mainnet': { network: 'eip155:1' },
    'Base': { network: 'eip155:8453' },
    'another asset': { asset: CIRBTC },
    'another scheme': { scheme: 'upto' },
    'a timeout over 300 s': { maxTimeoutSeconds: 301 },
    'a zero timeout': { maxTimeoutSeconds: 0 },
    'an amount over the per-call cap': { amount: '50001' },
    'a zero amount': { amount: '0' },
    'a decimal amount': { amount: '0.5' },
  };
  assert.equal(offer.network, 'eip155:5042', 'the captured offer itself is on Arc mainnet');
  for (const [what, patch] of Object.entries(cases)) {
    const config = testConfig();
    const fake = fakeMcp();
    fake.set('watchCreate', 'unpaid', withOffer(WATCH, patch));
    const { arcgate } = await connect(t, config, fake);
    // Refused with an error, or (an offer the x402 client cannot even parse) handed back unpaid: never paid.
    await arcgate.call('watchCreate', { address: config.account.address, condition: REQUEST_SCREEN }).then((out) => assert.equal(out.charged, false, what), () => {});
    assert.equal(fake.paidCalls().length, 0, `${what}: nothing was signed or sent`);
    assert.equal(arcgate.budget.reserved, 0n, `${what}: nothing reserved`);
  }
});

test('the per-run cap is 80000, counts every signed payment and is never released', async (t) => {
  const config = testConfig();
  assert.equal(config.maxPerRun, 80_000n);
  const fake = fakeMcp();
  const { arcgate } = await connect(t, config, fake);
  const address = config.account.address;

  // The box is there, so the paid boxCreate is answered box_exists: not charged, and its 50000 stays reserved.
  const exists = await arcgate.call('boxCreate', { address });
  assert.equal(exists.charged, false);
  assert.equal(arcgate.budget.reserved, 50_000n, 'box_exists was not charged, and the 50000 stays reserved');

  await arcgate.call('watchCreate', { address, condition: REQUEST_SCREEN });
  await arcgate.call('inboundCreate', { address });
  assert.equal(arcgate.budget.reserved, 70_000n);
  assert.equal(fake.paidCalls().length, 3);

  // The cap is exact: 70000 + 10000 is 80000, which fits. Had box_exists released its 50000 the next two would too.
  await arcgate.call('inboundCreate', { address });
  assert.equal(arcgate.budget.reserved, 80_000n);
  await assert.rejects(arcgate.call('watchCreate', { address, condition: REQUEST_SCREEN }));
  await assert.rejects(arcgate.call('inboundCreate', { address }));
  assert.equal(fake.paidCalls().length, 4, 'the refused payments were never sent');
  assert.equal(arcgate.budget.reserved, 80_000n, 'a refused payment changes nothing');
});

test('createBudget reserves up to the per-run cap and refuses the reservation that would pass it', () => {
  const budget = createBudget({ ...testConfig(), maxPerRun: 80_000n });
  assert.equal(budget.reserved, 0n);
  budget.reserve(50_000n);
  budget.reserve(30_000n);
  assert.equal(budget.reserved, 80_000n, 'reaching the cap exactly is allowed');
  assert.throws(() => budget.reserve(1n));
  assert.equal(budget.reserved, 80_000n, 'a refused reservation changes nothing');
});

test('a paid call is announced with its price, signed by the one key and reported with its receipt', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const { arcgate } = await connect(t, config, fake);
  const address = config.account.address;

  const paid = await arcgate.call('watchCreate', { address, condition: REQUEST_SCREEN });
  assert.equal(paid.charged, true);
  const receipt = captured('watch-create.paid')._meta[RECEIPT_META];

  const [call] = fake.paidCalls();
  assert.equal(await recoverPayer(call.meta![PAYMENT_META]), address, 'the payer is the box: watchCreate takes no other payer');
  const lines = fake.lines();
  const price = lines.findIndex((line) => line.startsWith('price: watchCreate 10000 base units (0.01 USDC) on eip155:5042 '));
  const done = lines.findIndex((line) => line.includes('receipt: watchCreate tx') && line.includes(receipt.transaction));
  assert.ok(price >= 0, 'the price line');
  assert.ok(done > price, 'the receipt line, after the price');
});

test('the client pays only for the tools it is given: a watch run is given none', async (t) => {
  const config = testConfig();
  const address = config.account.address;

  // Watch mode: nothing is paid, even when asked.
  {
    const fake = fakeMcp();
    const { arcgate } = await connect(t, config, fake, []);
    for (const tool of ['boxCreate', 'watchCreate', 'inboundCreate']) {
      await assert.rejects(arcgate.call(tool, { address, condition: REQUEST_SCREEN }), tool);
    }
    assert.equal(fake.paidCalls().length, 0);
    assert.equal(arcgate.budget.reserved, 0n);
  }

  // Setup mode: a tool outside the three is not paid either, whatever it asks for.
  {
    const fake = fakeMcp();
    fake.set('boxTopUp', 'unpaid', captured('box-create.payment-required'));
    const { arcgate } = await connect(t, config, fake);
    await assert.rejects(arcgate.call('boxTopUp', { address }), /boxTopUp/);
    assert.equal(fake.paidCalls().length, 0);
    assert.equal(arcgate.budget.reserved, 0n);
  }
});

test('acceptOffer takes both Arc networks and refuses other networks, assets, schemes, timeouts and zero/over-cap amounts', () => {
  const config = { ...testConfig(), maxPerCall: 10_000n };
  const offer = capturedOffer(WATCH);
  const variant = (patch: Record<string, unknown>) => ({ ...offer, ...patch });

  assert.equal(acceptOffer(offer, config), true, 'the captured Arc mainnet offer');
  assert.equal(acceptOffer(variant({ network: 'eip155:5042002' }), config), true, 'Arc testnet');
  assert.equal(acceptOffer(variant({ amount: '1' }), config), true);
  assert.equal(acceptOffer(variant({ amount: '10000' }), config), true, 'the cap itself');
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
    'an amount over the cap': { amount: '10001' },
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
  const good = capturedOffer(WATCH);
  const overCap = { ...good, amount: String(config.maxPerCall + 1n) };
  const otherNetwork = { ...good, network: 'eip155:8453' };
  const cheaper = { ...good, amount: '4000' };

  assert.deepEqual(selectOffer([otherNetwork, overCap, good, cheaper], config), good);
  assert.deepEqual(selectOffer([otherNetwork, overCap, cheaper, good], config), cheaper);
  assert.ok(selectOffer([otherNetwork, overCap], config) == null);
  assert.ok(selectOffer([], config) == null);
});

test('a paid tools/call that gets HTTP 502 may have settled: thrown with that warning, reservation kept, no second paid call', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  // Override: the fake server receives the paid tools/call, and the gateway in front of it answers 502 to the caller.
  const fetchFn: typeof fetch = async (input, init) => {
    const answer = await fake.fetch(input, init);
    const message = init?.body === undefined ? {} : JSON.parse(String(init.body));
    return message.method === 'tools/call' && message.params?._meta?.[PAYMENT_META] !== undefined ? new Response('Bad Gateway', { status: 502 }) : answer;
  };
  const arcgate = await connectArcgate({ config, fetchFn, log: fake.log, paidTools: config.paidTools });
  t.after(() => arcgate.close());

  await assert.rejects(arcgate.call('watchCreate', { address: config.account.address, condition: REQUEST_SCREEN }), (error: Error) => {
    assert.match(error.message, /may have settled/);
    return true;
  });

  assert.equal(arcgate.budget.reserved, 10_000n, 'the reservation is not released');
  assert.equal(fake.paidCalls().length, 1, 'the paid call is not sent again');
});

test('a tools/call that gets HTTP 502 before any payment is signed rethrows the transport error unchanged', async (t) => {
  // Override: the gateway in front of the server answers 502 to the tools/call that `answers502` picks.
  const connectWith502 = async (answers502: (message: any) => boolean) => {
    const config = testConfig();
    const fake = fakeMcp();
    const fetchFn: typeof fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      const message = init?.body === undefined ? {} : JSON.parse(String(init.body));
      return message.method === 'tools/call' && answers502(message) ? new Response('Bad Gateway', { status: 502 }) : answer;
    };
    const arcgate = await connectArcgate({ config, fetchFn, log: fake.log, paidTools: config.paidTools });
    t.after(() => arcgate.close());
    return { config, fake, arcgate };
  };

  // (a) The first tools/call has no payment on it: nothing was signed, so the error is the original one.
  {
    const { config, fake, arcgate } = await connectWith502((message) => message.params?._meta?.[PAYMENT_META] === undefined);
    await assert.rejects(arcgate.call('watchCreate', { address: config.account.address, condition: REQUEST_SCREEN }), (error: Error) => {
      assert.match(error.message, /Bad Gateway/);
      assert.doesNotMatch(error.message, /may have settled/);
      return true;
    });
    assert.equal(arcgate.budget.reserved, 0n, 'nothing was reserved');
    assert.equal(fake.paidCalls().length, 0, 'nothing was signed or sent');
  }

  // (b) A free call after a paid one signed nothing: the earlier payment's offer must not make this 502 look paid.
  {
    let failFree = false;
    const { config, arcgate } = await connectWith502((message) => failFree && message.params?.name === 'boxStatus');
    const address = config.account.address;
    await arcgate.call('watchCreate', { address, condition: REQUEST_SCREEN });
    assert.equal(arcgate.budget.reserved, 10_000n);

    failFree = true;
    await assert.rejects(arcgate.call('boxStatus', { address, agentSignature: await agentSignature(config.account, OWNER_REQUESTS.boxStatus(address)) }), (error: Error) => {
      assert.match(error.message, /Bad Gateway/);
      assert.doesNotMatch(error.message, /may have settled/);
      return true;
    });
    assert.equal(arcgate.budget.reserved, 10_000n, 'the earlier payment stays reserved, and the free call adds nothing');
  }
});
