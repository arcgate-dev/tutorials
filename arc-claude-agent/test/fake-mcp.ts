// The only network test double: a `fetch` for StreamableHTTPClientTransport's `fetch` option (and for the
// capture's one post to an inbound address) that plays the arcgate server. It answers each JSON-RPC
// request with a captured localnet response, verbatim: only the JSON-RPC id is rewritten to match the
// request (the GET answer's id is null and stays so). It answers the SDK's GET /mcp (Accept:
// text/event-stream) with the 405 the server sends, because the server offers no event stream.
//
// A tools/call is answered by tool name, then by phase:
//  - a tool that takes payment (boxCreate, watchCreate, inboundCreate) is 'unpaid' without
//    params._meta["x402/payment"] and 'paid' with it;
//  - an owner call (boxStatus, watchList, boxMessageList, boxMessageDelete) is 'signed' and must carry
//    agentSignature: the fake throws when it does not, so an unsigned owner call fails the test.
//
// It models the state the answers depend on. The box is present (the shared payer has one), so a paid
// boxCreate answers box_exists. The inbox holds the captured page: once every message in it is deleted by
// a signed boxMessageDelete, the next boxMessageList answers the captured empty page. A delete of a seq the
// page does not hold throws. The inbound address's secret is the fake's own, `secret`, in place of the
// captured '<redacted>'. It records every request on one timeline, together with the lines tests log
// through `log`, so a test can say what was sent and when.
import { captured, fixture, PAYMENT_META } from './support.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Phase = 'unpaid' | 'paid' | 'signed';
/** Whether the inbox starts with the captured page or with the captured empty page. */
export type Inbox = 'messages' | 'empty';

export interface RequestEvent {
  kind: 'request';
  url: string;
  method: string;
  tool?: string;
  args?: Json;
  meta?: Json;
  /** The tools/call carries a payment in _meta["x402/payment"]. */
  paid?: boolean;
  /** The headers and body of a post to the inbound address. */
  headers?: Record<string, string>;
  body?: string;
}
export interface LogEvent {
  kind: 'log';
  line: string;
}
export type TimelineEvent = RequestEvent | LogEvent;

const PAYABLE: Record<string, [string, string]> = {
  boxCreate: ['box-create.payment-required', 'box-create.exists'],
  watchCreate: ['watch-create.payment-required', 'watch-create.paid'],
  inboundCreate: ['inbound-create.payment-required', 'inbound-create.paid'],
};
const OWNER: Record<string, string> = {
  boxStatus: 'box-status',
  watchList: 'watch-list',
  boxMessageList: 'box-message-list',
  boxMessageDelete: 'box-message-delete',
};

export const INBOUND_SECRET = 'test-inbound-secret-0123456789';

export function fakeMcp({ inbox = 'messages' }: { inbox?: Inbox } = {}) {
  const timeline: TimelineEvent[] = [];
  const overrides = new Map<string, Json>();
  const deleted = new Set<number>();
  const page = captured('box-message-list');
  const listed: number[] = page.structuredContent.messages.map((m: Json) => m.seq);

  function reply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function answerFor(tool: string, phase: Phase, args: Json): Json {
    const override = overrides.get(`${tool}:${phase}`);
    if (override) return override;
    if (tool in PAYABLE) {
      const result = structuredClone(captured(PAYABLE[tool][phase === 'unpaid' ? 0 : 1]));
      if (tool === 'inboundCreate' && phase === 'paid') {
        result.structuredContent.secret = INBOUND_SECRET;
        result.content[0].text = JSON.stringify(result.structuredContent);
      }
      return result;
    }
    if (tool === 'boxMessageList') {
      const empty = inbox === 'empty' || listed.every((seq) => deleted.has(seq));
      return captured(empty ? 'box-message-list.empty' : 'box-message-list');
    }
    if (tool === 'boxMessageDelete') {
      if (!listed.includes(args.seq)) throw new Error(`fake-mcp: a delete of seq ${args.seq}, which the page does not hold`);
      deleted.add(args.seq);
    }
    return captured(OWNER[tool]);
  }

  async function fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      // The SDK's GET asks for an event stream; the server answers 405 and the SDK stops.
      timeline.push({ kind: 'request', url, method: 'GET' });
      return reply(fixture('mcp-get.event-stream'), 405);
    }
    if (!url.endsWith('/mcp')) {
      // A sender posting to an inbound address with the secret in INBOUND-SECRET.
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      timeline.push({ kind: 'request', url, method, headers, body: String(init?.body) });
      const inboundUrl = captured('inbound-create.paid').structuredContent.url;
      if (method !== 'POST' || url !== inboundUrl) return reply({ error: { code: 'not_found' } }, 404);
      if (headers['inbound-secret'] !== INBOUND_SECRET) return reply({ error: { code: 'unauthorized' } }, 401);
      // What arcgate answers a stored inbound post (apps/notifier/src/admission.ts:58, sent through res.status(...).json(...) by
      // notifier/src/inbound.ts): 201 and {stored: true, idempotencyKey}. The key is the one on the captured page's inbound message.
      const { messages } = captured('box-message-list').structuredContent;
      const stored = messages.find((m: Json) => m.kind === 'inbound') ?? messages[0];
      return reply({ stored: true, idempotencyKey: stored.idempotencyKey }, 201);
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
    event.tool = tool;
    event.args = args;
    event.paid = meta?.[PAYMENT_META] !== undefined;
    if (meta) event.meta = meta;
    let phase: Phase;
    if (tool in OWNER) {
      if (args.agentSignature === undefined) throw new Error(`fake-mcp: ${tool} was called without agentSignature`);
      phase = 'signed';
    } else {
      phase = event.paid ? 'paid' : 'unpaid';
    }
    if (!(tool in OWNER) && !(tool in PAYABLE) && !overrides.has(`${tool}:${phase}`)) throw new Error(`fake-mcp has no ${phase} answer for ${tool}`);
    return answer(answerFor(tool, phase, args));
  }

  return {
    /** Pass as `fetchFn` to connectArcgate and the capture. */
    fetch: fetchFn,
    timeline,
    /** The secret the fake's inbound address was made with, and the one it accepts. */
    secret: INBOUND_SECRET,
    /** Pass as `log`: the lines join the request timeline. */
    log(line: string) {
      timeline.push({ kind: 'log', line });
    },
    /** Answer a tool's call (unpaid, paid or signed) with this JSON-RPC result instead of the captured one. */
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
    /** The tools/call requests of one tool, in order. */
    callsOf(tool: string): RequestEvent[] {
      return this.toolCalls().filter((e) => e.tool === tool);
    },
    /** The tools/call requests that carry a payment in _meta["x402/payment"]. */
    paidCalls(): RequestEvent[] {
      return this.toolCalls().filter((e) => e.paid);
    },
  };
}
