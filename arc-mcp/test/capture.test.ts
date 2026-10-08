import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFixtures } from '../src/capture.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { fixture, noNetwork, PAYMENT_META, RECEIPT_META } from './support.ts';

globalThis.fetch = noNetwork;

// The 15 files `npm run capture` writes, which are test/fixtures/*.json.
const FILES = [
  'initialize', 'tools-list', 'mcp-get.event-stream', 'health', 'trade-venues',
  'trade-search.payment-required', 'trade-search.paid',
  'trade-quote.payment-required', 'trade-quote.paid',
  'box-status.signature-required', 'box-status.not-found',
  'box-create.payment-required', 'box-create.paid',
  'box-status', 'box-create.exists',
];

async function scratchDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'arc-mcp-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The fake's fetch, with every response body kept as received, so a test can say what was recorded byte for byte. */
function recording(fake: ReturnType<typeof fakeMcp>) {
  const bodies: string[] = [];
  return {
    bodies,
    async fetchFn(input: string | URL | Request, init?: RequestInit) {
      const response = await fake.fetch(input, init);
      bodies.push(await response.clone().text());
      return response;
    },
  };
}

test('the capture writes all 15 fixtures from the matching requests', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await scratchDir(t);
  const seen = recording(fake);

  await captureFixtures({ config, fetchFn: seen.fetchFn, dir, log: fake.log });

  assert.deepEqual((await readdir(dir)).sort(), FILES.map((name) => `${name}.json`).sort(), 'exactly the 15 files');
  for (const name of FILES) {
    const text = await readFile(join(dir, `${name}.json`), 'utf8');
    assert.ok(seen.bodies.includes(text), `${name}: the file is a response body, byte for byte`);
    const written = JSON.parse(text);
    const expected = fixture(name);
    assert.equal(written.jsonrpc, '2.0', name);
    if (name === 'mcp-get.event-stream') {
      assert.deepEqual(written.error, expected.error, name);
    } else {
      assert.deepEqual(written.result, expected.result, `${name}: the answer to its own request`);
    }
  }
});

test('box-create.exists comes from a second run that calls boxCreate again', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await scratchDir(t);

  await captureFixtures({ config, fetchFn: fake.fetch, dir, log: fake.log });

  // The tour pays search, quote and boxCreate. The second run is its own connection with its own budget:
  // 65000 are already reserved of the 70000 cap, so a second boxCreate on the first would have been refused.
  assert.equal(config.maxPerRun, 70_000n);
  const calls = fake.toolCalls();
  assert.equal(calls.filter((c) => c.tool === 'boxCreate' && c.paid).length, 2, 'boxCreate is paid in the tour and again in the second run');
  assert.equal(fake.paidCalls().length, 4);
  assert.equal(fake.requests().filter((r) => r.method === 'initialize').length, 2, 'two MCP connections');
  const last = calls.at(-1)!;
  assert.deepEqual([last.tool, last.paid], ['boxCreate', true], 'the second run ends on its paid boxCreate');
  assert.deepEqual(last.args, { address: config.agent.address });

  const exists = JSON.parse(await readFile(join(dir, 'box-create.exists.json'), 'utf8'));
  assert.equal(exists.result.isError, true);
  assert.equal(exists.result.structuredContent.error.code, 'box_exists');
  assert.equal(exists.result._meta?.[RECEIPT_META], undefined, 'no receipt: it was not charged');
  assert.deepEqual(exists.result, fixture('box-create.exists').result);
});

test('an unsigned boxStatus is what box-status.signature-required records', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await scratchDir(t);
  await captureFixtures({ config, fetchFn: fake.fetch, dir, log: fake.log });

  const unsigned = fake.toolCalls().filter((c) => c.tool === 'boxStatus' && c.args!.agentSignature === undefined);
  assert.equal(unsigned.length, 1, 'one boxStatus without agentSignature');
  assert.equal(unsigned[0].meta?.[PAYMENT_META], undefined);
  const written = JSON.parse(await readFile(join(dir, 'box-status.signature-required.json'), 'utf8'));
  assert.equal(written.result.structuredContent.error.code, 'signature_required');
});

test('the capture writes nothing when the agent already has a box', async (t) => {
  const config = testConfig();
  const fake = fakeMcp({ box: 'present' });
  const dir = await scratchDir(t);

  await assert.rejects(captureFixtures({ config, fetchFn: fake.fetch, dir, log: fake.log }), /box/i);

  assert.deepEqual(await readdir(dir), [], 'not one of the 15 files is written');
});
