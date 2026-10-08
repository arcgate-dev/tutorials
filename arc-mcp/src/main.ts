import { pathToFileURL } from 'node:url';
import { captureFixtures } from './capture.ts';
import { loadConfig, reportError } from './config.ts';
import { connectArcgate } from './mcp.ts';
import { runTour } from './tour.ts';

export async function main(args = process.argv.slice(2), env = process.env) {
  const config = loadConfig(env);
  const log = console.log;
  if (args[0] === 'capture') {
    await captureFixtures({ config, fetchFn: globalThis.fetch, dir: new URL('../test/fixtures', import.meta.url).pathname, log });
    return;
  }
  const arcgate = await connectArcgate({ config, fetchFn: globalThis.fetch, log });
  try {
    await runTour({ config, arcgate, log });
  } finally {
    await arcgate.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportError);
