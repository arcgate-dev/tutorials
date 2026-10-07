import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { buildQueryOptions, runSetup } from '../src/bot.ts';
import { SETUP_PROMPT, WATCH_PROMPT } from '../src/prompts.ts';
import { fakeMcp } from './fake-mcp.ts';
import { fakeQuery, MODEL_COST, type Script } from './fake-query.ts';
import { testConfig } from './test-config.ts';
import { capturedOffer, errorResult, noNetwork, watchConditions } from './support.ts';

globalThis.fetch = noNetwork;

const REQUEST = 'tell me when any token with verified safety passes 50k 24h volume, and give me an address my other bot can post to';
const SETUP_ALLOWED = ['mcp__arcgate__boxCreate', 'mcp__arcgate__inboundCreate', 'mcp__arcgate__watchCreate'];
const WATCH_ALLOWED = ['mcp__arcgate__boxMessageDelete', 'mcp__arcgate__boxMessageList'];

/** Runs `body` with these variables set in process.env, and restores them. */
async function withEnv(vars: Record<string, string>, body: () => void | Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('buildQueryOptions wires only the arcgate tools, in each mode', () => {
  const config = testConfig();
  const server = { type: 'sdk', name: 'arcgate', instance: {} };
  const abortController = new AbortController();

  for (const [mode, allowed, prompt] of [['setup', SETUP_ALLOWED, SETUP_PROMPT], ['watch', WATCH_ALLOWED, WATCH_PROMPT]] as const) {
    const options = buildQueryOptions({ config, mode, server: server as never, abortController });
    assert.equal(options.model, config.model);
    assert.equal(options.systemPrompt, prompt, `${mode}: the mode's prompt`);
    assert.deepEqual(options.tools, [], `${mode}: no built-in tools: no Bash, Read, Write, Edit or web tools`);
    assert.deepEqual([...options.allowedTools!].sort(), allowed, `${mode}: exactly the mode's tools`);
    assert.deepEqual(Object.keys(options.mcpServers!), ['arcgate'], `${mode}: no other MCP server`);
    assert.equal(options.mcpServers!.arcgate, server);
    assert.equal(options.strictMcpConfig, true, `${mode}: no MCP configuration is read from disk`);
    assert.deepEqual(options.settingSources, [], `${mode}: no user, project or local settings`);
    assert.equal(options.permissionMode, 'dontAsk', `${mode}: nothing outside allowedTools is asked about, it is refused`);
    assert.equal(options.maxTurns, config.maxTurns);
    assert.equal(options.maxBudgetUsd, config.maxBudgetUsd);
    assert.ok(options.maxTurns! > 0 && options.maxBudgetUsd! > 0);
    assert.equal(options.abortController, abortController);
  }
});

test('the model\'s process gets the environment without PRIVATE_KEY', async () => {
  const PRIVATE_KEY = generatePrivateKey();
  await withEnv({ PRIVATE_KEY, ANTHROPIC_API_KEY: 'anthropic-key-for-this-test-0123456789' }, () => {
    for (const mode of ['setup', 'watch'] as const) {
      const options = buildQueryOptions({ config: testConfig(), mode, server: {} as never, abortController: new AbortController() });
      assert.ok(options.env, `${mode}: an env is passed`);
      assert.ok(!('PRIVATE_KEY' in options.env), `${mode}: the tools run in this process, so the subprocess never needs the key`);
      assert.ok(!Object.values(options.env).includes(PRIVATE_KEY), 'and the key is under no other name');
      assert.equal(options.env.ANTHROPIC_API_KEY, 'anthropic-key-for-this-test-0123456789', 'the model credentials are kept');
      assert.equal(options.env.PATH, process.env.PATH);
      assert.notEqual(options.env, process.env, 'a copy');
    }
    assert.equal(process.env.PRIVATE_KEY, PRIVATE_KEY, 'this process keeps its key');
  });
});

test('the prompts say what each run does', () => {
  assert.notEqual(SETUP_PROMPT, WATCH_PROMPT);
  for (const word of ['boxCreate', 'watchCreate', 'inboundCreate', 'secret']) assert.match(SETUP_PROMPT, new RegExp(word), `setup: ${word}`);
  for (const word of ['boxMessageList', 'boxMessageDelete', 'untrusted']) assert.match(WATCH_PROMPT, new RegExp(word, 'i'), `watch: ${word}`);
});

/** The script of a model that does what SETUP_PROMPT asks. */
const setupScript: Script = async ({ call }) => {
  await call('boxCreate');
  await call('watchCreate', { condition: watchConditions().different });
  await call('inboundCreate');
  return { result: 'Created your box, a screen on volume and safety, and an inbound address.' };
};

test('runSetup ends with a box, a screen and an inbound address, and prints one spend line', async () => {
  const config = testConfig();
  const fake = fakeMcp();
  const model = fakeQuery(setupScript);
  const exitCode = process.exitCode;

  await withEnv({ PRIVATE_KEY: generatePrivateKey() }, () => runSetup({ request: REQUEST, config, query: model.query as never, fetchFn: fake.fetch, log: fake.log }));

  assert.equal(model.calls.length, 1, 'one query');
  const { prompt, options } = model.calls[0];
  assert.ok(String(prompt).includes(REQUEST), 'the request is the prompt');
  assert.equal(options.systemPrompt, SETUP_PROMPT);
  assert.deepEqual(options.tools, []);
  assert.deepEqual([...options.allowedTools].sort(), SETUP_ALLOWED);
  assert.deepEqual(Object.keys(options.mcpServers), ['arcgate']);
  assert.ok(!('PRIVATE_KEY' in options.env), 'the key never reaches the model\'s process');

  // The box exists, so it is the box and costs nothing; the screen and the inbound address are paid.
  assert.deepEqual(fake.paidCalls().map((call) => call.tool), ['watchCreate', 'inboundCreate']);
  assert.equal(fake.callsOf('boxStatus').length, 1);
  assert.equal(fake.callsOf('boxCreate').length, 0);

  // What the model saw carries no secret: the user got it in the log.
  assert.ok(!JSON.stringify(model.seen).includes(fake.secret), 'the model never sees the secret');
  assert.equal(fake.lines().filter((line) => line.startsWith('inbound address: ') && line.includes(fake.secret)).length, 1);

  const settled = BigInt(capturedOffer('watch-create.payment-required').amount) + BigInt(capturedOffer('inbound-create.payment-required').amount);
  assert.equal(settled, 20_000n);
  const spent = fake.lines().filter((line) => line.startsWith('spent:'));
  assert.deepEqual(spent, [`spent: x402 ${settled} base units (${formatUnits(settled, 6)} USDC) in 2 payments (${settled} reserved under a cap of ${config.maxPerRun}); model $${MODEL_COST} (SDK estimate)`]);
  assert.equal(config.maxPerRun, 80_000n);
  assert.ok(fake.lines().some((line) => line.includes('Created your box')), 'the model\'s final text is printed');
  assert.equal(process.exitCode, exitCode, 'a run within the cap exits cleanly');
});

test('the spend line counts what settled and what was reserved: a box_exists payment is reserved and not charged', async () => {
  const config = testConfig();
  const fake = fakeMcp();
  fake.set('boxStatus', 'signed', errorResult('box_not_found', 'this address has no box'));
  const model = fakeQuery(setupScript);

  await runSetup({ request: REQUEST, config, query: model.query as never, fetchFn: fake.fetch, log: fake.log });

  assert.deepEqual(fake.paidCalls().map((call) => call.tool), ['boxCreate', 'watchCreate', 'inboundCreate']);
  const spent = fake.lines().filter((line) => line.startsWith('spent:'));
  assert.deepEqual(spent, [`spent: x402 20000 base units (0.02 USDC) in 2 payments (70000 reserved under a cap of 80000); model $${MODEL_COST} (SDK estimate)`]);
});

test('a payment past the cap is never signed: the tool returns a cap-stop result, the query is aborted and the run exits non-zero', async () => {
  const config = { ...testConfig(), maxPerRun: 15_000n };
  const fake = fakeMcp();
  let stop: { isError?: boolean; text?: string } | undefined;
  let again: { isError?: boolean } | undefined;
  let abortedAtStop: boolean | undefined;
  const model = fakeQuery(async ({ call, options }) => {
    await call('watchCreate', { condition: watchConditions().different });
    const out = await call('inboundCreate');
    stop = { isError: out.isError, text: out.content[0].text };
    abortedAtStop = options.abortController.signal.aborted;
    again = await call('inboundCreate'); // a model that ignores the stop
    return { result: 'The spend cap stopped the run.', subtype: options.abortController.signal.aborted ? 'error_during_execution' : 'success' };
  });
  const exitCode = process.exitCode;

  try {
    await runSetup({ request: REQUEST, config, query: model.query as never, fetchFn: fake.fetch, log: fake.log });
    assert.equal(process.exitCode, 1, 'non-zero');
  } finally {
    process.exitCode = exitCode;
  }

  assert.equal(stop?.isError, true);
  assert.match(stop?.text ?? '', /spend cap/i);
  assert.equal(abortedAtStop, true, 'the abort controller the query was given is aborted');
  assert.equal(model.calls[0].options.abortController.signal.aborted, true);
  assert.equal(again?.isError, true, 'the budget still refuses');
  assert.deepEqual(fake.paidCalls().map((call) => call.tool), ['watchCreate'], 'the second payment was never signed or sent');
  const spent = fake.lines().filter((line) => line.startsWith('spent:'));
  assert.equal(spent.length, 1);
  assert.match(spent[0], /^spent: x402 10000 base units \(0\.01 USDC\) in 1 payments? \(10000 reserved under a cap of 15000\); model \$0\.0123 \(SDK estimate\)$/);
});
