import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { x402Client } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402MCPClient } from '@x402/mcp';
import { formatUnits } from 'viem';
import { agentSignature, ownerRequest, type OwnerTool } from './agent.ts';
import type { Config } from './config.ts';
import { createBudget, selectOffer } from './payment.ts';

export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** The text of a tool result. */
export function textOf(result: ToolResult): string {
  return result.content.find((item) => item.type === 'text')?.text ?? '';
}

/**
 * The error an arcgate error result carries in its text: { error: { code, message }, next }. A plain string
 * `error` is the x402 wrapper's payment-required result (for example when the settlement failed).
 */
export function errorOf(result: ToolResult): { code: string; message: string; next?: string } {
  const body = JSON.parse(textOf(result) || '{}');
  if (typeof body.error === 'string') return { code: 'payment_required', message: body.error };
  return { code: body.error?.code, message: body.error?.message, next: body.next };
}

/** An error for a tool whose result was not the one the caller needs. */
export function refusal(tool: string, result: ToolResult) {
  const { code, message, next } = errorOf(result);
  return new Error(`${tool} was refused: ${code}: ${message}${next ? ` next ${next}` : ''}`);
}

/** A payment that settled: the tool, the amount of the offer that was signed, and the settlement transaction. */
export interface Settled {
  tool: string;
  amount: bigint;
  transaction: string;
  network: string;
}

/**
 * Connects to the arcgate MCP server over Streamable HTTP, with x402 payment for the tools in `paidTools`
 * and for no other. `fetchFn` is the transport's `fetch`, and `log` receives every line about money: the
 * price before a paid request is sent, the receipt or the refusal after.
 */
export async function connectArcgate({ config, fetchFn, log, paidTools }: { config: Config; fetchFn: typeof fetch; log: (line: string) => void; paidTools: string[] }) {
  const budget = createBudget(config);
  const settled: Settled[] = [];
  const signing: { tool: string; offer?: PaymentRequirements } = { tool: '' }; // the call being paid, and the offer signed for it

  // selectOffer is the one choice: the client signs what it returns, and the hook below reserves and prices that same offer.
  const payment = new x402Client((_version, offers) => {
    const offer = selectOffer(offers, config);
    if (!offer) throw new Error('No payment offer within the policy: Arc network, USDC by exact, within the cap.');
    return offer;
  });
  payment.setSpendControls(false); // the SDK's own asset allowlist and $1 cap would be a second policy: acceptOffer is the one
  for (const network of config.networks) payment.register(network, new ExactEvmScheme(config.account));
  payment.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    budget.reserve(BigInt(offer.amount)); // before the price line: a refused payment announces nothing
    signing.offer = offer;
    log(`price: ${signing.tool} ${offer.amount} base units (${formatUnits(BigInt(offer.amount), 6)} USDC) on ${offer.network} to ${offer.payTo}`);
  });

  const mcp = new x402MCPClient(new Client({ name: 'arc-claude-agent', version: '1.0.0' }), payment, {
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      if (!paidTools.includes(toolName)) throw new Error(`${toolName} asked for payment, and this run pays only for ${paidTools.join(', ') || 'nothing'}.`);
      if (!selectOffer(paymentRequired.accepts, config)) throw new Error(`${toolName} asked for payment, and no offer is within the policy.`);
      return true;
    },
  });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(config.mcpUrl), { fetch: fetchFn }));

  /** A tool call: free, or paid once. An error result is returned, not thrown. */
  async function call(tool: string, args: Record<string, unknown>) {
    signing.tool = tool;
    signing.offer = undefined as PaymentRequirements | undefined; // the hook sets it when a payment is signed
    // A signed payment that gets no answer (an HTTP 502, a failed fetch) may have settled: the reservation stays and nothing is sent again.
    let out;
    try { out = await mcp.callTool(tool, args); }
    catch (error) {
      if (!signing.offer) throw error;
      throw new Error(`${tool}: no answer after the payment was sent (${error instanceof Error ? error.message : String(error)}); the payment may have settled. Check the transaction or your USDC balance before paying again.`);
    }
    const result: ToolResult = { content: out.content as ToolResult['content'], isError: out.isError };
    if (!out.paymentMade) return { result, charged: false as const };
    // The payment is signed and sent: whatever comes back, its reservation stays.
    if (out.isError) {
      const { code } = errorOf(result);
      // payment_required after a payment is a failed settlement: the facilitator may already have broadcast the authorization.
      log(code === 'payment_required' ? `not settled: ${tool} payment_required (check the balance before running again)` : `not charged: ${tool} ${code}`);
      return { result, charged: false as const };
    }
    const receipt = out.paymentResponse;
    if (!receipt) throw new Error(`${tool}: payment may have settled; no receipt came back.`);
    if (!receipt.success || receipt.network !== signing.offer?.network) throw new Error(`${tool}: the receipt is not a settlement on ${signing.offer?.network}.`);
    log(`receipt: ${tool} tx ${receipt.transaction} on ${receipt.network} payer ${receipt.payer}`);
    settled.push({ tool, amount: BigInt(signing.offer.amount), transaction: receipt.transaction, network: receipt.network });
    return { result, charged: true as const, receipt };
  }

  return {
    budget,
    /** Every payment that settled in this connection, in order. */
    settled,
    call,
    /** An owner call, free: the box address is filled in and the one signer signs it over its method, path and body. */
    async owner(tool: OwnerTool, args: { cursor?: number; limit?: number; seq?: number } = {}) {
      const address = config.account.address;
      return call(tool, { address, ...args, agentSignature: await agentSignature(config.account, ownerRequest(tool, address, args)) });
    },
    listTools: () => mcp.listTools(),
    close: () => mcp.close(),
  };
}

export type Arcgate = Awaited<ReturnType<typeof connectArcgate>>;
