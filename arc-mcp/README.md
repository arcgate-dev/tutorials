# Use Arcgate as a paid MCP server

Connect an MCP client to Arcgate's MCP server at `/mcp`, list its 32 tools, call the free ones, and pay for three paid ones (`tradeSearch`, `tradeQuote`, `boxCreate`) with x402 on Arc. Then point a host such as Claude Code at the same server and see what a host that cannot pay gets.

## Vocabulary

- **MCP server**: a service that offers tools to an AI host over JSON-RPC. Arcgate's is `POST /mcp`, Streamable HTTP, and lists the same operations as its REST API.
- **Host**: the program that runs an MCP client for a model: Claude Code, Claude Desktop, Cursor.
- **x402 over MCP**: a paid tool answers its first call with an error result that holds the price (`isError: true`, an `accepts` list). The client signs a payment and calls again with it in `_meta["x402/payment"]`. The answer carries a receipt in `_meta["x402/payment-response"]`.
- **Receipt**: the settlement the server reports: success, the network, the transaction hash and the payer.
- **Agent signature**: `boxStatus` takes no payment. It takes an EIP-712 `AgentRequest` signed by the box's own address.

## Before you start

- **Node.js 22.18 or newer** and npm.
- **A payer key** in `.env`: a throwaway key with at least 0.07 USDC on Arc testnet (`eip155:5042002`), where the localnet settles. Payments are EIP-3009 authorizations the facilitator submits, so the client reads no chain and needs no RPC URL.
- **An agent key** in `.env`, for an address with no box. A box is for good (a second `boxCreate` answers `box_exists`), so use a key you can spare. It signs and holds no funds. It may be the payer's key.

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
API_URL=http://127.0.0.1:19800
```

`API_URL` defaults to `https://api.arcgate.dev`. It is an origin: https, or http for `localhost` and `127.0.0.1`, with no credentials or path. The tutorial adds `/mcp`. Production does not yet serve `/agent/v1`, so the box steps run against an arcgate localnet (`pnpm localnet` in the arcgate checkout), which settles x402 on Arc testnet.

## Run it

```sh
npm start
```

The tour does this, in order:

1. `tools/list`: prints the count and every tool name, in the order the server lists them.
2. `health` and `tradeVenues`, free.
3. `tradeSearch` for `cirBTC` and `tradeQuote` for 1 USDC to cirBTC, each paid once.
4. A signed `boxStatus` for the agent address. A 200 means the box exists and is the box. A 404 `box_not_found` leads to `boxCreate`, paid once, then a signed `boxStatus` that answers 200.

Each paid call prints its price before the paid request is sent and its receipt after:

```
price: tradeSearch 5000 base units (0.005 USDC) on eip155:5042002 to 0x987F719b516f528f4080EF0853E37aD5d7E773A0
receipt: tradeSearch tx 0x0a1eb651256ffd8b14228c741fc89847747ac4ab858f06e2fe7e77614273ba51 on eip155:5042002 payer 0x06E594c677Cd28643B82477B7B5328Ac6817b2A0
```

A paid `boxCreate` for an address that already has a box is answered `box_exists`. Nothing is charged for it: the result carries no receipt and the tour prints `not charged: boxCreate box_exists` and goes on. Any other error result stops the tour with its code and its `next`.

## How the payment is kept in check

- `connectArcgate` (`src/mcp.ts`) wraps the MCP SDK client in an `x402MCPClient` with `ExactEvmScheme` registered for both Arc networks.
- `selectOffer` (`src/payment.ts`) is the one choice of offer. The x402 client uses it as its selector, and the same offer is reserved against the budget and priced. An offer on another network, asset, scheme or timeout, or with a zero or over-cap amount, is never signed.
- Caps: 0.05 USDC per call, 0.07 USDC per run. Every signed payment stays reserved, even one the server then answers with an error, because a signed authorization can still settle.
- A tool outside `tradeSearch`, `tradeQuote` and `boxCreate` is never paid, even when it asks.
- A success without a receipt throws `payment may have settled; no receipt`. A receipt that failed, or is on another network than the one signed, is refused.
- `src/agent.ts` signs `boxStatus`: domain `arcgate` version `1` with no `chainId`, `GET /agent/v1/<lowercased address>/box/status`, an empty body, a random nonce, an expiry 60 seconds out.

## Use it from a host

`mcp.json` declares the server for a host:

```json
{ "mcpServers": { "arcgate": { "type": "http", "url": "https://api.arcgate.dev/mcp" } } }
```

For Claude Code:

```sh
claude mcp add --transport http arcgate https://api.arcgate.dev/mcp
```

The free tools work at once. A host that cannot pay gets the price instead of a result. Against the localnet, a host that called `tradeSearch` with query `cirBTC` got (`.runs` log, trimmed):

```
{"x402Version":2,"error":"Payment required to access this tool","resource":{"url":"mcp://tool/tradeSearch",...},"accepts":[{"scheme":"exact","network":"eip155:5042002","amount":"5000","asset":"0x3600000000000000000000000000000000000000","payTo":"0x987F719b516f528f4080EF0853E37aD5d7E773A0","maxTimeoutSeconds":300,"extra":{"name":"USDC","version":"2"}}]}
```

That is a 402 as a tool result: the host shows it to the model and stops. Paying needs a client that signs, such as the one in this tutorial.

## Tests and fixtures

```sh
npm test
```

runs offline: `test/fake-mcp.ts` answers with the responses in `test/fixtures`, which `npm run capture` records from the localnet (see `test/fixtures/README.md`). It writes all 15 files or none, and stops before paying anything when the agent already has a box.

## Validation

See `VALIDATION.md` for the localnet run, the transactions and the balances.
