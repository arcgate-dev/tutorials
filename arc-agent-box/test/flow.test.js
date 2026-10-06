import test from 'node:test';
import assert from 'node:assert/strict';
import * as steps from '../src/steps.js';
import { ALLOWED_NETWORKS, loadConfig } from '../src/config.js';
import { INBOUND_POST, PAID, acceptedOf, apiTrace, clone, createReplay, health, hmacHex, isFree, loadFixture, makeWallet, operationOf, prices, runExchanges } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

// The steps run against the localnet run the tutorial's own capture mode recorded
// (test/fixtures/localnet.json). A replay serves those exchanges in order; the steps are the code
// under test and nothing in them is mocked. The only edits are to copies of captured answers, made
// by a test to put the step in a situation the capture does not hold, and the two fake inbound
// secrets: the capture redacts every secret, so a test needs real ones to tell old from new.

const SECRETS = { old: 'test-inbound-secret-old', next: 'test-inbound-secret-new' };
const STEPS = ['box', 'inbound', 'watch', 'channel', 'messages', 'topup', 'cleanup'];
const ok = status => status >= 200 && status < 300;

let memoWorld;
function world() {
  memoWorld ??= (() => {
    const fixture = loadFixture();
    const webhook = fixture.exchanges.find(e => operationOf(e.method, e.path) === 'webhookCreate' && e.requestBody);
    const config = loadConfig({ API_URL: fixture.apiUrl, ...webhook && { WEBHOOK_URL: webhook.requestBody.url } });
    const network = health(fixture).x402.network;
    return { fixture, config, network, chainId: ALLOWED_NETWORKS[network], price: prices(fixture), wallet: makeWallet(fixture.address).wallet };
  })();
  return memoWorld;
}

function withSecrets(exchanges) {
  return clone(exchanges).map(exchange => {
    const operation = operationOf(exchange.method, exchange.path);
    if (ok(exchange.status) && operation === 'inboundCreate') exchange.body.secret = SECRETS.old;
    if (ok(exchange.status) && operation === 'inboundRotate') exchange.body.secret = SECRETS.next;
    return exchange;
  });
}

function context(w, replay) {
  const clock = { t: Date.now() }, logs = [], records = [], sleeps = [];
  const stringify = value => typeof value === 'string' ? value : JSON.stringify(value);
  const ctx = {
    config: w.config, fetchFn: replay.fetch, wallet: w.wallet,
    rpc: { getChainId: async () => w.chainId, readContract: async () => 1_000_000_000n },
    now: () => clock.t, sleep: async ms => { sleeps.push(ms); clock.t += ms; },
    log: (...args) => logs.push(args.map(stringify).join(' ')), record: entry => records.push(entry),
  };
  return { ctx, logs, records, sleeps };
}

// Every step in order against one replay, so each step's requests and answers are known. A step that
// fails (or never ran because an earlier one failed) makes only its own tests fail: reading its result throws.
let memoStepwise;
function stepwise() {
  memoStepwise ??= (async () => {
    const w = world();
    const replay = createReplay(w.fixture, { queue: withSecrets(w.fixture.exchanges) });
    const c = context(w, replay);
    const out = {};
    let failed = null;
    for (const name of STEPS) {
      if (failed) {
        const message = `step ${name} did not run: step ${failed.name} failed first (${failed.error.message})`;
        Object.defineProperty(out, name, { get() { throw new Error(message); } });
        continue;
      }
      const from = { consumed: replay.consumed.length, trace: replay.trace.length, logs: c.logs.length, sleeps: c.sleeps.length };
      try {
        await steps[name](c.ctx);
        out[name] = { exchanges: replay.consumed.slice(from.consumed), trace: apiTrace(replay.trace.slice(from.trace)), logs: c.logs.slice(from.logs), sleeps: c.sleeps.slice(from.sleeps) };
      } catch (error) {
        failed = { name, error };
        Object.defineProperty(out, name, { get() { throw error; } });
      }
    }
    return { w, out, replay, failed, ...c };
  })();
  return memoStepwise;
}

// `start`: all seven steps, then the final check.
let memoStart;
function startRun() {
  memoStart ??= (async () => {
    const w = world();
    const replay = createReplay(w.fixture, { queue: withSecrets(w.fixture.exchanges) });
    const c = context(w, replay);
    await steps.start(c.ctx);
    return { w, replay, ...c };
  })();
  return memoStart;
}

async function runStep(name, queue, { pool = [], limit = 500 } = {}) {
  const w = world();
  const replay = createReplay(w.fixture, { queue, pool, limit });
  const c = context(w, replay);
  const error = await steps[name](c.ctx).then(() => null, failure => failure);
  return { w, replay, error, trace: apiTrace(replay.trace), ...c };
}

const ops = trace => trace.map(entry => entry.operation);
const ofOp = (trace, operation) => trace.filter(entry => entry.operation === operation);
const paid = trace => trace.filter(entry => entry.headers['payment-signature']);
const signed = entry => entry.headers['agent-signature'] !== undefined;
const REPLAY = ['REPLAY_LIMIT', 'REPLAY_UNEXPECTED', 'REPLAY_MISMATCH', 'REPLAY_BODY'];
const ownFailure = error => !REPLAY.includes(error?.code);
const operationOfExchange = exchange => operationOf(exchange.method, exchange.path);
const params = entry => new URL(`http://x${entry.path}`).searchParams;
const lastSegment = entry => entry.path.split('?')[0].split('/').at(-1);
const messagesIn = trace => ofOp(trace, 'boxMessageList').flatMap(entry => entry.response.messages);

// box -------------------------------------------------------------------------------------------

test('box: boxStatus first; a missing box is created by one paid boxCreate and the status is read again', async () => {
  const { w, out } = await stepwise();
  const t = out.box.trace;
  assert.deepEqual(ops(t), ['boxStatus', 'boxCreate', 'boxCreate', 'boxStatus']);
  assert.equal(t[0].status, 404);
  assert.equal(t[0].response.error.code, 'box_not_found');
  assert.equal(t[1].status, 402);
  assert.ok(ok(t[2].status));
  assert.equal(t[3].status, 200);
  assert.deepEqual(paid(t), [t[2]], 'only the second boxCreate request carries a payment');
  assert.equal(acceptedOf(t[2]).accepted.amount, w.price.boxCreate);
  assert.ok(signed(t[0]) && signed(t[3]), 'the status reads are signed by the wallet');
  assert.ok(!signed(t[1]) && !signed(t[2]), 'a paid create is authenticated by its payment');
  assert.equal(t[3].response.address.toLowerCase(), w.fixture.address.toLowerCase());
});

test('box: an existing box is reported, with no payment signed', async () => {
  const { out } = await stepwise();
  const existing = out.box.exchanges.at(-1);
  assert.equal(operationOfExchange(existing), 'boxStatus');
  assert.equal(existing.status, 200);
  const run = await runStep('box', [existing]);
  assert.equal(run.error, null);
  assert.deepEqual(ops(run.trace), ['boxStatus']);
  assert.equal(paid(run.trace).length, 0);
  assert.match(run.logs.join('\n'), /exist/i);
});

// inbound ---------------------------------------------------------------------------------------

function authenticates(entry, secret) {
  return entry.headers['inbound-signature'] !== undefined
    ? entry.headers['inbound-signature'] === hmacHex(secret, entry.headers['inbound-timestamp'], entry.body)
    : entry.headers['inbound-secret'] === secret;
}

test('inbound: create (paid), post with the secret (201), rotate, the old secret is refused (401 inbound_unauthorized), the new one accepted (201)', async () => {
  const { w, out } = await stepwise();
  const t = out.inbound.trace;
  assert.deepEqual(ops(t), ['inboundCreate', 'inboundCreate', 'inboundPost', 'inboundRotate', 'inboundPost', 'inboundPost']);
  assert.equal(t[0].status, 402);
  assert.ok(ok(t[1].status));
  assert.deepEqual(paid(t), [t[1]]);
  assert.equal(acceptedOf(t[1]).accepted.amount, w.price.inboundCreate);
  assert.ok(signed(t[3]) && !paid(t).includes(t[3]), 'the rotate is a signed owner call');

  const created = t[1].response, [first, refused, accepted] = ofOp(t, 'inboundPost');
  assert.equal(created.secret, SECRETS.old);
  assert.equal(t[3].response.secret, SECRETS.next);
  for (const post of [first, refused, accepted]) {
    assert.equal(post.path, new URL(created.url).pathname, 'a post goes to the address the create returned');
    assert.equal(post.origin, new URL(created.url).origin);
    assert.equal(post.headers['content-type'], 'application/json');
    assert.equal(post.headers['content-encoding'], undefined);
    assert.doesNotThrow(() => JSON.parse(post.body));
    assert.equal(post.redirect, 'error');
  }

  assert.equal(first.status, 201);
  assert.ok(authenticates(first, SECRETS.old) && !authenticates(first, SECRETS.next));
  assert.equal(refused.status, 401);
  assert.equal(refused.response.error.code, 'inbound_unauthorized');
  assert.ok(authenticates(refused, SECRETS.old) && !authenticates(refused, SECRETS.next), 'the refused post uses the old secret');
  assert.equal(accepted.status, 201);
  assert.ok(authenticates(accepted, SECRETS.next) && !authenticates(accepted, SECRETS.old), 'the accepted post uses the new secret');

  const modes = [first, refused, accepted].map(post => post.headers['inbound-signature'] !== undefined ? 'signature' : 'secret');
  assert.ok(modes.includes('signature') && modes.includes('secret'), 'both ways of authenticating are shown');
  for (const post of [first, refused, accepted]) {
    if (post.headers['inbound-signature'] === undefined) continue;
    assert.match(post.headers['inbound-signature'], /^[0-9a-f]{64}$/);
    assert.ok(Math.abs(Number(post.headers['inbound-timestamp']) - Date.now() / 1000) < 600);
    assert.equal(post.headers['inbound-secret'], undefined);
  }
  assert.notEqual(first.body, accepted.body, 'every post is a new message: an identical body would be answered 200 duplicate');
  const captured = out.inbound.exchanges.find(e => operationOfExchange(e) === 'inboundPost');
  assert.notDeepEqual(JSON.parse(first.body), captured.requestBody, 'a rerun posts a body of its own');
});

test('inbound: anything but 401 for the old secret fails the step', async () => {
  const { out } = await stepwise();
  const queue = clone(out.inbound.exchanges);
  const posts = queue.map((e, i) => [e, i]).filter(([e]) => operationOfExchange(e) === 'inboundPost');
  const [, refusedAt] = posts[1];
  queue[refusedAt].status = posts[0][0].status;
  queue[refusedAt].body = posts[0][0].body;
  const run = await runStep('inbound', queue);
  assert.ok(run.error, 'a refusal that did not happen is a failed step');
  assert.ok(ownFailure(run.error), `the step failed for the wrong reason: ${run.error?.message}`);
});

// watch -----------------------------------------------------------------------------------------

test('watch: a token watch and a screen are created (paid) and listed, then one paid search names the watched token', async () => {
  const { w, out } = await stepwise();
  const t = out.watch.trace;
  assert.deepEqual(ops(t), ['watchCreate', 'watchCreate', 'watchCreate', 'watchCreate', 'watchList', 'tradeSearch', 'tradeSearch']);
  assert.deepEqual(t.map(e => e.status === 402 ? 402 : ok(e.status) ? 'ok' : e.status), [402, 'ok', 402, 'ok', 'ok', 402, 'ok']);
  assert.deepEqual(paid(t).map(e => e.operation), ['watchCreate', 'watchCreate', 'tradeSearch']);
  for (const entry of paid(t)) assert.equal(acceptedOf(entry).accepted.amount, w.price[entry.operation]);
  assert.ok(t.every(e => e.operation === 'watchList' ? signed(e) : !signed(e)));

  const creates = paid(t).filter(e => e.operation === 'watchCreate');
  const [one, two] = creates.map(e => JSON.parse(e.body).condition);
  const kinds = [one.kind, two.kind];
  assert.equal(kinds.filter(kind => kind === 'screen').length, 1, 'one screen');
  const token = [one, two].find(condition => condition.kind !== 'screen');
  assert.match(token.token, /^0x[0-9a-fA-F]{40}$/, 'one watch on a named token');
  const screen = [one, two].find(condition => condition.kind === 'screen');
  assert.ok(Array.isArray(screen.where) && screen.where.length >= 1);

  const listed = t.find(e => e.operation === 'watchList').response.watches.map(watch => watch.id);
  for (const create of creates) assert.ok(listed.includes(create.response.id), 'the list shows each watch just created');

  const search = paid(t).at(-1);
  const query = JSON.parse(search.body).query;
  assert.ok([token.token.toLowerCase(), 'cirbtc'].includes(String(query).toLowerCase()), `the search names the watched token, not "${query}"`);
  assert.ok(ops(t).lastIndexOf('watchCreate') < ops(t).indexOf('tradeSearch'), 'the search follows the watches, so the index change reaches them');
});

// channel ---------------------------------------------------------------------------------------

test('channel: a webhook with its filter, listed with verifiedAt and the filter, then rotated; never enabled or disabled', async () => {
  const { w, out } = await stepwise();
  const t = out.channel.trace;
  const names = ops(t);
  assert.deepEqual(names.slice(0, 2), ['webhookCreate', 'webhookCreate']);
  assert.equal(t[0].status, 402);
  assert.ok(ok(t[1].status));
  assert.equal(acceptedOf(t[1]).accepted.amount, w.price.webhookCreate);
  assert.deepEqual(paid(t), [t[1]]);

  const sent = JSON.parse(t[1].body), created = t[1].response;
  assert.equal(sent.url, w.config.webhookUrl);
  assert.ok(Array.isArray(sent.filter) && sent.filter.length > 0, 'the filter is sent');
  assert.deepEqual(created.filter, sent.filter);

  const lists = ofOp(t, 'webhookList');
  assert.ok(lists.length >= 1 && lists.every(signed));
  const shown = lists.at(-1).response.webhooks.find(channel => channel.id === created.id);
  assert.ok(Number.isInteger(shown.verifiedAt) && shown.verifiedAt > 0, 'the step waited for the ownership challenge to be answered');
  assert.deepEqual(shown.filter, sent.filter);

  assert.deepEqual(names.slice(2), [...names.slice(2).filter(name => name === 'webhookList'), 'webhookRotate'], 'lists, then the rotate, and nothing else');
  const rotate = t.at(-1);
  assert.ok(ok(rotate.status) && signed(rotate));
  assert.equal(rotate.path, `${lists[0].path.replace(/list$/, '')}${created.id}/rotate`);
  assert.ok(t.every(e => !e.path.endsWith('/enable') && !e.path.includes('/telegram')));
});

test('channel: a channel that never answers its ownership challenge is waited for a bounded time, then the step fails before rotating', async () => {
  const { out } = await stepwise();
  const queue = clone(out.channel.exchanges.slice(0, 2));
  const list = clone(out.channel.exchanges.find(e => operationOfExchange(e) === 'webhookList'));
  for (const channel of list.body.webhooks) channel.verifiedAt = null;
  const run = await runStep('channel', queue, { pool: [list], limit: 300 });
  assert.ok(run.error, 'an unverified channel is a failed step');
  assert.ok(ownFailure(run.error), `the step failed for the wrong reason: ${run.error?.message}`);
  assert.ok(ofOp(run.trace, 'webhookList').length >= 2, 'it asked again');
  assert.ok(ofOp(run.trace, 'webhookList').length < 300, 'and stopped asking');
  assert.ok(run.sleeps.length >= 1, 'it waited between asks');
  assert.equal(ofOp(run.trace, 'webhookRotate').length, 0);
});

test('channel: a verified channel listed with a different filter than the one sent fails the step before rotating', async () => {
  const { out } = await stepwise();
  const queue = clone(out.channel.exchanges.slice(0, 2));
  const list = clone(out.channel.exchanges.find(e => operationOfExchange(e) === 'webhookList'));
  for (const channel of list.body.webhooks) Object.assign(channel, { verifiedAt: 1, filter: ['inbound'] });
  queue.push(list);
  const run = await runStep('channel', queue);
  assert.ok(run.error, 'a channel listed with another filter is a failed step');
  assert.ok(ownFailure(run.error), `the step failed for the wrong reason: ${run.error?.message}`);
  assert.match(run.error.message, /\["inbound"\]/);
  assert.match(run.error.message, /\["inbound","watch"\]/);
  assert.equal(ofOp(run.trace, 'webhookRotate').length, 0);
});

// messages --------------------------------------------------------------------------------------

test('messages: waits for a watch hit, lists every page by cursor, fetches one message and deletes it, keeping an inbound message', async () => {
  const { out } = await stepwise();
  const t = out.messages.trace;
  assert.ok(t.every(signed), 'every message call is a signed owner call');
  const lists = ofOp(t, 'boxMessageList');
  assert.ok(lists.length >= 1);

  const known = new Set([0]);
  for (const list of lists) {
    const cursor = Number(params(list).get('cursor') ?? 0);
    assert.ok(known.has(cursor), `cursor ${cursor} was not returned by an earlier page`);
    if (params(list).has('limit')) assert.ok(Number.isInteger(Number(params(list).get('limit'))) && Number(params(list).get('limit')) > 0);
    known.add(list.response.nextCursor);
  }
  assert.equal(lists.at(-1).response.messages.length, 0, 'the last page read is the empty one: the box is caught up');

  const seen = new Map(messagesIn(t).map(message => [message.seq, message]));
  assert.ok([...seen.values()].some(message => message.type === 'watch.token' || message.type === 'watch.screen'), 'a watch hit was waited for');
  const inbound = [...seen.values()].filter(message => message.type === 'inbound').map(message => message.seq);
  assert.ok(inbound.length >= 2, 'the capture holds the two inbound posts');

  const fetches = ofOp(t, 'boxMessageFetch'), deletes = ofOp(t, 'boxMessageDelete');
  assert.equal(fetches.length, 1);
  assert.equal(deletes.length, 1);
  const seq = Number(lastSegment(fetches[0]));
  assert.equal(Number(lastSegment(deletes[0])), seq, 'the message fetched is the one deleted');
  assert.equal(seq, Math.max(...inbound), 'the newest inbound message');
  assert.ok(ok(deletes[0].status) && deletes[0].response.deleted === true);
  assert.ok(t.indexOf(fetches[0]) > t.indexOf(lists[0]) && t.indexOf(deletes[0]) > t.indexOf(fetches[0]));
  assert.ok(inbound.filter(other => other !== seq).length >= 1, 'an inbound message stays in the box');
  assert.match(out.messages.logs.join('\n'), /untrusted/i);
  assert.match(out.messages.logs.join('\n'), /instruction/i);
});

test('messages: with only one inbound message it is fetched and kept', async () => {
  const { out } = await stepwise();
  const queue = clone(out.messages.exchanges);
  const inbound = queue.filter(e => operationOfExchange(e) === 'boxMessageList').flatMap(e => e.body.messages).filter(m => m.type === 'inbound').map(m => m.seq);
  const newest = Math.max(...inbound);
  for (const exchange of queue) if (operationOfExchange(exchange) === 'boxMessageList') exchange.body.messages = exchange.body.messages.filter(m => m.type !== 'inbound' || m.seq === newest);
  const kept = queue.filter(e => operationOfExchange(e) !== 'boxMessageDelete');
  assert.equal(kept.length, queue.length - 1);
  const run = await runStep('messages', kept);
  assert.equal(run.error, null, run.error?.message);
  assert.equal(ofOp(run.trace, 'boxMessageDelete').length, 0, 'the one inbound message is not deleted');
});

test('messages: with no watch hit it waits up to about 180 seconds, then stops without deleting', async () => {
  const { out } = await stepwise();
  const pool = clone(out.messages.exchanges.filter(e => operationOfExchange(e) === 'boxMessageList'));
  for (const exchange of pool) exchange.body.messages = exchange.body.messages.filter(m => !m.type.startsWith('watch.'));
  const run = await runStep('messages', [], { pool });
  const waited = run.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.notEqual(run.error?.code, 'REPLAY_LIMIT', 'it does not poll forever');
  assert.ok(waited >= 150_000, `it gave up after only ${waited} ms`);
  assert.ok(waited <= 200_000, `it waited ${waited} ms`);
  assert.equal(ofOp(run.trace, 'boxMessageDelete').length, 0);
});

// topup -----------------------------------------------------------------------------------------

test('topup: a 200 reports what was granted and the allowance', async () => {
  const { w, out } = await stepwise();
  const t = out.topup.trace;
  assert.deepEqual(ops(t), ['boxTopUp', 'boxTopUp']);
  assert.equal(t[0].status, 402);
  assert.ok(ok(t[1].status));
  assert.deepEqual(paid(t), [t[1]]);
  assert.equal(acceptedOf(t[1]).accepted.amount, w.price.boxTopUp);
  const { granted, allowance } = t[1].response, text = out.topup.logs.join('\n');
  assert.ok(text.includes(String(granted.messages)) && text.includes(String(allowance.messagesLeft)), `the log shows granted and the allowance: ${text}`);
  assert.match(text, /granted/i);
  assert.match(text, /allowance/i);
});

test('topup: 409 allowance_full is reported as not charged and the step passes', async () => {
  const w = world();
  const exchanges = w.fixture.exchanges;
  const at = exchanges.findIndex(e => e.status === 409 && e.body?.error?.code === 'allowance_full');
  assert.ok(at >= 0, 'the capture must hold a boxTopUp answered 409 allowance_full: capture = start, then topup run twice more under the same recorder, each as its own command run with its own paid client and per-run cap; the first is charged and grants the messages used during the run, the second is the 409');
  let from = at;
  while (from > 0 && exchanges[from - 1].path === exchanges[at].path && exchanges[from - 1].status === 402) from--;
  const run = await runStep('topup', clone(exchanges.slice(from, at + 1)));
  assert.equal(run.error, null, run.error?.message);
  const text = run.logs.join('\n');
  assert.match(text, /allowance_full/);
  assert.match(text, /not charged|nothing (was )?charged|no charge/i);
  assert.ok(run.records.every(entry => !entry.transaction), 'no settlement is recorded');
});

// cleanup ---------------------------------------------------------------------------------------

test('cleanup: deletes every listed inbound address, watch and webhook channel, then reads the status', async () => {
  const { out } = await stepwise();
  const t = out.cleanup.trace;
  const listed = [];
  for (const [list, key, remove] of [['inboundList', 'addresses', 'inboundDelete'], ['watchList', 'watches', 'watchDelete'], ['webhookList', 'webhooks', 'webhookDelete']]) {
    const lists = ofOp(t, list);
    assert.equal(lists.length, 1, `${list} once`);
    assert.ok(signed(lists[0]));
    assert.ok(lists[0].response[key].length > 0, `${list} found something to delete`);
    for (const item of lists[0].response[key]) listed.push({ remove, id: item.id, after: t.indexOf(lists[0]) });
  }
  const deleted = t.filter(e => e.method === 'DELETE');
  assert.deepEqual(deleted.map(e => `${e.operation}:${lastSegment(e)}`).sort(), listed.map(({ remove, id }) => `${remove}:${id}`).sort(), 'exactly the listed ones');
  for (const entry of deleted) {
    assert.ok(signed(entry) && ok(entry.status));
    assert.ok(t.indexOf(entry) > listed.find(item => item.id === lastSegment(entry)).after, 'deleted after it was listed');
  }
  assert.equal(deleted.filter(e => e.operation === 'boxMessageDelete').length, 0, 'the box keeps its messages');

  const made = [
    ...ofOp(out.inbound.trace, 'inboundCreate').filter(e => ok(e.status)),
    ...ofOp(out.watch.trace, 'watchCreate').filter(e => ok(e.status)),
    ...ofOp(out.channel.trace, 'webhookCreate').filter(e => ok(e.status)),
  ].map(e => e.response.id);
  for (const id of made) assert.ok(deleted.some(e => lastSegment(e) === id), `${id} was created by an earlier step and is not deleted`);

  assert.equal(t.at(-1).operation, 'boxStatus');
  const { counts } = t.at(-1).response;
  assert.equal(counts.inboundAddresses + counts.watches + counts.channels, 0);
});

// start -----------------------------------------------------------------------------------------

const shape = trace => apiTrace(trace).map(e => `${e.method} ${e.path} ${e.status}`);

test('start: runs the seven steps in order, then checks the box, and uses every captured exchange of the run', async () => {
  const { replay: stepReplay, failed } = await stepwise();
  if (failed) throw failed.error;
  const { replay } = await startRun();
  const all = shape(stepReplay.trace);
  assert.deepEqual(shape(replay.trace).slice(0, all.length), all, 'the same requests as the seven steps one by one');
  const check = apiTrace(replay.trace).slice(all.length);
  assert.ok(check.length >= 2 && check.every(e => e.method === 'GET' && signed(e)), 'then only signed reads');
  assert.ok(ops(check).includes('boxStatus') && ops(check).includes('boxMessageList'));
  assert.ok(replay.leftover().every(e => operationOfExchange(e) === 'boxTopUp'), 'nothing of the run is left unused, apart from a later topup capture');
});

test('start: ends with a check that the box holds an inbound message and a watch hit, and fails otherwise', async () => {
  const w = world();
  const queue = withSecrets(w.fixture.exchanges).filter(e => !isFree(e));
  const lastDelete = queue.findLastIndex(e => e.method === 'DELETE');
  const tail = (keep) => {
    const copy = clone(queue);
    let lists = 0;
    for (const exchange of copy.slice(lastDelete + 1)) {
      if (operationOfExchange(exchange) !== 'boxMessageList') continue;
      lists++;
      exchange.body.messages = exchange.body.messages.filter(keep);
    }
    assert.ok(lists >= 1, 'the final check lists the messages');
    return copy;
  };
  const kinds = { 'no inbound message': m => m.type !== 'inbound', 'no watch hit': m => !m.type.startsWith('watch.') };
  for (const [name, keep] of Object.entries(kinds)) {
    const replay = createReplay(w.fixture, { queue: tail(keep) });
    const c = context(w, replay);
    const error = await steps.start(c.ctx).then(() => null, failure => failure);
    assert.ok(error, `start must fail with ${name}`);
    assert.ok(ownFailure(error), `start failed for the wrong reason (${name}): ${error?.message}`);
  }
});

test('the per-run cap spans the whole start run: the payment that would pass it is not signed', async () => {
  const w = world();
  const queue = withSecrets(w.fixture.exchanges);
  const settled = runExchanges(w.fixture).filter(e => ok(e.status) && e.headers['payment-response']);
  const total = settled.reduce((sum, e) => sum + BigInt(w.price[operationOfExchange(e)]), 0n);
  const replay = createReplay(w.fixture, { queue });
  const c = context({ ...w, config: { ...w.config, maxTotal: total - 1n } }, replay);
  const error = await steps.start(c.ctx).then(() => null, failure => failure);
  assert.ok(error, 'one unit under the cost of the run, start must stop');
  assert.ok(ownFailure(error), `start failed for the wrong reason: ${error?.message}`);
  const t = apiTrace(replay.trace);
  assert.equal(paid(t).length, settled.length - 1, 'every payment but the last was signed');
  assert.equal(t.at(-1).operation, settled.at(-1) && operationOfExchange(settled.at(-1)), 'the run stopped at its last payment');
  assert.equal(t.at(-1).headers['payment-signature'], undefined, 'the payment past the cap was not signed');
});

// the whole run ---------------------------------------------------------------------------------

test('the run pays exactly the captured paid calls, each at the API terms, to one payTo on the health network, within the caps', async () => {
  const { w, replay } = await startRun();
  const t = apiTrace(replay.trace), payments = paid(t);
  const count = {};
  for (const entry of payments) count[entry.operation] = (count[entry.operation] ?? 0) + 1;
  assert.deepEqual(count, { boxCreate: 1, inboundCreate: 1, watchCreate: 2, tradeSearch: 1, webhookCreate: 1, boxTopUp: 1 });

  const payTo = new Set();
  let total = 0n;
  for (const entry of payments) {
    assert.ok(PAID.includes(entry.operation));
    const { accepted } = acceptedOf(entry);
    assert.equal(accepted.amount, w.price[entry.operation], `${entry.operation} pays the operation's price from /openapi.json`);
    assert.equal(accepted.network, w.network);
    assert.ok(BigInt(accepted.amount) <= w.config.maxPayment);
    payTo.add(accepted.payTo.toLowerCase());
    total += BigInt(accepted.amount);
  }
  assert.equal(payTo.size, 1);
  assert.ok(total <= w.config.maxTotal);

  for (const entry of t) {
    assert.ok(!entry.path.split('?')[0].endsWith('/enable') && !entry.path.includes('/telegram'), `${entry.path}: no enable, disable or Telegram call`);
    assert.equal(entry.redirect, 'error', `${entry.method} ${entry.path} follows no redirect`);
    assert.ok(entry.hasSignal, `${entry.method} ${entry.path} has a timeout`);
    if (PAID.includes(entry.operation)) assert.ok(!signed(entry), `${entry.operation} is a paid call, authenticated by its payment`);
    else if (entry.operation !== 'inboundPost') { assert.ok(signed(entry) && !entry.headers['payment-signature'], `${entry.operation} is a signed owner call`); }
    else assert.ok(!signed(entry) && !entry.headers['payment-signature'] && INBOUND_POST.test(entry.path), 'an inbound post is an outside service: no wallet involved');
  }
});
