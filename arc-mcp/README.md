# Use Arcgate as a paid MCP server

Connect an MCP client to Arcgate's `/mcp` endpoint, list its 32 tools, call the free ones, and pay for three paid ones (`tradeSearch`, `tradeQuote`, `boxCreate`) with x402 on Arc. Then point a host (Claude Code, Claude Desktop or Codex) at the same server and see what a host that cannot pay gets.

## Vocabulary

- **MCP server**: a service that offers tools to an AI host over JSON-RPC. Arcgate's is `POST /mcp`, Streamable HTTP, and lists the same operations as its REST API.
- **Host**: the program that runs an MCP client for a model: Claude Code, Claude Desktop, Codex.
- **x402 over MCP**: a paid tool answers its first call with an error result that holds the price (`isError: true`, an `accepts` list). The client signs a payment and calls again with it in `_meta["x402/payment"]`. The answer carries a receipt in `_meta["x402/payment-response"]`.
- **Receipt**: the settlement the server reports: success, the network, the transaction hash and the payer.
- **Agent signature**: `boxStatus` takes no payment. It takes an EIP-712 `AgentRequest` signed by the box's own address.

## Before you start

- **Node.js 22.18 or newer** and npm.
- **A payer key** in `.env`: a throwaway key with USDC on Arc (`eip155:5042` for api.arcgate.dev, where paid calls cost real USDC). `npm start` is one connection and spends under 0.07 USDC. `npm run capture` is two connections: it signs up to 0.115 USDC (5000 + 10000 + 50000 + 50000 base units), settles about 0.065 and needs an agent address with no box, so fund 0.115 USDC to be safe. Payments are EIP-3009 authorizations the facilitator submits, so the client reads no chain and needs no RPC URL.
- **An agent key** in `.env`, for an address with no box. A box is for good (a second `boxCreate` answers `box_exists`), so use a key you can spare. It signs and holds no funds. It may be the payer's key.
- **One box per address.** The box belongs to `AGENT_PRIVATE_KEY`'s address. One wallet address means one box, shared by every tutorial run with the same key (arc-agent-box, arc-claude-agent), and arc-agent-box's cleanup deletes every watch and inbound address in it.

```sh
git clone https://github.com/arcgate-dev/tutorials.git
cd tutorials/arc-mcp
npm ci
cp .env.example .env
```

Edit `.env`:

```sh
PRIVATE_KEY=0x...
AGENT_PRIVATE_KEY=0x...
```

`API_URL` defaults to `https://api.arcgate.dev`. It is an origin: https, or http for `localhost` and `127.0.0.1`, with no credentials or path. The tutorial adds `/mcp`, so the server is `https://api.arcgate.dev/mcp`.

## Run it

```sh
npm start
```

The tour does this, in order:

1. `tools/list`: prints the count and every tool name, in the order the server lists them.
2. `health` and `tradeVenues`, free.
3. `tradeSearch` for `cirBTC` and `tradeQuote` for 1 USDC to cirBTC, each paid once.
4. A signed `boxStatus` for the agent address. A 200 means the box exists and is the box. A 404 `box_not_found` leads to `boxCreate`, paid once, then a signed `boxStatus` that answers 200.

Each paid call prints its price before the paid request is sent and its receipt after. The three paid tools, from a run on a fresh agent (`.runs/capture-2026-10-07.log`), were captured on the arcgate localnet, which settles on Arc testnet (`eip155:5042002`); `api.arcgate.dev` offers `eip155:5042` (Arc mainnet):

```
price: tradeSearch 5000 base units (0.005 USDC) on eip155:5042002 to 0x987F719b516f528f4080EF0853E37aD5d7E773A0
receipt: tradeSearch tx 0x6ef3dc3df08b39fc78ee3c10e24932b1580098249d1a6cd0d47ff8afe3f10b37 on eip155:5042002 payer 0x06E594c677Cd28643B82477B7B5328Ac6817b2A0
price: tradeQuote 10000 base units (0.01 USDC) on eip155:5042002 to 0x987F719b516f528f4080EF0853E37aD5d7E773A0
receipt: tradeQuote tx 0x6f1edec1f1fd2fe4275f8976b48eed887eb7d021961de2b0e16b8ae4ab32a74b on eip155:5042002 payer 0x06E594c677Cd28643B82477B7B5328Ac6817b2A0
price: boxCreate 50000 base units (0.05 USDC) on eip155:5042002 to 0x987F719b516f528f4080EF0853E37aD5d7E773A0
receipt: boxCreate tx 0x33cefeeac0e61f343db456c945954d8d54b5f3bdca26ae3a32939ec367d7d488 on eip155:5042002 payer 0x06E594c677Cd28643B82477B7B5328Ac6817b2A0
```

`tradeSearch` is 5000 base units, `tradeQuote` 10000 and `boxCreate` 50000 (6 decimals, so 0.005, 0.01 and 0.05 USDC). The localnet lists 32 tools.

When a paid call comes back as an error, the tutorial tells you what that means for your money:

- `not charged: <tool> <code>`: the server refused the call after the payment was sent, for a reason of its own such as `box_exists`. The result carries no receipt and nothing settled. The tour prints it and goes on for `box_exists`, and stops for any other code with its code and its `next`.
- `not settled: <tool> payment_required (check the balance before running again)`: the payment did not settle cleanly. The facilitator may have broadcast the authorization before it failed, and the authorization stays valid for its `maxTimeoutSeconds`, so the tutorial cannot say that no money moved. The line also covers a settlement that fails with `payment_response_expired`. Read your USDC balance before you run again.
- `<tool>: no answer after the payment was sent (...); the payment may have settled. Check the transaction or your USDC balance before paying again.`: a signed paid call got an HTTP 502 or no answer at all. The tutorial throws this and the run stops. The payment stays reserved against the run's cap, and nothing is sent again.

In all these cases the payment stays reserved against the run's cap. The same advice holds when a call stops with `payment may have settled; no receipt`: check the balance before you run again.

## The box: boxStatus first

A box is an agent's inbound address and message store, and it is for good: a second `boxCreate` for the same address answers `box_exists`. So the tour does not pay for `boxCreate` first. It asks `boxStatus`, which is free and takes no payment, but must be signed by the box's own address (`src/agent.ts`).

`boxStatus` takes `{ address, agentSignature: { signature, nonce, expiry } }`. The signature is an EIP-712 `AgentRequest` over `GET /agent/v1/<lowercased address>/box/status`, with an empty body, signed by `AGENT_PRIVATE_KEY`, not the payer's key. The nonce is random and the server accepts each once. The server also limits the expiry (no further than 300 seconds ahead, per arcgate's OpenAPI document, or the answer is 401 `signature_expired`; `src/agent.ts` signs 60 seconds ahead). What comes back, all captured from the localnet in `test/fixtures`:

- Without a signature: a 401 `signature_required` result (`box-status.signature-required.json`), `next` is `fix_request`.
- Signed, for an address with no box: a 404 `box_not_found` result (`box-status.not-found.json`). The tour then pays `boxCreate` once and signs `boxStatus` again, with a fresh nonce.
- Signed, for an address with a box: the box, with its `address`, `createdAt`, `allowance`, `counts`, `unstoredWatchHits` (a number) and `registeredAgents` (`{ chainId, agents }`) (`box-status.json`). That box is the box: the tour calls and pays no `boxCreate`.
- A paid `boxCreate` for an address that already has a box: a `box_exists` result, `next` is `stop`, and no receipt (`box-create.exists.json`). `box_exists` answers for the address the tour sent, which is the agent's own, so that box is the box and the tour goes on. Nothing settles.

Any other `boxStatus` refusal, such as `signature_expired` or `nonce_reused`, stops the tour before `boxCreate` is paid.

## How the payment is kept in check

- `connectArcgate` (`src/mcp.ts`) wraps the MCP SDK client in an `x402MCPClient` with `ExactEvmScheme` registered for both Arc networks.
- `selectOffer` (`src/payment.ts`) is the one choice of offer. The x402 client uses it as its selector, and the same offer is reserved against the budget and priced. An offer on another network, asset, scheme or timeout, or with a zero or over-cap amount, is never signed.
- Caps: 0.05 USDC per call, 0.07 USDC per run. The caps apply per connection: `npm start` is one connection, and `npm run capture` opens a second one with its own budget. Every signed payment stays reserved, even one the server then answers with an error, because a signed authorization can still settle.
- A tool outside `tradeSearch`, `tradeQuote` and `boxCreate` is never paid, even when it asks.
- A success without a receipt throws `payment may have settled; no receipt`. A receipt that failed, or is on another network than the one signed, is refused.
- `src/agent.ts` signs `boxStatus`: domain `arcgate` version `1` with no `chainId`, `GET /agent/v1/<lowercased address>/box/status`, an empty body, a random nonce, an expiry 60 seconds out.

## Use it from a host

`mcp.json` declares the server for a host:

```json
{ "mcpServers": { "arcgate": { "type": "http", "url": "https://api.arcgate.dev/mcp" } } }
```

**Claude Code**:

```sh
claude mcp add --transport http arcgate https://api.arcgate.dev/mcp
```

`--scope project` writes the same shape to `.mcp.json` in the project instead of your local settings.

**Codex**:

```sh
codex mcp add arcgate --url https://api.arcgate.dev/mcp
```

**Claude Desktop**: add Arcgate as a custom connector with the URL `https://api.arcgate.dev/mcp`. Anthropic's help page walks through it: [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

The free tools work at once. A host that cannot pay gets the price instead of a result, and it spends nothing. To check that, put the server URL (`https://api.arcgate.dev/mcp`) in a scratch file and run Claude Code with only the free tool and `tradeSearch` allowed (prompt first, because `--allowedTools` takes a list):

```sh
claude -p 'call the arcgate health tool, then tradeSearch with query cirBTC; report each raw result' --strict-mcp-config --mcp-config /tmp/arcgate-mcp.json --allowedTools mcp__arcgate__health,mcp__arcgate__tradeSearch
```

The host connected, `health` returned `ok: true`, and `tradeSearch` with query `cirBTC` got on the arcgate localnet, which settles on Arc testnet (`.runs/host-2026-10-07.log`, trimmed; `api.arcgate.dev` names `eip155:5042`):

```
{"x402Version":2,"error":"Payment required to access this tool","resource":{"url":"mcp://tool/tradeSearch",...},"accepts":[{"scheme":"exact","network":"eip155:5042002","amount":"5000","asset":"0x3600000000000000000000000000000000000000","payTo":"0x987F719b516f528f4080EF0853E37aD5d7E773A0","maxTimeoutSeconds":300,"extra":{"name":"USDC","version":"2"}}]}
```

That is a 402 as a tool result: the host shows it to the model and stops. Paying needs a client that signs, such as the one in this tutorial.

## Tests and fixtures

```sh
npm test
```

runs offline: `test/fake-mcp.ts` answers with the responses in `test/fixtures`, which `npm run capture` records from the localnet (see `test/fixtures/README.md`). It writes all 15 files or none, and stops before paying anything when the agent already has a box.

The capture is two connections, each with its own budget: the tour, then a second `boxCreate` for the `box_exists` answer. It signs up to 0.115 USDC (5000 + 10000 + 50000 + 50000 base units) and settles 0.065 (65000 base units): the second `boxCreate` is signed but not charged. Fund the payer with at least 0.115 USDC, and use an agent address with no box. `npm start` alone is one connection, under 0.07 USDC.

## Validation

See `VALIDATION.md` for the localnet run, the transactions and the balances.
