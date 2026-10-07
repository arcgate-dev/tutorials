import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { agentSignature } from './agent.ts';
import { connectArcgate } from './mcp.ts';
import { runTour } from './tour.ts';

// tool -> [the answer to a call without a payment or signature, the answer to one with it]. A paid
// boxCreate that is refused is the box_exists answer; a signed boxStatus that is refused is box_not_found.
const TOOLS: Record<string, [string, string] | [string, string, string]> = {
  health: ['health', 'health'],
  tradeVenues: ['trade-venues', 'trade-venues'],
  tradeSearch: ['trade-search.payment-required', 'trade-search.paid'],
  tradeQuote: ['trade-quote.payment-required', 'trade-quote.paid'],
  boxCreate: ['box-create.payment-required', 'box-create.paid', 'box-create.exists'],
  boxStatus: ['box-status.signature-required', 'box-status', 'box-status.not-found'],
};

export const FIXTURES = [
  'initialize', 'tools-list', 'mcp-get.event-stream', 'health', 'trade-venues',
  'trade-search.payment-required', 'trade-search.paid',
  'trade-quote.payment-required', 'trade-quote.paid',
  'box-status.signature-required', 'box-status.not-found',
  'box-create.payment-required', 'box-create.paid',
  'box-status', 'box-create.exists',
];

/** The fixture a request's response body belongs to. */
function fixtureName(init: RequestInit, body: string): string | undefined {
  if (!body) return undefined; // a notification's 202
  const method = init.method ?? 'GET';
  if (method === 'GET') return 'mcp-get.event-stream';
  if (method !== 'POST') return undefined;
  const request = JSON.parse(String(init.body));
  if (request.method === 'initialize') return 'initialize';
  if (request.method === 'tools/list') return 'tools-list';
  if (request.method !== 'tools/call') return undefined;
  const [plain, answered, refused] = TOOLS[request.params.name];
  const sent = request.params._meta?.['x402/payment'] ?? request.params.arguments?.agentSignature;
  if (!sent) return plain;
  return JSON.parse(body).result.isError ? refused : answered;
}

/**
 * Records the localnet responses the tests answer with. It tees the one client's fetch: an unsigned
 * boxStatus, the tour, then a second connection (its own budget) that calls boxCreate again for the
 * box_exists answer. It writes the 15 files only when every one was recorded.
 */
export async function captureFixtures({ config, fetchFn, dir, log }: { config: Config; fetchFn: typeof fetch; dir: string; log: (line: string) => void }) {
  const recorded = new Map<string, string>();
  const tee: typeof fetch = async (input, init) => {
    const response = await fetchFn(input, init);
    const body = await response.clone().text();
    const name = fixtureName(init ?? {}, body);
    if (name && !recorded.has(name)) recorded.set(name, body);
    return response;
  };
  const address = config.agent.address;

  const first = await connectArcgate({ config, fetchFn: tee, log });
  try {
    await first.call('boxStatus', { address });
    // Before anything is paid: a box already there means there is no box_not_found to record.
    const status = await first.call('boxStatus', { address, agentSignature: await agentSignature(config.agent, address) });
    if (!status.result.isError) {
      throw new Error(`${address} already has a box, so there is no box_not_found to capture; nothing was written. Use an AGENT_PRIVATE_KEY with no box.`);
    }
    await runTour({ config, arcgate: first, log });
  } finally {
    await first.close();
  }

  const second = await connectArcgate({ config, fetchFn: tee, log });
  try {
    await second.call('boxCreate', { address });
  } finally {
    await second.close();
  }

  const missing = FIXTURES.filter((name) => !recorded.has(name));
  if (missing.length > 0) throw new Error(`The run did not record ${missing.join(', ')}; nothing was written.`);
  await mkdir(dir, { recursive: true });
  for (const name of FIXTURES) await writeFile(join(dir, `${name}.json`), recorded.get(name)!);
  log(`Captured ${FIXTURES.length} fixtures in ${dir}`);
}
