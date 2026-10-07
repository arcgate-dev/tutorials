import { query as sdkQuery, type McpSdkServerConfigWithInstance, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { formatUnits } from 'viem';
import { arcgateServer, readPage, TOOLS, type Mode } from './bridge.ts';
import type { Config } from './config.ts';
import { connectArcgate } from './mcp.ts';
import { SETUP_PROMPT, WATCH_PROMPT } from './prompts.ts';

type Query = typeof sdkQuery;
type Log = (line: string) => void;

const PROMPTS: Record<Mode, string> = { setup: SETUP_PROMPT, watch: WATCH_PROMPT };

/**
 * The query's options: the model reaches the mode's arcgate tools and nothing else. No built-in tool
 * (no Bash, Read, Write, Edit or web), no settings or MCP configuration from disk, and nothing outside
 * allowedTools is asked about: it is refused. The tools run in this process, so the model's own process
 * is given the environment without PRIVATE_KEY.
 */
export function buildQueryOptions({ config, mode, server, abortController }: { config: Config; mode: Mode; server: McpSdkServerConfigWithInstance; abortController: AbortController }): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0] !== 'PRIVATE_KEY' && entry[1] !== undefined));
  return {
    model: config.model,
    systemPrompt: PROMPTS[mode],
    tools: [],
    allowedTools: TOOLS[mode].map((name) => `mcp__arcgate__${name}`),
    mcpServers: { arcgate: server },
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: 'dontAsk',
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    abortController,
    env,
  };
}

/** Runs one query to its result message. An abort (the spend cap) ends the stream with no result, or by throwing: both are the end of the run. */
async function runQuery(query: Query, prompt: string, options: Options): Promise<SDKResultMessage | undefined> {
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    if (!options.abortController?.signal.aborted) throw error;
  }
  return result;
}

/** What the model said, or why it did not finish. */
function report(result: SDKResultMessage | undefined, log: Log) {
  if (result?.subtype === 'success') return log(result.result);
  log(`The model did not finish${result ? `: ${result.subtype}${result.errors.length ? `: ${result.errors.join('; ')}` : ''}` : ''}.`);
  process.exitCode = 1;
}

const modelCost = (result: SDKResultMessage | undefined) => `model $${(result?.total_cost_usd ?? 0).toFixed(4)} (SDK estimate)`;

/**
 * The setup run: the model turns the request into a box, a screen and an inbound address with the three
 * paid tools, and the run ends with one spend line: what settled, what was reserved, and what the model cost.
 * It exits non-zero when the spend cap stopped it.
 */
export async function runSetup({ request, config, query = sdkQuery, fetchFn, log }: { request: string; config: Config; query?: Query; fetchFn: typeof fetch; log: Log }) {
  const arcgate = await connectArcgate({ config, fetchFn, log, paidTools: config.paidTools });
  try {
    const abortController = new AbortController();
    const server = arcgateServer({ arcgate, toolsList: await arcgate.listTools(), config, mode: 'setup', log, abort: () => abortController.abort() });
    let result: SDKResultMessage | undefined;
    try {
      result = await runQuery(query, request, buildQueryOptions({ config, mode: 'setup', server, abortController }));
      if (abortController.signal.aborted) {
        log('The spend cap stopped the run: nothing past it was paid.');
        process.exitCode = 1;
      }
      report(result, log);
    } finally {
      const settled = arcgate.settled.reduce((sum, payment) => sum + payment.amount, 0n);
      log(`spent: x402 ${settled} base units (${formatUnits(settled, 6)} USDC) in ${arcgate.settled.length} payment${arcgate.settled.length === 1 ? '' : 's'} (${arcgate.budget.reserved} reserved under a cap of ${config.maxPerRun}); ${modelCost(result)}`);
    }
  } finally {
    await arcgate.close();
  }
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The watch loop: poll the box with the one list call, and for a page with messages run one query that
 * summarises them and deletes what it summarised. An empty page starts no query. Nothing is paid.
 * With `once` it stops after the first handled batch.
 */
export async function runWatch({ config, query = sdkQuery, fetchFn = globalThis.fetch, log = console.log, once = false, pollMs = 30_000, sleep = sleepFor }: {
  config: Config; query?: Query; fetchFn?: typeof fetch; log?: Log; once?: boolean; pollMs?: number; sleep?: (ms: number) => Promise<void>;
}) {
  const arcgate = await connectArcgate({ config, fetchFn, log, paidTools: [] });
  try {
    const toolsList = await arcgate.listTools();
    let cursor: number | undefined;
    for (;;) {
      const page = await readPage(arcgate, { cursor });
      if (page.messages.length > 0) {
        log(`The box holds ${page.messages.length} new ${page.messages.length === 1 ? 'message' : 'messages'}.`);
        const abortController = new AbortController();
        const server = arcgateServer({ arcgate, toolsList, config, mode: 'watch', log, abort: () => abortController.abort() });
        const prompt = 'The box has new messages. Read them, summarise each one for me, and delete each one you summarised.';
        const result = await runQuery(query, prompt, buildQueryOptions({ config, mode: 'watch', server, abortController }));
        report(result, log);
        log(modelCost(result));
        cursor = page.nextCursor;
        if (once) return;
      }
      await sleep(pollMs);
    }
  } finally {
    await arcgate.close();
  }
}
