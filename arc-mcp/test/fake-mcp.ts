// The only test double: a `fetch` for StreamableHTTPClientTransport's `fetch` option that plays the
// arcgate MCP server. It answers each JSON-RPC request with a captured localnet response, verbatim:
// only the JSON-RPC id is rewritten to match the request (the GET answer's id is null and stays so).
// It answers the SDK's GET /mcp (Accept: text/event-stream) with the 405 the server sends, because the
// server offers no event stream and the SDK stops there. It chooses a tools/call answer by tool
// name, then by whether the call carries a payment in params._meta["x402/payment"] (a tool that
// takes no payment, boxStatus, is chosen by whether it carries agentSignature). It records every
// request on one timeline, together with the lines tests log through `log`, so a test can say what
// was sent and when.
import { captured, fixture, PAYMENT_META } from './support.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Phase = 'unpaid' | 'paid';

export interface RequestEvent {
  kind: 'request';
  url: string;
  method: string;
  tool?: string;
  args?: Json;
  meta?: Json;
  /** The tools/call carries a payment in _meta["x402/payment"]. */
  paid?: boolean;
}
export interface LogEvent {
  kind: 'log';
  line: string;
}
export type TimelineEvent = RequestEvent | LogEvent;

// Captured answers: tool -> phase -> fixture file. boxStatus has no payment: its two answers are
// "without" and "with" agentSignature, which the fake files under 'unpaid' and 'paid'.
const ANSWERS: Record<string, Record<Phase, string>> = {
  health: { unpaid: 'health', paid: 'health' },
  tradeVenues: { unpaid: 'trade-venues', paid: 'trade-venues' },
  tradeSearch: { unpaid: 'trade-search.payment-required', paid: 'trade-search.paid' },
  tradeQuote: { unpaid: 'trade-quote.payment-required', paid: 'trade-quote.paid' },
  boxCreate: { unpaid: 'box-create.payment-required', paid: 'box-create.paid' },
  boxStatus: { unpaid: 'box-status.signature-required', paid: 'box-status' },
};

export function fakeMcp() {
  const timeline: TimelineEvent[] = [];
  const overrides = new Map<string, Json>();

  function reply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  async function fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      // The SDK's GET asks for an event stream; the server answers 405 and the SDK stops.
      timeline.push({ kind: 'request', url, method: 'GET' });
      return reply(fixture('mcp-get.event-stream'), 405);
    }
    const message = JSON.parse(String(init?.body));
    const id = message.id;
    const event: RequestEvent = { kind: 'request', url, method: message.method };
    timeline.push(event);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const answer = (result: Json) => reply({ result, jsonrpc: '2.0', id });
    if (message.method === 'initialize') return reply({ ...fixture('initialize'), id });
    if (message.method === 'tools/list') return reply({ ...fixture('tools-list'), id });
    if (message.method !== 'tools/call') throw new Error(`fake-mcp has no answer for ${message.method}`);
    const tool: string = message.params.name;
    const args: Json = message.params.arguments ?? {};
    const meta: Json | undefined = message.params._meta;
    const paid = tool === 'boxStatus' ? args.agentSignature !== undefined : meta?.[PAYMENT_META] !== undefined;
    event.tool = tool;
    event.args = args;
    event.paid = meta?.[PAYMENT_META] !== undefined;
    if (meta) event.meta = meta;
    const phase: Phase = paid ? 'paid' : 'unpaid';
    const override = overrides.get(`${tool}:${phase}`);
    if (override) return answer(override);
    const file = ANSWERS[tool]?.[phase];
    if (!file) throw new Error(`fake-mcp has no ${phase} answer for ${tool}`);
    return answer(captured(file));
  }

  return {
    /** Pass as `fetchFn` to connectArcgate. */
    fetch: fetchFn,
    timeline,
    /** Pass as `log` to connectArcgate and runTour: the lines join the request timeline. */
    log(line: string) {
      timeline.push({ kind: 'log', line });
    },
    /** Answer a tool's call (unpaid, or paid) with this JSON-RPC result instead of the captured one. */
    set(tool: string, phase: Phase, result: Json) {
      overrides.set(`${tool}:${phase}`, result);
    },
    requests(): RequestEvent[] {
      return timeline.filter((e): e is RequestEvent => e.kind === 'request');
    },
    lines(): string[] {
      return timeline.filter((e): e is LogEvent => e.kind === 'log').map((e) => e.line);
    },
    toolCalls(): RequestEvent[] {
      return this.requests().filter((e) => e.method === 'tools/call');
    },
    /** The tools/call requests that carry a payment in _meta["x402/payment"]. */
    paidCalls(): RequestEvent[] {
      return this.toolCalls().filter((e) => e.paid);
    },
  };
}
