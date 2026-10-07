import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runTour } from '../src/tour.ts';
import { connect } from './connect.ts';
import { fakeMcp, type BoxState, type RequestEvent } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, CIRBTC, fixture, noNetwork, PAYMENT_META, recoverAgent, USDC } from './support.ts';

globalThis.fetch = noNetwork;

async function tour(t: TestContext, arrange: (fake: ReturnType<typeof fakeMcp>) => void = () => {}, box: BoxState = 'absent') {
  const config = testConfig();
  const fake = fakeMcp({ box });
  arrange(fake);
  const { arcgate } = await connect(t, config, fake);
  return { config, fake, arcgate, run: () => runTour({ config, arcgate, log: fake.log }) };
}

test('prints every tools/list name', async (t) => {
  const names: string[] = fixture('tools-list').result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(names.length, 32, 'the captured localnet lists 32 tools');
  const { fake, run } = await tour(t);
  await run();

  // The count first, then one line per tool, in the order the server listed them.
  const lines = fake.lines();
  assert.match(lines[0], new RegExp(`\\b${names.length}\\b`), 'the first line carries the count');
  const printed = lines.slice(1, 1 + names.length).map((line) => line.trim().replace(/^[-*]\s+/, '').split(/[\s:]/)[0]);
  assert.deepEqual(printed, names);
  // And the tools/list request came before any tool was called.
  const requests = fake.requests();
  assert.ok(requests.findIndex((r) => r.method === 'tools/list') < requests.findIndex((r) => r.method === 'tools/call'));
});

// The tour's tools/call requests as `tool` or `tool+paid`, in the order they were sent.
const order = (fake: ReturnType<typeof fakeMcp>) => fake.toolCalls().map((c) => `${c.tool}${c.paid ? '+paid' : ''}`);

// boxStatus is authorised by the agent's signature, not by payment.
async function assertSignedByAgent(status: RequestEvent, config: ReturnType<typeof testConfig>) {
  assert.equal(status.tool, 'boxStatus');
  assert.equal(status.meta?.[PAYMENT_META], undefined, 'no _meta payment');
  assert.equal(status.args!.address, config.agent.address);
  const signed = status.args!.agentSignature;
  assert.deepEqual(Object.keys(signed).sort(), ['expiry', 'nonce', 'signature']);
  assert.equal(await recoverAgent(config.agent.address, signed), config.agent.address, 'the agent key signed it');
  assert.notEqual(await recoverAgent(config.agent.address, signed), config.payer.address, 'not the payer');
}

test('an existing box is the box: no boxCreate is called or paid', async (t) => {
  const { config, fake, run } = await tour(t, () => {}, 'present');
  await run();

  // Free tools, each paid tool probed and paid, then one signed boxStatus, which answers 200.
  assert.deepEqual(order(fake), [
    'health', 'tradeVenues',
    'tradeSearch', 'tradeSearch+paid',
    'tradeQuote', 'tradeQuote+paid',
    'boxStatus',
  ]);
  const calls = fake.toolCalls();
  assert.deepEqual(calls[2].args, { query: 'cirBTC', limit: 5 });
  assert.deepEqual(calls[4].args, { sell: USDC, buy: CIRBTC, amount: '1' });
  await assertSignedByAgent(calls[6], config);

  const lines = fake.lines();
  assert.equal(fake.paidCalls().length, 2, 'search and quote only');
  assert.equal(lines.filter((line) => line.startsWith('receipt:')).length, 2);
  assert.equal(lines.some((line) => /^(price|receipt|not charged): boxCreate/.test(line)), false, 'boxCreate is never priced');
});

test('a fresh agent: box_not_found, then boxCreate is paid once, then a signed boxStatus answers 200', async (t) => {
  const { config, fake, run } = await tour(t);
  await run();

  assert.deepEqual(order(fake), [
    'health', 'tradeVenues',
    'tradeSearch', 'tradeSearch+paid',
    'tradeQuote', 'tradeQuote+paid',
    'boxStatus', // signed: the 404 box_not_found
    'boxCreate', 'boxCreate+paid',
    'boxStatus', // signed: the box exists now
  ]);
  const calls = fake.toolCalls();
  assert.deepEqual(calls[7].args, { address: config.agent.address });
  await assertSignedByAgent(calls[6], config);
  await assertSignedByAgent(calls[9], config);
  assert.notDeepEqual(calls[6].args!.agentSignature, calls[9].args!.agentSignature, 'each signed call has its own nonce');

  assert.equal(fake.paidCalls().length, 3, 'one paid request per paid tool: the tour never retries');
  const receipts = fake.lines().filter((line) => line.startsWith('receipt:'));
  assert.equal(receipts.length, 3, 'three receipts');
  assert.deepEqual(receipts.map((line) => line.split(' ')[1]), ['tradeSearch', 'tradeQuote', 'boxCreate']);
  assert.equal(fake.lines().some((line) => line.startsWith('not charged:')), false);
});

test('box_exists is not charged and the tour goes on to boxStatus', async (t) => {
  const { config, fake, run } = await tour(t, (f) => f.set('boxCreate', 'paid', captured('box-create.exists')));
  await run();

  const lines = fake.lines();
  assert.ok(lines.includes('not charged: boxCreate box_exists'), 'the not-charged line');
  assert.equal(lines.some((line) => line.startsWith('receipt: boxCreate')), false, 'and no receipt for it');
  assert.equal(lines.filter((line) => line.startsWith('receipt:')).length, 2, 'search and quote settled');

  assert.deepEqual(order(fake), [
    'health', 'tradeVenues',
    'tradeSearch', 'tradeSearch+paid',
    'tradeQuote', 'tradeQuote+paid',
    'boxStatus',
    'boxCreate', 'boxCreate+paid',
    'boxStatus',
  ]);
  const calls = fake.toolCalls();
  assert.deepEqual(calls[7].args, { address: config.agent.address });
  const boxCreatePaid = fake.timeline.findIndex((e) => e.kind === 'request' && e.tool === 'boxCreate' && e.paid);
  const lastStatus = fake.timeline.findLastIndex((e) => e.kind === 'request' && e.tool === 'boxStatus');
  const notCharged = fake.timeline.findIndex((e) => e.kind === 'log' && e.line === 'not charged: boxCreate box_exists');
  assert.ok(boxCreatePaid < notCharged && notCharged < lastStatus, 'boxStatus follows the box_exists answer');
  await assertSignedByAgent(calls[9], config);

  assert.equal(fake.paidCalls().length, 3, 'the payment for box_exists was signed once and the tour never retries');
});

test('a boxStatus refusal other than box_not_found stops the tour before any boxCreate', async (t) => {
  // The 401 the server answers boxStatus with when it is unsigned, here as the answer to the signed call.
  const refusal = captured('box-status.signature-required');
  assert.equal(refusal.isError, true);
  assert.notEqual(refusal.structuredContent.error.code, 'box_not_found');
  const { fake, run } = await tour(t, (f) => f.set('boxStatus', 'paid', refusal));

  await assert.rejects(run(), (error: Error) => {
    assert.match(error.message, /signature_required/, 'the error code');
    assert.match(error.message, /fix_request/, 'and its next');
    return true;
  });
  assert.equal(fake.toolCalls().some((c) => c.tool === 'boxCreate'), false, 'no boxCreate is called');
  assert.equal(fake.paidCalls().length, 2, 'only search and quote were paid');
  assert.equal(fake.toolCalls().filter((c) => c.tool === 'boxStatus').length, 1);
});

test('a different error result stops the tour', async (t) => {
  // Any captured error result that is not box_exists: here the 401 the server answers boxStatus with when it is unsigned.
  const refusal = captured('box-status.signature-required');
  assert.equal(refusal.isError, true);
  const { fake, run } = await tour(t, (f) => f.set('boxCreate', 'paid', refusal));

  await assert.rejects(run(), (error: Error) => {
    assert.match(error.message, /signature_required/, 'the error code');
    assert.match(error.message, /fix_request/, 'and its next');
    return true;
  });
  // The one boxStatus is the first, signed check that found no box: none follows the boxCreate.
  const calls = fake.toolCalls();
  assert.equal(calls.filter((c) => c.tool === 'boxStatus').length, 1);
  assert.equal(calls.at(-1)!.tool, 'boxCreate');
  assert.equal(calls.at(-1)!.paid, true);
  assert.equal(fake.paidCalls().length, 3, 'and did not pay again');
});
