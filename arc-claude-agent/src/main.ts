import { pathToFileURL } from 'node:url';
import { runSetup, runWatch } from './bot.ts';
import { captureFixtures } from './capture.ts';
import { loadConfig, reportError } from './config.ts';

export async function main(args = process.argv.slice(2), env = process.env) {
  const config = loadConfig(env);
  const log = console.log;
  const [command, ...rest] = args;
  if (command === 'capture') {
    await captureFixtures({ config, fetchFn: globalThis.fetch, dir: new URL('../test/fixtures', import.meta.url).pathname, log });
  } else if (command === 'watch') {
    await runWatch({ config, fetchFn: globalThis.fetch, log, once: rest.includes('--once') });
  } else {
    const request = args.join(' ').trim();
    if (!request) throw new Error('Say what to set up: npm start -- "<your request>"');
    await runSetup({ request, config, fetchFn: globalThis.fetch, log });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
