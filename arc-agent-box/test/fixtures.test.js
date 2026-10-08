import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordingFetch } from '../src/capture.js';
import { INBOUND_POST, loadFixture, openapi, operationOf } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const RESPONSE_HEADERS = ['content-type', 'payment-required', 'payment-response', 'x-request-id'];
const EXCHANGE_KEYS = ['body', 'headers', 'method', 'path', 'requestBody', 'status'];
const FORBIDDEN_KEY = /^(payment-signature|agent-signature|agent-nonce|agent-expiry|inbound-signature|inbound-secret|inbound-timestamp|authorization|cookie|set-cookie)$/i;

function* walk(value, key = null) {
  yield [key, value];
  if (Array.isArray(value)) for (const item of value) yield* walk(item, key);
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) yield* walk(item, name);
}

// a real capture ---------------------------------------------------------------------------------

test('mainnet.json is a capture: capturedAt, the https apiUrl, an address, the API commit and exchanges', () => {
  const fixture = loadFixture();
  assert.match(fixture.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(!Number.isNaN(Date.parse(fixture.capturedAt)));
  const api = new URL(fixture.apiUrl);
  assert.equal(api.protocol, 'https:');
  assert.equal(fixture.apiUrl, 'https://api.arcgate.dev');
  assert.equal(fixture.apiUrl, api.origin, 'apiUrl is the origin the run used');
  assert.match(fixture.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(fixture.apiCommit, /^[0-9a-f]{7,40}$/, 'the arcgate checkout commit the run used');
  assert.ok(Array.isArray(fixture.exchanges) && fixture.exchanges.length > 0);
});

test('every exchange the API answered carries an x-request-id; only inbound posts, answered by the notifier, may lack one', () => {
  const { exchanges } = loadFixture();
  let api = 0, inbound = 0;
  for (const exchange of exchanges) {
    assert.deepEqual(Object.keys(exchange).filter(key => !EXCHANGE_KEYS.includes(key)), [], `${exchange.method} ${exchange.path} has an unexpected field`);
    assert.ok(['GET', 'POST', 'DELETE'].includes(exchange.method));
    assert.ok(exchange.path.startsWith('/') && !exchange.path.includes('://'), `${exchange.path} is a path without an origin`);
    assert.ok(Number.isInteger(exchange.status));
    assert.deepEqual(Object.keys(exchange.headers).filter(name => !RESPONSE_HEADERS.includes(name)), [], `${exchange.path} recorded a header it should not`);
    if (exchange.method === 'POST' && INBOUND_POST.test(exchange.path)) { inbound++; continue; }
    api++;
    assert.match(exchange.headers['x-request-id'] ?? '', /\S/, `${exchange.method} ${exchange.path} has no x-request-id: it did not come from the API`);
  }
  assert.ok(api > 0 && inbound >= 2, 'the capture holds API exchanges and the inbound posts');
});

test('every secret in the capture is <redacted> and no payment or agent signature header was recorded', () => {
  const fixture = loadFixture();
  let secrets = 0;
  for (const [key, value] of walk(fixture)) {
    assert.ok(!FORBIDDEN_KEY.test(key ?? ''), `the capture holds a ${key} field`);
    if (key === 'secret') { secrets++; assert.equal(value, '<redacted>'); }
  }
  for (const exchange of fixture.exchanges) {
    const operation = operationOf(exchange.method, exchange.path);
    if (['inboundCreate', 'inboundRotate', 'webhookCreate', 'webhookRotate'].includes(operation) && exchange.status < 300) {
      assert.equal(exchange.body.secret, '<redacted>', `${operation} shows a secret exactly once, redacted`);
    }
  }
  assert.ok(secrets >= 4, 'inbound create and rotate, webhook create and rotate each answered with a secret');
});

test('the captured /openapi.json is only operationId and x-payment', () => {
  const spec = openapi(loadFixture()).body;
  assert.deepEqual(Object.keys(spec), ['paths']);
  let operations = 0;
  for (const methods of Object.values(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations++;
      assert.ok(['get', 'post', 'delete', 'put', 'patch'].includes(method));
      assert.ok(typeof operation.operationId === 'string');
      assert.deepEqual(Object.keys(operation).filter(key => !['operationId', 'x-payment'].includes(key)), []);
    }
  }
  assert.ok(operations > 0);
});

// offline ----------------------------------------------------------------------------------------

test('every test file makes globalThis.fetch throw', () => {
  const folder = new URL('.', import.meta.url);
  const files = readdirSync(folder).filter(name => name.endsWith('.test.js'));
  for (const required of ['agent.test.js', 'config.test.js', 'fixtures.test.js', 'flow.test.js', 'inbound.test.js', 'payment.test.js']) assert.ok(files.includes(required), `${required} is missing`);
  for (const file of files) {
    assert.match(readFileSync(new URL(file, folder), 'utf8'), /^globalThis\.fetch = \(\) => \{ throw new Error\(/m, `${file} does not block the network`);
  }
});

// capture mode -----------------------------------------------------------------------------------

test('capture redacts secrets, never writes signature headers and reduces openapi.json, while the caller sees the real answers', async () => {
  const fixture = loadFixture();
  const create = fixture.exchanges.find(e => operationOf(e.method, e.path) === 'inboundCreate' && e.status < 300);
  const SECRET = 'fake-secret-for-the-redaction-test', NESTED = 'another-fake-secret';

  const spec = structuredClone(openapi(fixture).body);
  for (const methods of Object.values(spec.paths)) {
    for (const operation of Object.values(methods)) Object.assign(operation, { summary: 'A summary', description: 'A long description', parameters: [{ name: 'address', in: 'path' }], responses: { 200: { description: 'ok' } } });
  }
  const full = { openapi: '3.1.0', info: { title: 'arcgate' }, servers: [{ url: fixture.apiUrl }], ...spec, components: { schemas: { Big: { type: 'object' } } } };

  const answers = {
    [create.path]: () => new Response(JSON.stringify({ ...create.body, secret: SECRET, nested: [{ secret: NESTED, keep: 'value' }] }),
      { status: create.status, headers: { ...create.headers, 'set-cookie': 'sid=abc', 'x-extra': 'extra' } }),
    '/openapi.json': () => Response.json(full, { headers: { 'x-request-id': 'req-openapi', 'content-type': 'application/json' } }),
  };
  const inner = async (url, init) => answers[new URL(url).pathname]();

  const folder = mkdtempSync(join(tmpdir(), 'arc-agent-box-capture-'));
  const file = join(folder, 'capture.json');
  const previous = process.env.CAPTURE_API_COMMIT;
  process.env.CAPTURE_API_COMMIT = 'abc1234';
  try {
    const { fetch: recorded, save } = recordingFetch(inner, file);
    const requestBody = { probe: true };
    const reply = await recorded(`${fixture.apiUrl}${create.path}?probe=1`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': 'PSIG-123', 'AGENT-SIGNATURE': 'ASIG-456', 'AGENT-NONCE': 'ANONCE-789', 'AGENT-EXPIRY': '1', 'INBOUND-SECRET': 'ISECRET-0' },
      body: JSON.stringify(requestBody) });
    const seen = await reply.json();
    assert.equal(seen.secret, SECRET, 'the caller still gets the real secret');
    assert.equal(seen.nested[0].secret, NESTED);
    await recorded(`${fixture.apiUrl}/openapi.json`, { method: 'GET' });
    await save({ address: fixture.address, apiUrl: fixture.apiUrl });

    const text = readFileSync(file, 'utf8');
    for (const value of [SECRET, NESTED, 'PSIG-123', 'ASIG-456', 'ANONCE-789', 'ISECRET-0', 'sid=abc']) assert.ok(!text.includes(value), `the capture file holds ${value}`);
    for (const [key] of walk(JSON.parse(text))) assert.ok(!FORBIDDEN_KEY.test(key ?? ''), `the capture file has a ${key} field`);

    const saved = JSON.parse(text);
    assert.equal(saved.apiUrl, fixture.apiUrl);
    assert.equal(saved.address, fixture.address);
    assert.equal(saved.apiCommit, 'abc1234');
    assert.ok(Math.abs(Date.parse(saved.capturedAt) - Date.now()) < 60_000);
    assert.equal(saved.exchanges.length, 2);

    const [first, second] = saved.exchanges;
    assert.equal(first.method, 'POST');
    assert.equal(first.path, `${create.path}?probe=1`);
    assert.deepEqual(first.requestBody, requestBody);
    assert.equal(first.status, create.status);
    assert.equal(first.body.secret, '<redacted>');
    assert.equal(first.body.nested[0].secret, '<redacted>');
    assert.equal(first.body.nested[0].keep, 'value');
    assert.equal(first.body.id, create.body.id, 'the rest of the answer is kept');
    assert.deepEqual(Object.keys(first.headers).sort(), Object.keys(create.headers).sort());
    assert.ok(Object.keys(first.headers).every(name => RESPONSE_HEADERS.includes(name)));
    assert.equal(first.headers['x-request-id'], create.headers['x-request-id']);

    assert.equal(second.path, '/openapi.json');
    assert.deepEqual(second.body, openapi(fixture).body, 'openapi.json is reduced to operationId and x-payment');
    assert.equal(second.headers['x-request-id'], 'req-openapi');
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_API_COMMIT; else process.env.CAPTURE_API_COMMIT = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
