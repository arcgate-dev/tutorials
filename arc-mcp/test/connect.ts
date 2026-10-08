import type { TestContext } from 'node:test';
import { connectArcgate } from '../src/mcp.ts';
import { fakeMcp } from './fake-mcp.ts';
import { testConfig } from './test-config.ts';

/**
 * Connects the tutorial's client to the fake server and closes it when the test ends: the MCP and
 * x402 clients keep request timers alive, which would hold the test process open for minutes.
 */
export async function connect(t: TestContext, config = testConfig(), fake = fakeMcp()) {
  const arcgate = await connectArcgate({ config, fetchFn: fake.fetch, log: fake.log });
  t.after(() => arcgate.close());
  return { config, fake, arcgate };
}
