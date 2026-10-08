import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recordingFetch } from './capture.js';
import { loadConfig, reportError } from './config.js';
import * as steps from './steps.js';

const COMMANDS = ['box', 'inbound', 'watch', 'channel', 'messages', 'topup', 'cleanup', 'start'];

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command] = args;
  if (!COMMANDS.includes(command)) throw new Error(`Use npm run ${COMMANDS.join(', ')}.`);
  const captureAt = args.indexOf('--capture');
  const captureFile = captureAt === -1 ? null : args[captureAt + 1];
  if (captureAt !== -1 && (command !== 'start' || !captureFile)) throw new Error('--capture <file> goes with start only.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PRIVATE_KEY ?? '')) throw new Error('Set PRIVATE_KEY to a 0x-prefixed 32-byte hex key in .env.');

  const config = loadConfig(env);
  const account = privateKeyToAccount(env.PRIVATE_KEY);
  const wallet = { address: account.address, signTypedData: data => account.signTypedData(data) };

  mkdirSync('.runs', { recursive: true, mode: 0o700 });
  const path = `.runs/${randomUUID()}.jsonl`;
  console.log(`Run log: ${path}`);
  const record = entry => {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    console.log(JSON.stringify(entry));
  };

  const recorder = captureFile ? recordingFetch(fetch, captureFile) : null;
  const ctx = {
    config, wallet, record, log: console.log, now: Date.now, sleep: ms => delay(ms),
    fetchFn: recorder ? recorder.fetch : fetch,
    rpc: createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0 }) }),
  };
  await steps[command](ctx);
  if (recorder) {
    // The capture also holds two more top-ups, each its own command run: the first is charged, the second is refused as allowance_full.
    await steps.topup(ctx);
    await steps.topup(ctx);
    await recorder.save({ address: wallet.address, apiUrl: config.apiUrl });
    console.log(`Captured ${captureFile}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
