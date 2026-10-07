import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFixtures } from '../src/capture.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, errorResult, fixture, noNetwork, recoverOwnerCall, REQUEST_SCREEN } from './support.ts';

globalThis.fetch = noNetwork;

// The 14 files `npm run capture` writes, which are test/fixtures/*.json.
const FILES = [
  'initialize', 'tools-list', 'mcp-get.event-stream',
  'box-status',
  'box-create.payment-required', 'box-create.exists',
  'watch-list', 'watch-create.payment-required', 'watch-create.paid',
  'inbound-create.payment-required', 'inbound-create.paid',
  'box-message-list', 'box-message-delete', 'box-message-list.empty',
];

async function scratchDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'arc-claude-agent-capture-'));
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

const read = async (dir: string, name: string) => readFile(join(dir, `${name}.json`), 'utf8');

test('the capture writes all 14 fixtures, each the answer to its own request', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await scratchDir(t);
  const seen = recording(fake);

  await captureFixtures({ config, fetchFn: seen.fetchFn, dir, log: fake.log });

  assert.equal(FILES.length, 14);
  assert.deepEqual((await readdir(dir)).sort(), FILES.map((name) => `${name}.json`).sort(), 'exactly the 14 files');
  for (const name of FILES) {
    const text = await read(dir, name);
    const written = JSON.parse(text);
    const expected = fixture(name);
    assert.equal(written.jsonrpc, '2.0', name);
    if (name === 'mcp-get.event-stream') assert.deepEqual(written.error, expected.error, name);
    else assert.deepEqual(written.result, expected.result, `${name}: the answer to its own request`);
    // Every file is a response body byte for byte, except the one that carries a secret.
    if (name !== 'inbound-create.paid') assert.ok(seen.bodies.includes(text), `${name}: the file is a response body, byte for byte`);
  }
  assert.equal(JSON.parse(await read(dir, 'box-create.exists')).result.structuredContent.error.code, 'box_exists');
  assert.equal(JSON.parse(await read(dir, 'box-message-list.empty')).result.structuredContent.messages.length, 0);
  assert.ok(JSON.parse(await read(dir, 'box-message-list')).result.structuredContent.messages.length > 0);
});

test('the capture redacts every inbound secret, in structuredContent and in the text JSON', async (t) => {
  const fake = fakeMcp();
  const dir = await scratchDir(t);

  await captureFixtures({ config: testConfig(), fetchFn: fake.fetch, dir, log: fake.log });

  const written = JSON.parse(await read(dir, 'inbound-create.paid')).result;
  assert.equal(written.structuredContent.secret, '<redacted>');
  assert.equal(JSON.parse(written.content[0].text).secret, '<redacted>', 'the text JSON is a second copy');
  for (const name of FILES) assert.ok(!(await read(dir, name)).includes(fake.secret), `${name}: the live secret is nowhere in the file`);
  assert.deepEqual(fake.lines().filter((line) => line.includes(fake.secret)), [], 'nor in the capture\'s log');
});

test('the capture pays the three tools in order, posts to the inbound address as a sender, then reads and deletes what arrived', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await scratchDir(t);

  await captureFixtures({ config, fetchFn: fake.fetch, dir, log: fake.log });

  // Each paid tool is an unpaid probe, then the paid call; each owner call is signed.
  const label = (call: { tool?: string; paid?: boolean }) => (call.paid ? `${call.tool}:paid` : call.tool);
  assert.deepEqual(fake.toolCalls().map(label), [
    'boxStatus',
    'boxCreate', 'boxCreate:paid',
    'watchCreate', 'watchCreate:paid',
    'watchList',
    'inboundCreate', 'inboundCreate:paid',
    'boxMessageList', 'boxMessageDelete', 'boxMessageList',
  ]);
  assert.deepEqual(fake.paidCalls().map((call) => call.tool), ['boxCreate', 'watchCreate', 'inboundCreate']);
  for (const call of fake.toolCalls().filter((c) => c.tool === 'boxStatus' || c.tool === 'watchList' || c.tool?.startsWith('boxMessage'))) {
    assert.equal(await recoverOwnerCall(call), config.account.address, `${call.tool}: signed by the one key`);
  }
  assert.ok(fake.lines().includes('not charged: boxCreate box_exists'), 'the box_exists answer is not charged');
  assert.ok(fake.lines().some((line) => line.startsWith('price: watchCreate')));
  assert.ok(fake.lines().some((line) => line.startsWith('receipt: inboundCreate tx')));

  // The capture's screen is not the README request's, so the bot's own run still creates its screen.
  const watch = fake.callsOf('watchCreate').at(-1)!;
  assert.equal(watch.args!.condition.kind, 'screen');
  assert.notDeepEqual(watch.args!.condition, REQUEST_SCREEN);

  // The post is a sender's: the secret in INBOUND-SECRET, no wallet, and a body with an instruction in it.
  const requests = fake.requests();
  const post = requests.findIndex((r) => r.method === 'POST' && !r.url.endsWith('/mcp'));
  assert.ok(post > 0, 'a post to the inbound address');
  assert.equal(requests[post].url, captured('inbound-create.paid').structuredContent.url);
  assert.equal(requests[post].headers!['inbound-secret'], fake.secret);
  assert.match(requests[post].body!, /ignore|instruction|disregard|delete|forward/i, 'an instruction-like note');
  const after = (tool: string) => requests.findIndex((r, i) => i > post && r.tool === tool);
  assert.ok(requests.findLastIndex((r) => r.tool === 'inboundCreate') < post, 'after inboundCreate');
  assert.ok(after('boxMessageList') > post, 'the read is after the post');

  const listed: number[] = captured('box-message-list').structuredContent.messages.map((m: { seq: number }) => m.seq);
  assert.ok(listed.includes(fake.callsOf('boxMessageDelete')[0].args!.seq), 'it deletes a seq the list returned');
});

test('the capture writes nothing and pays nothing when the payer has no box, or boxStatus is refused', async (t) => {
  for (const code of ['box_not_found', 'signature_expired']) {
    const fake = fakeMcp();
    const dir = await scratchDir(t);
    fake.set('boxStatus', 'signed', errorResult(code));

    await assert.rejects(captureFixtures({ config: testConfig(), fetchFn: fake.fetch, dir, log: fake.log }), (error: Error) => {
      assert.match(error.message, /box/i);
      return true;
    }, code);

    assert.equal(fake.paidCalls().length, 0, `${code}: stopped before paying`);
    assert.deepEqual(fake.toolCalls().map((call) => call.tool), ['boxStatus']);
    assert.deepEqual(await readdir(dir), [], `${code}: not one of the 14 files is written`);
  }
});

test('the capture writes all 14 files or none: a refused paid call stops it', async (t) => {
  const refusals: [string, 'watchCreate' | 'inboundCreate' | 'boxCreate', ReturnType<typeof errorResult>][] = [
    ['a refused watchCreate', 'watchCreate', errorResult('watch_limit')],
    ['a refused inboundCreate', 'inboundCreate', errorResult('inbound_address_limit')],
    // The box is there, so the only answer to a paid boxCreate that can be filed as box-create.exists is box_exists.
    ['a boxCreate that is not box_exists', 'boxCreate', captured('watch-create.paid')],
  ];
  for (const [what, tool, result] of refusals) {
    const fake = fakeMcp();
    const dir = await scratchDir(t);
    fake.set(tool, 'paid', result);

    await assert.rejects(captureFixtures({ config: testConfig(), fetchFn: fake.fetch, dir, log: fake.log }), new RegExp(tool), what);

    assert.deepEqual(await readdir(dir), [], `${what}: nothing was written`);
  }
});
