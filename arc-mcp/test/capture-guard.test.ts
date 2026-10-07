import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFixtures } from '../src/capture.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, noNetwork, PAYMENT_META } from './support.ts';

globalThis.fetch = noNetwork;

test('the capture pays nothing when the signed boxStatus is refused for a reason other than box_not_found', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await mkdtemp(join(tmpdir(), 'arc-mcp-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Any refusal that is not box_not_found stands in for signature_expired, a rate limit or a 5xx.
  fake.set('boxStatus', 'paid', captured('box-status.signature-required'));

  await assert.rejects(captureFixtures({ config, fetchFn: fake.fetch, dir, log: fake.log }), /boxStatus was refused: signature_required/);

  assert.equal(fake.paidCalls().length, 0, 'tradeSearch and tradeQuote were never paid');
  assert.deepEqual(await readdir(dir), [], 'nothing was written');
});

test('the capture writes nothing when the second connection\'s boxCreate is refused for a reason other than box_exists', async (t) => {
  const config = testConfig();
  const fake = fakeMcp();
  const dir = await mkdtemp(join(tmpdir(), 'arc-mcp-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Once the first paid boxCreate has answered, the next one comes back as a settlement failure
  // (a payment-required result with a string error), not as box_exists.
  let created = false;
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await fake.fetch(input, init);
    const request = init?.body ? JSON.parse(String(init.body)) : {};
    if (request.params?.name === 'boxCreate' && request.params._meta?.[PAYMENT_META] && !created) {
      created = true;
      fake.set('boxCreate', 'paid', captured('trade-search.payment-required'));
    }
    return response;
  };

  await assert.rejects(captureFixtures({ config, fetchFn, dir, log: fake.log }), /boxCreate was refused: payment_required/);

  assert.deepEqual(await readdir(dir), [], 'nothing was written');
});
