# Use Arcgate as a paid MCP server

Connect an MCP client to Arcgate's `/mcp` endpoint at `https://api.arcgate.dev/mcp`, list its 32 tools, call the free ones, and pay for three paid ones (`tradeSearch`, `tradeQuote`, `boxCreate`) with x402 in real USDC on Arc mainnet (`eip155:5042`). Then point a host (Claude Code, Claude Desktop or Codex) at the same server and see what a host that cannot pay gets.

## Vocabulary

- **MCP server**: a service that offers tools to an AI host over JSON-RPC. Arcgate's is `POST /mcp`, Streamable HTTP, and lists the same operations as its REST API.
- **Host**: the program that runs an MCP client for a model: Claude Code, Claude Desktop, Codex.
- **x402 over MCP**: a paid tool answers its first call with an error result that holds the price (`isError: true`, an `accepts` list). The client signs a payment and calls again with it in `_meta["x402/payment"]`. The answer carries a receipt in `_meta["x402/payment-response"]`.
- **Receipt**: the settlement the server reports: success, the network, the transaction hash and the payer.
- **Agent signature**: `boxStatus` takes no payment. It takes an EIP-712 `AgentRequest` signed by the box's own address.

## What it costs

The prices are the `x-payment` entries in arcgate's OpenAPI document, `https://api.arcgate.dev/openapi.json`, as of 2026-10-08. Check them there before you run; the tutorial prints each price before it pays.

| Tool | Price (USDC base units, 6 decimals) | USDC |
| --- | --- | --- |
| `tradeSearch` | 5000 | 0.005 |
| `tradeQuote` | 10000 | 0.01 |
| `boxCreate` | 50000 | 0.05 |

`npm start` pays `tradeSearch` and `tradeQuote` every run, and `boxCreate` once, on the first run for an agent address with no box: 0.065 USDC the first time, 0.015 USDC after that. All other tools in the tour are free.

## Before you start

- **Node.js 22.18 or newer** and npm.
- **A payer key** in `.env`: a throwaway key with USDC on Arc mainnet (`eip155:5042`). Fund it with at least 0.07 USDC for `npm start`, or 0.115 USDC if you will run `npm run capture` (see [Tests and fixtures](#tests-and-fixtures)). Arc's gas token is USDC, but the payer pays no gas: payments are EIP-3009 authorizations the facilitator submits, so the client reads no chain and needs no RPC URL.
- **An agent key** in `.env`. Its address gets a box on the first run (`boxCreate`, 0.05 USDC) and keeps it. A box is for good (a second `boxCreate` answers `box_exists`), so use a key you can spare. It signs and holds no funds. It may be the payer's key.
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

`API_URL` is optional and defaults to `https://api.arcgate.dev`. It is an https origin, with no credentials or path. The tutorial adds `/mcp`, so the server is `https://api.arcgate.dev/mcp`.

## Run it

```sh
npm start
```

The tour does this, in order:

1. `tools/list`: prints the count and every tool name, in the order the server lists them.
2. `health` and `tradeVenues`, free.
3. `tradeSearch` for `cirBTC` and `tradeQuote` for 1 USDC to cirBTC, each paid once.
4. A signed `boxStatus` for the agent address. A 200 means the box exists and is the box. A 404 `box_not_found` leads to `boxCreate`, paid once, then a signed `boxStatus` that answers 200.

Each paid call prints its price before the paid request is sent and its receipt after. Here is a run on mainnet on 2026-10-08, for an agent address with no box yet (trimmed: the tool list is cut after its first names):

```
tools/list: 32 tools
- tradeSearch
- tradeQuote
- tradeSwap
...
health: ok
tradeVenues: ok
price: tradeSearch 5000 base units (0.005 USDC) on eip155:5042 to 0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
receipt: tradeSearch tx 0x9032eaf3cac0d1f7a9259bbb55e492ecbc6cce20e056b9065d1ff5123d4478bb on eip155:5042 payer 0x81c7b8b66935138bd3bb138e5975a6b75cda4a1d
tradeSearch: ok
price: tradeQuote 10000 base units (0.01 USDC) on eip155:5042 to 0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
receipt: tradeQuote tx 0x2d37d4f306050cc9cbdf2ee3737caf0b0ae8bc7c8e3816d532564605de50baaf on eip155:5042 payer 0x81c7b8b66935138bd3bb138e5975a6b75cda4a1d
tradeQuote: ok
boxStatus: 0x81C7b8B66935138Bd3bb138E5975A6b75CdA4a1D has no box
price: boxCreate 50000 base units (0.05 USDC) on eip155:5042 to 0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
receipt: boxCreate tx 0x1eceb79be694a36541698d227362d04d63a40f58ad56584de3d00fe2f35c4800 on eip155:5042 payer 0x81c7b8b66935138bd3bb138e5975a6b75cda4a1d
boxStatus: 0x81C7b8B66935138Bd3bb138E5975A6b75CdA4a1D has a box
```

Each `tx` is a USDC transfer on Arc mainnet from your payer to the `payTo` address in the price line. Look it up on an Arc mainnet explorer, or with `eth_getTransactionReceipt` on `https://rpc.mainnet.arc.io`.

Run it again with the same agent and the box is already there, so only the search and the quote are paid (0.015 USDC):

```
price: tradeSearch 5000 base units (0.005 USDC) on eip155:5042 to 0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
receipt: tradeSearch tx 0xd9c44eafc7e33f03351911b01411b4dc65e7848b0996e65de420d5463da7a500 on eip155:5042 payer 0x81c7b8b66935138bd3bb138e5975a6b75cda4a1d
tradeSearch: ok
price: tradeQuote 10000 base units (0.01 USDC) on eip155:5042 to 0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
receipt: tradeQuote tx 0x327d43b5116d606ad38375c215a42c3d155a051a6a01d0f6b239e654bf9a621c on eip155:5042 payer 0x81c7b8b66935138bd3bb138e5975a6b75cda4a1d
tradeQuote: ok
boxStatus: 0x81C7b8B66935138Bd3bb138E5975A6b75CdA4a1D has a box, and that is the box
```

When a paid call comes back as an error, the tutorial tells you what that means for your money:

- `not charged: <tool> <code>`: the server refused the call after the payment was sent, for a reason of its own such as `box_exists`. The result carries no receipt and nothing settled. The tour prints it and goes on for `box_exists`, and stops for any other code with its code and its `next`.
- `not settled: <tool> payment_required (check the balance before running again)`: the payment did not settle cleanly. The facilitator may have broadcast the authorization before it failed, and the authorization stays valid for its `maxTimeoutSeconds`, so the tutorial cannot say that no money moved. The line also covers a settlement that fails with `payment_response_expired`. Read your USDC balance before you run again.
- `<tool>: no answer after the payment was sent (...); the payment may have settled. Check the transaction or your USDC balance before paying again.`: a signed paid call got an HTTP 502 or no answer at all. The tutorial throws this and the run stops. The payment stays reserved against the run's cap, and nothing is sent again.

In all these cases the payment stays reserved against the run's cap. The same advice holds when a call stops with `payment may have settled; no receipt`: check the balance before you run again.

## The box: boxStatus first

A box is an agent's inbound address and message store, and it is for good: a second `boxCreate` for the same address answers `box_exists`. So the tour does not pay for `boxCreate` first. It asks `boxStatus`, which is free and takes no payment, but must be signed by the box's own address (`src/agent.ts`).

`boxStatus` takes `{ address, agentSignature: { signature, nonce, expiry } }`. The signature is an EIP-712 `AgentRequest` over `GET /agent/v1/<lowercased address>/box/status`, with an empty body, signed by `AGENT_PRIVATE_KEY`, not the payer's key. The nonce is random and the server accepts each once. The server also limits the expiry (no further than 300 seconds ahead, per arcgate's OpenAPI document, or the answer is 401 `signature_expired`; `src/agent.ts` signs 60 seconds ahead). What comes back, all captured from api.arcgate.dev in `test/fixtures`:

- Without a signature: a 401 `signature_required` result (`box-status.signature-required.json`), `next` is `fix_request`.
- Signed, for an address with no box: a 404 `box_not_found` result (`box-status.not-found.json`). The tour then pays `boxCreate` once and signs `boxStatus` again, with a fresh nonce.
- Signed, for an address with a box: the box, with its `address`, `createdAt`, `allowance`, `counts`, `unstoredWatchHits` (a number) and `registeredAgents` (`{ chainId, agents }`) (`box-status.json`). That box is the box: the tour calls and pays no `boxCreate`.
- A paid `boxCreate` for an address that already has a box: a `box_exists` result, `next` is `stop`, and no receipt (`box-create.exists.json`). `box_exists` answers for the address the tour sent, which is the agent's own, so that box is the box and the tour goes on. Nothing settles.

Any other `boxStatus` refusal, such as `signature_expired` or `nonce_reused`, stops the tour before `boxCreate` is paid.

## How the payment is kept in check

- `connectArcgate` (`src/mcp.ts`) wraps the MCP SDK client in an `x402MCPClient` with `ExactEvmScheme` registered for each network in `src/config.ts`, so it pays the Arc mainnet (`eip155:5042`) offer that api.arcgate.dev makes.
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

That adds it to your local settings. With `--scope project` it writes the same JSON as `mcp.json` to `.mcp.json` in the project, and Claude Code asks you to approve the server the next time it starts there.

**Codex**:

```sh
codex mcp add arcgate --url https://api.arcgate.dev/mcp
```

That writes `[mcp_servers.arcgate]` with `url = "https://api.arcgate.dev/mcp"` to `~/.codex/config.toml`. MCP tool calls need your approval: a non-interactive `codex exec` refuses them unless you pass `-c mcp_servers.arcgate.default_tools_approval_mode="approve"`.

**Claude Desktop**: add Arcgate as a custom connector with the URL `https://api.arcgate.dev/mcp`. Anthropic's help page walks through it: [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

The free tools work at once. A host that cannot pay gets the price instead of a result, and it spends nothing. To check that, run Claude Code from this directory with only `mcp.json` as its server list and only the free tool and `tradeSearch` allowed (prompt first, because `--allowedTools` takes a list):

```sh
claude -p 'call the arcgate health tool, then tradeSearch with query cirBTC; report each raw result' --strict-mcp-config --mcp-config mcp.json --allowedTools mcp__arcgate__health,mcp__arcgate__tradeSearch
```

On 2026-10-08 the host connected, `health` returned `ok: true` with `x402.network` `eip155:5042`, and `tradeSearch` with query `cirBTC` got this (trimmed to the result):

```
{"x402Version":2,"error":"Payment required to access this tool","resource":{"url":"mcp://tool/tradeSearch","description":"Tool: tradeSearch","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:5042","amount":"5000","asset":"0x3600000000000000000000000000000000000000","payTo":"0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e","maxTimeoutSeconds":300,"extra":{"name":"USDC","version":"2"}}]}
```

Codex got the same result from `codex exec -c 'mcp_servers.arcgate.default_tools_approval_mode="approve"' 'Call the arcgate MCP tool tradeSearch with query cirBTC once. Print its raw result text verbatim and nothing else.'` with the server added as above. That is a 402 as a tool result: the host shows it to the model and stops. Paying needs a client that signs, such as the one in this tutorial.

## Tests and fixtures

```sh
npm test
```

runs offline: `test/fake-mcp.ts` answers with the responses in `test/fixtures`, which `npm run capture` records from api.arcgate.dev (see `test/fixtures/README.md`). It writes all 15 files or none, and stops before paying anything when the agent already has a box.

You don't need to run the capture to follow the tutorial. It spends real USDC: it is two connections, each with its own budget, the tour and then a second `boxCreate` for the `box_exists` answer. It signs up to 0.115 USDC (5000 + 10000 + 50000 + 50000 base units) and settles 0.065 (65000 base units): the second `boxCreate` is signed but not charged. Fund the payer with at least 0.115 USDC, and use an agent address with no box, so run it before `npm start` creates one. `npm start` alone is one connection, under 0.07 USDC.

## Validation

See `VALIDATION.md` for the mainnet run, the transactions and the balances.
