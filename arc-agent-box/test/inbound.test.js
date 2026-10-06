import test from 'node:test';
import assert from 'node:assert/strict';
import { postInbound } from '../src/inbound.js';
import { hmacHex } from './replay.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const id = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url characters, as an inbound address id is
const url = `http://127.0.0.1:19803/${id}`; // an inbound address: the notifier's origin, then the id
const secret = 'sécret-ünïcode-0123456789';
const body = { run: 'run-1', note: 'héllo ✓', at: 1_700_000_123 };
const now = () => 1_700_000_123_456; // milliseconds

function outsideService(respond) {
  const requests = [];
  const fetchFn = async (target, init) => {
    requests.push({ url: target, init, headers: new Headers(init.headers) });
    return respond(target, init);
  };
  return { fetchFn, requests };
}
const stored = () => Response.json({ stored: true, seq: 3 }, { status: 201 });
const refused = () => Response.json({ error: { code: 'inbound_unauthorized', hint: 'send a valid INBOUND-SIGNATURE' } }, { status: 401 });
const sentBody = init => Buffer.from(init.body);

test('signature mode sends INBOUND-TIMESTAMP and an HMAC-SHA256 hex over "<ts>." and the exact body, keyed by the secret', async () => {
  const { fetchFn, requests } = outsideService(stored);
  const result = await postInbound({ url, secret, body, mode: 'signature', now, fetchFn });
  assert.deepEqual(result, { status: 201, body: { stored: true, seq: 3 } });

  const [{ init, headers }] = requests;
  assert.equal(requests[0].url, url);
  assert.equal(init.method, 'POST');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('content-encoding'), null);
  assert.equal(headers.get('inbound-secret'), null, 'the secret itself is not sent in signature mode');
  assert.equal(headers.get('inbound-timestamp'), String(Math.floor(now() / 1000)));
  const signature = headers.get('inbound-signature');
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signature, hmacHex(secret, headers.get('inbound-timestamp'), sentBody(init)));
  assert.deepEqual(JSON.parse(sentBody(init).toString('utf8')), body);
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal, 'a timeout');
});

test('the signature changes with the secret, the timestamp and the body', async () => {
  const signatures = [];
  for (const [s, n, b] of [[secret, now, body], ['another-secret', now, body], [secret, () => now() + 5000, body], [secret, now, { ...body, run: 'run-2' }]]) {
    const { fetchFn, requests } = outsideService(stored);
    await postInbound({ url, secret: s, body: b, mode: 'signature', now: n, fetchFn });
    signatures.push(requests[0].headers.get('inbound-signature'));
  }
  assert.equal(new Set(signatures).size, 4);
});

test('secret mode sends INBOUND-SECRET and no signature or timestamp', async () => {
  const { fetchFn, requests } = outsideService(stored);
  assert.equal((await postInbound({ url, secret, body, mode: 'secret', now, fetchFn })).status, 201);
  const [{ init, headers }] = requests;
  assert.equal(headers.get('inbound-secret'), secret);
  assert.equal(headers.get('inbound-signature'), null);
  assert.equal(headers.get('inbound-timestamp'), null);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('content-encoding'), null);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(sentBody(init).toString('utf8')), body);
});

test('a 401 is returned to the step with its body, never thrown', async () => {
  for (const mode of ['signature', 'secret']) {
    const { fetchFn } = outsideService(refused);
    const result = await postInbound({ url, secret, body, mode, now, fetchFn });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'inbound_unauthorized');
  }
});

test('other answers are returned the same way: the step decides what they mean', async () => {
  const { fetchFn } = outsideService(() => Response.json({ error: { code: 'rate_limited' }, retryAfterSec: 2 }, { status: 429 }));
  assert.deepEqual(await postInbound({ url, secret, body, mode: 'secret', now, fetchFn }), { status: 429, body: { error: { code: 'rate_limited' }, retryAfterSec: 2 } });
});
