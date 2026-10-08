import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { runWatch } from '../src/bot.ts';
import { WATCH_PROMPT } from '../src/prompts.ts';
import { fakeMcp } from './fake-mcp.ts';
import { fakeQuery, type Script } from './fake-query.ts';
import { testConfig } from './test-config.ts';
import { captured, noNetwork, recoverOwnerCall } from './support.ts';

globalThis.fetch = noNetwork;

class Stop extends Error {}

const page = captured('box-message-list').structuredContent;
const seqs: number[] = page.messages.map((m: { seq: number }) => m.seq);

/** A sleep that records how long it was asked to wait, and ends the loop on the `stopAt`th call. */
function sleeping(stopAt: number) {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      if (slept.length === stopAt) throw new Stop();
    },
  };
}

/** The script of a model that does what WATCH_PROMPT asks: read the box, summarise, delete what it summarised. */
const watchScript: Script = async ({ call }) => {
  await call('boxMessageList', {});
  for (const seq of seqs) await call('boxMessageDelete', { seq });
  return { result: 'One message from your other bot: a status note. Deleted it.' };
};

test('an empty page starts no query, and --once does not stop on it', async () => {
  const fake = fakeMcp({ inbox: 'empty' });
  const model = fakeQuery(watchScript);
  const { slept, sleep } = sleeping(3);

  await assert.rejects(runWatch({ config: testConfig(), query: model.query as never, fetchFn: fake.fetch, log: fake.log, once: true, pollMs: 7, sleep }), Stop);

  assert.equal(model.calls.length, 0, 'no query');
  assert.equal(fake.callsOf('boxMessageList').length, 3, 'one poll before each wait');
  assert.deepEqual(slept, [7, 7, 7], 'the poll interval is pollMs');
  assert.equal(fake.paidCalls().length, 0, 'watch mode pays nothing');
});

test('the poll interval is 30 s by default', async () => {
  const fake = fakeMcp({ inbox: 'empty' });
  const { slept, sleep } = sleeping(1);
  await assert.rejects(runWatch({ config: testConfig(), query: fakeQuery(watchScript).query as never, fetchFn: fake.fetch, log: fake.log, sleep }), Stop);
  assert.deepEqual(slept, [30_000]);
});

test('a non-empty page runs one watch query that summarises and deletes the handled message, and --once stops after it', async () => {
  const config = testConfig();
  const fake = fakeMcp();
  const model = fakeQuery(watchScript);
  const { slept, sleep } = sleeping(1);

  await withKey(() => runWatch({ config, query: model.query as never, fetchFn: fake.fetch, log: fake.log, once: true, pollMs: 5, sleep }));

  assert.deepEqual(slept, [], '--once stops after the first handled batch: not even a wait');
  assert.equal(model.calls.length, 1, 'one query');
  const { prompt, options } = model.calls[0];
  assert.ok(String(prompt).length > 0);
  assert.equal(options.systemPrompt, WATCH_PROMPT);
  assert.deepEqual(options.tools, []);
  assert.deepEqual([...options.allowedTools].sort(), ['mcp__arcgate__boxMessageDelete', 'mcp__arcgate__boxMessageList']);
  assert.ok(!('PRIVATE_KEY' in options.env));

  assert.deepEqual(fake.callsOf('boxMessageDelete').map((call) => call.args!.seq), seqs, 'the handled messages are deleted');
  assert.equal(fake.paidCalls().length, 0, 'watch mode pays nothing');
  assert.equal(fake.callsOf('boxMessageList').length, 2, 'the poll, and the model\'s own read');
  for (const call of fake.toolCalls()) assert.equal(await recoverOwnerCall(call), config.account.address, `${call.tool}: signed by the one key`);

  const lines = fake.lines();
  assert.ok(lines.some((line) => line.includes('One message from your other bot')), 'the summary is printed');
  assert.ok(lines.some((line) => /\$0\.0123/.test(line)), 'with the model\'s cost');
});

test('without --once the loop keeps its cursor, waits, and polls again', async () => {
  const fake = fakeMcp();
  const model = fakeQuery(watchScript);
  const { slept, sleep } = sleeping(2);

  await assert.rejects(runWatch({ config: testConfig(), query: model.query as never, fetchFn: fake.fetch, log: fake.log, pollMs: 5, sleep }), Stop);

  assert.equal(model.calls.length, 1, 'the second poll found the box empty and started nothing');
  assert.deepEqual(slept, [5, 5]);
  const lists = fake.callsOf('boxMessageList');
  assert.equal(lists.length, 3, 'poll, the model\'s read, poll');
  assert.equal('cursor' in lists[0].args!, false, 'the first poll reads from the start');
  assert.equal(lists[2].args!.cursor, page.nextCursor, 'the next poll continues after the batch it handled');
});

/** The key is in this process's environment, as it is under npm run watch. */
async function withKey(body: () => Promise<void>) {
  const saved = process.env.PRIVATE_KEY;
  process.env.PRIVATE_KEY = generatePrivateKey();
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = saved;
  }
}
