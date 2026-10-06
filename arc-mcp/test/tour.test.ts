import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runTour } from '../src/tour.ts';
import { connect } from './connect.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, CIRBTC, fixture, noNetwork, PAYMENT_META, recoverAgent, USDC } from './support.ts';

globalThis.fetch = noNetwork;

async function tour(t: TestContext, arrange: (fake: ReturnType<typeof fakeMcp>) => void = () => {}) {
  const config = testConfig();
  const fake = fakeMcp();
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

test('box_exists is not charged and the tour reads the box status', async (t) => {
  const { config, fake, run } = await tour(t, (f) => f.set('boxCreate', 'paid', captured('box-create.exists')));
  await run();

  const lines = fake.lines();
  assert.ok(lines.includes('not charged: boxCreate box_exists'), 'the not-charged line');
  assert.equal(lines.some((line) => line.startsWith('receipt: boxCreate')), false, 'and no receipt for it');
  assert.equal(lines.filter((line) => line.startsWith('receipt:')).length, 2, 'search and quote settled');

  // The tour's calls, in order: free tools first, then each paid tool probed and paid, then boxStatus.
  const calls = fake.toolCalls();
  assert.deepEqual(calls.map((c) => `${c.tool}${c.paid ? '+paid' : ''}`), [
    'health', 'tradeVenues',
    'tradeSearch', 'tradeSearch+paid',
    'tradeQuote', 'tradeQuote+paid',
    'boxCreate', 'boxCreate+paid',
    'boxStatus',
  ]);
  assert.deepEqual(calls[2].args, { query: 'cirBTC', limit: 5 });
  assert.deepEqual(calls[4].args, { sell: USDC, buy: CIRBTC, amount: '1' });
  assert.deepEqual(calls[6].args, { address: config.agent.address });
  const boxCreatePaid = fake.timeline.findIndex((e) => e.kind === 'request' && e.tool === 'boxCreate' && e.paid);
  const boxStatus = fake.timeline.findIndex((e) => e.kind === 'request' && e.tool === 'boxStatus');
  assert.ok(boxCreatePaid >= 0 && boxCreatePaid < boxStatus, 'boxStatus follows the box_exists answer');

  // boxStatus is authorised by the agent's signature, not by payment.
  const status = calls[8];
  assert.equal(status.meta?.[PAYMENT_META], undefined, 'no _meta payment');
  assert.equal(status.args!.address, config.agent.address);
  const signed = status.args!.agentSignature;
  assert.deepEqual(Object.keys(signed).sort(), ['expiry', 'nonce', 'signature']);
  assert.equal(await recoverAgent(config.agent.address, signed), config.agent.address, 'the agent key signed it');
  assert.notEqual(await recoverAgent(config.agent.address, signed), config.payer.address);

  // Nothing was paid for the call that was not charged beyond what was signed once.
  assert.equal(fake.paidCalls().length, 3, 'one paid request per paid tool: the tour never retries');
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
  assert.equal(fake.toolCalls().some((c) => c.tool === 'boxStatus'), false, 'the tour did not go on to boxStatus');
  assert.equal(fake.paidCalls().length, 3, 'and did not pay again');
});
