import type { Config } from './config.ts';
import { agentSignature } from './agent.ts';
import { errorOf, type Arcgate, type ToolResult } from './mcp.ts';

const USDC = '0x3600000000000000000000000000000000000000';
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';

export function refusal(tool: string, result: ToolResult) {
  const { code, message, next } = errorOf(result);
  return new Error(`${tool} was refused: ${code}: ${message}${next ? ` next ${next}` : ''}`);
}

/**
 * Lists the server's tools, calls the free ones, pays for a search and a quote, then makes sure the
 * agent has a box: a signed boxStatus first, and a paid boxCreate only when it answers box_not_found.
 */
export async function runTour({ config, arcgate, log }: { config: Config; arcgate: Arcgate; log: (line: string) => void }) {
  const { tools } = await arcgate.listTools();
  log(`tools/list: ${tools.length} tools`);
  for (const tool of tools) log(`- ${tool.name}`);

  const call = async (tool: string, args: Record<string, unknown>) => {
    const out = await arcgate.call(tool, args);
    if (out.result.isError) throw refusal(tool, out.result);
    log(`${tool}: ok`);
  };
  const address = config.agent.address;
  const boxStatus = async () => arcgate.call('boxStatus', { address, agentSignature: await agentSignature(config.agent, address) });

  await call('health', {});
  await call('tradeVenues', {});
  await call('tradeSearch', { query: 'cirBTC', limit: 5 });
  await call('tradeQuote', { sell: USDC, buy: CIRBTC, amount: '1' });

  const status = await boxStatus();
  if (!status.result.isError) {
    log(`boxStatus: ${address} has a box, and that is the box`);
    return;
  }
  if (errorOf(status.result).code !== 'box_not_found') throw refusal('boxStatus', status.result);
  log(`boxStatus: ${address} has no box`);

  // A box_exists answer to the paid boxCreate is not charged: the box is there, which is all the tour needs.
  const created = await arcgate.call('boxCreate', { address });
  if (created.result.isError && errorOf(created.result).code !== 'box_exists') throw refusal('boxCreate', created.result);

  const after = await boxStatus();
  if (after.result.isError) throw refusal('boxStatus', after.result);
  log(`boxStatus: ${address} has a box`);
}
