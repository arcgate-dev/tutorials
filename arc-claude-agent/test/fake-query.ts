// The stand-in for the Agent SDK's `query()`: no test calls the real one. It takes the options the bot
// built, and plays the model with a script that calls the bot's own tools. The calls go through the
// MCP server in options.mcpServers.arcgate (the bridge's real server, over an in-memory transport), so
// the model-facing schema validation and the handlers run as they would. A call to a tool outside
// options.allowedTools is refused as permissionMode dontAsk refuses it. The stream ends with one typed
// SDKResultMessage.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ToolOut {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}
export type Call = (tool: string, args?: Record<string, unknown>) => Promise<ToolOut>;
export interface Played {
  /** The model's final text. */
  result: string;
  /** error_during_execution when the query was aborted; success otherwise. */
  subtype?: 'success' | 'error_during_execution';
}
export type Script = (play: { call: Call; options: Json; prompt: unknown }) => Promise<Played>;

export const MODEL_COST = 0.0123;

/** A typed SDKResultMessage: the fields the bot reads are real, the rest are the SDK's required filler. */
export function resultMessage({ result, subtype = 'success' }: Played, totalCostUsd = MODEL_COST): SDKResultMessage {
  const common = {
    type: 'result',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== 'success',
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: totalCostUsd,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: 'test-session',
  };
  return (subtype === 'success' ? { ...common, subtype, result } : { ...common, subtype, errors: [result] }) as unknown as SDKResultMessage;
}

export function fakeQuery(script: Script) {
  const calls: { prompt: unknown; options: Json }[] = [];
  /** What each tool call returned to the model, in order. */
  const seen: { tool: string; out: ToolOut }[] = [];

  function query({ prompt, options }: { prompt: unknown; options: Json }) {
    calls.push({ prompt, options });
    return (async function* () {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await options.mcpServers.arcgate.instance.connect(serverSide);
      const client = new Client({ name: 'fake-model', version: '0.0.0' });
      await client.connect(clientSide);
      try {
        const call: Call = async (tool, args = {}) => {
          if (!options.allowedTools.includes(`mcp__arcgate__${tool}`)) throw new Error(`permission denied by dontAsk: ${tool} is not in allowedTools`);
          const out = (await client.callTool({ name: tool, arguments: args })) as ToolOut;
          seen.push({ tool, out });
          return out;
        };
        yield resultMessage(await script({ call, options, prompt }));
      } finally {
        await client.close();
      }
    })();
  }

  return { query, calls, seen };
}
