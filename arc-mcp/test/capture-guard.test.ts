import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFixtures } from '../src/capture.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';
import { captured, noNetwork } from './support.ts';

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
