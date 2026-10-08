# Validation

## Mainnet run, 2026-10-08 (UTC), api.arcgate.dev at commit 6e04f6a

`https://api.arcgate.dev`, `/health` `ok: true` at commit `6e04f6ab0a060417c852f87f20980e42a00fa3eb`, `x402.network` `eip155:5042` (Arc mainnet). Prices from `https://api.arcgate.dev/openapi.json` `x-payment` on the same day: `tradeSearch` 5000, `tradeQuote` 10000, `boxCreate` 50000 base units of USDC.

From a clean state in this directory: `npm ci`, a gitignored `.env` with `PRIVATE_KEY` and `AGENT_PRIVATE_KEY` set to the same funded key (payer and agent `0x81C7…4a1D`, an address with no box before this run; no key is recorded here), no `API_URL`. Logs: `.runs/capture-2026-10-08.log`, `.runs/start-2026-10-08.log`, `.runs/host-claude-2026-10-08.log`, `.runs/host-codex-2026-10-08.log` (not committed).

Order. `npm run capture` needs an agent address with no box and `npm start` creates one, and this run had one key, so `npm run capture` ran first (15:14:51Z to 15:15:07Z). Its first connection is the tour `npm start` runs, and it printed the README's first example output. Then `npm start` ran as the README says (15:15:11Z to 15:15:21Z), found the box, and printed the README's second example output. Both listed **32** tools; `health` and `tradeVenues` answered free.

| # | Command | Operation | Price (base units) | Settlement tx |
| --- | --- | --- | --- | --- |
| 1 | `npm run capture` | `tradeSearch` | 5000 | `0x9032eaf3cac0d1f7a9259bbb55e492ecbc6cce20e056b9065d1ff5123d4478bb` |
| 2 | `npm run capture` | `tradeQuote` | 10000 | `0x2d37d4f306050cc9cbdf2ee3737caf0b0ae8bc7c8e3816d532564605de50baaf` |
| 3 | `npm run capture` | `boxCreate` | 50000 | `0x1eceb79be694a36541698d227362d04d63a40f58ad56584de3d00fe2f35c4800` |
| - | `npm run capture` | `boxCreate` again, second connection | 50000 signed | none: `not charged: boxCreate box_exists` |
| 4 | `npm start` | `tradeSearch` | 5000 | `0xd9c44eafc7e33f03351911b01411b4dc65e7848b0996e65de420d5463da7a500` |
| 5 | `npm start` | `tradeQuote` | 10000 | `0x327d43b5116d606ad38375c215a42c3d155a051a6a01d0f6b239e654bf9a621c` |

Every 402 named network `eip155:5042`, asset USDC `0x3600000000000000000000000000000000000000` and payTo `0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e`. Each hash was checked with `eth_getTransactionReceipt` on `https://rpc.mainnet.arc.io`: status `0x1` (blocks 24920302, 24920311, 24920320, 24920341, 24920351), each with a `Transfer` log on `0x3600…0000` from `0x81C7…4a1D` to `0x08A4…7B5e` for exactly the price (`0x1388`, `0x2710`, `0xc350`, `0x1388`, `0x2710`).

Total spent: **80000 base units, 0.08 USDC** (capture 65000, `npm start` 15000). The payer's USDC `balanceOf` read 400000 before, 335000 between the two commands and 320000 after, which reconciles.

The capture rewrote the 15 fixtures from this run (10 files changed; `initialize`, `mcp-get.event-stream`, `box-status.signature-required`, `box-status.not-found` and `box-create.exists` came back identical). The paid quote now carries the server's EIP-712 `attestation.signature`, which `test/fixtures.test.ts` allows as it allows pool ids. `src/config.ts` still accepts Arc testnet (`eip155:5042002`) and an http `API_URL` on localhost or 127.0.0.1, for the localnet build gate; the default stays `https://api.arcgate.dev`.

Host checks, against `https://api.arcgate.dev/mcp`, no payment:

- Verified, Claude Code 2.1.294: `claude mcp add --scope project --transport http arcgate https://api.arcgate.dev/mcp` in a scratch directory wrote a `.mcp.json` equal to `mcp.json`. The README's `claude -p … --strict-mcp-config --mcp-config mcp.json --allowedTools mcp__arcgate__health,mcp__arcgate__tradeSearch` returned `health` `ok: true` (commit `6e04f6a`, `eip155:5042`) and the `tradeSearch` 402 result quoted in the README. Nothing was added to the user-scope Claude config.
- Verified, Codex 0.161.0: `codex mcp add arcgate --url https://api.arcgate.dev/mcp` with `CODEX_HOME` set to a scratch directory wrote `[mcp_servers.arcgate]` `url = "https://api.arcgate.dev/mcp"`, and `codex mcp list` showed it enabled. `codex exec` with the server passed by `-c mcp_servers.arcgate.url=…` called `tradeSearch` and got the same 402 result; without `-c mcp_servers.arcgate.default_tools_approval_mode="approve"` the non-interactive run refused the call ("MCP tool call requires approval, but approval policy is never"). Interactive Codex approval was not exercised.
- Not verified: Claude Desktop's custom connector (no Claude Desktop session from this machine). The README describes it and links Anthropic's help page.

`npm test`: **39** tests passed, 0 failed. `npm run typecheck` printed no diagnostics.

## Production check, 2026-10-08 (UTC)

A free, unpaid, unsigned probe of `https://api.arcgate.dev` at 14:27Z, at commit `6e04f6a`. Source: `.runs/prod-check-20261008T142719Z-41260.log`, not committed.

- `POST https://api.arcgate.dev/mcp` with `initialize` answers 200 `application/json` (protocol `2025-06-18`, server `arcgate`).
- `tools/list` returns **32** tools, the same count as the localnet.
- `/health` is `ok: true`, at commit `6e04f6a`, with `x402.network` `eip155:5042`.

Production now serves `/mcp`, so the 2026-10-07 404 entry below is superseded. No paid tool was called. (Superseded by the mainnet run above: the tutorial now runs on mainnet only.)

## Epic #7 check: localnet run at arcgate 27c0ddb3, 2026-10-08 (UTC)

The epic branch `epic/7` at `41e891b` (origin/main merged, already up to date) ran `npm start` against the arcgate localnet from 14:08:00Z to 14:08:08Z. Every step passed. Source: `.runs/start-epic-1008.log`, not committed.

- API `http://127.0.0.1:19800`, MCP at `http://127.0.0.1:19800/mcp`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `rulesVersion` `r2-383954828c`, `commit: null`. The localnet api container was built at 12:14Z from the arcgate checkout, whose last commit before then is `27c0ddb3` (Circle's Facilitator Service as the x402 facilitator); the service does not confirm it.
- `PRIVATE_KEY` and `AGENT_PRIVATE_KEY` were the same key, address `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. No key is recorded here.
- `tools/list` returned **32** tools. `health` ok, `tradeVenues` ok.
- `tradeSearch`: 5000 base units, settlement `0x5a54cf7fcfd504e473526103be40b91b99c59e9521a5324d26a0d9918188c9a5`.
- `tradeQuote`: 10000 base units, settlement `0x8e2c309803e10be86956c9d2613899965bebb3f5f9549386dbab64968fc96504`.
- `boxStatus` found the existing box, so no `boxCreate` was paid.
- Payer balance 453776 base units before this run; arc-agent-box's run, after arc-claude-agent's, printed 418776, which reconciles with the 15000 spent here and arc-claude-agent's 20000.
- `npm test`: **39** tests passed; `npm run typecheck` printed no diagnostics.

## Epic #7 check: localnet run at arcgate 5addf63f, 2026-10-07 (UTC)

The epic branch `epic/7` at `18adb0a` ran `npm start` against the arcgate localnet from 23:53:24Z to 23:53:32Z. Every step passed. Source: `.runs/start-epic.log`, not committed.

- API `http://127.0.0.1:19800`, MCP at `http://127.0.0.1:19800/mcp`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `commit: null`, so the arcgate checkout is `5addf63f`; the service does not confirm it.
- `PRIVATE_KEY` and `AGENT_PRIVATE_KEY` were the same key, address `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. No key is recorded here.
- `tools/list` returned **32** tools. `health` ok, `tradeVenues` ok.
- `tradeSearch`: 5000 base units, settlement `0xa9a9008828cb699107718bdb3a9ef8efa8469b1c2ceb2be192993dde7cced9c3`.
- `tradeQuote`: 10000 base units, settlement `0xa219c16a03b79a22f59cbe47c40f7980a015eecdb3e2b890b05023531c7dce90`.
- `boxStatus` found the existing box, so no `boxCreate` was paid.
- Payer balance 593776 -> 578776 base units (the next run's start balance), which reconciles with the 15000 spent.
- `npm test`: **39** tests passed; `npm run typecheck` printed no diagnostics.

## Production check, 2026-10-07 (UTC) (superseded by the 2026-10-08 check above)

POST https://api.arcgate.dev/mcp answers HTTP 404 text/html; /health is ok at commit 603c5f1. Production does not serve /mcp.

## Localnet run at arcgate 5addf63f, 2026-10-07 (UTC)

`npm start` ran on October 7, 2026 against an arcgate localnet. Source: `.runs/start-5addf63f.log`.

- API: `http://127.0.0.1:19800`, MCP at `http://127.0.0.1:19800/mcp`. `/health` reports `commit: null` on localnet, so the arcgate checkout is `5addf63f`; the service does not confirm it.
- `PRIVATE_KEY` and `AGENT_PRIVATE_KEY` were the same key, address `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. No key is recorded here.
- `tools/list` returned **32** tools, which matches the fixture and the README.
- `health` ok and `tradeVenues` ok.
- `tradeSearch`: 5000 base units (0.005 USDC), settlement `0x5869d21aa762b3a034d9132748028221ad8fc221a1033544466481340c962878`.
- `tradeQuote`: 10000 base units (0.01 USDC), settlement `0x34a7f0da78b96271f0dda54717345444eaa41609caeed6dccb3f100139ed8049`.
- `boxStatus` found the existing box, so no `boxCreate` was paid.
- Payer balance 733776 -> 718776 base units, which reconciles: 5000 + 10000 = 15000.
- `npm test`: **39** tests passed; `npm run typecheck` is clean.
- `npm run capture` was not rerun because it needs an agent address with no box, so the fixtures stay the `d85271c` capture recorded below.

## Localnet run, 2026-10-07 (UTC)

`npm run capture`, then `npm start`, ran on October 7, 2026 against an arcgate localnet:

- API: `http://127.0.0.1:19800`, MCP at `http://127.0.0.1:19800/mcp`. `/health` reports `commit: null` on localnet, so the arcgate commit recorded is the checkout HEAD, `d85271c`.
- Payments: x402 on Arc testnet `eip155:5042002` through the Arcus facilitator, in USDC `0x3600000000000000000000000000000000000000`, paid to `0x987F719b516f528f4080EF0853E37aD5d7E773A0`.
- Payer and agent: the funded throwaway key `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0` was both. The address had no box, so `boxCreate` created it. The two roles still signed separately: the payer's key signed the payments, the agent key signed `boxStatus`.
- Logs: `.runs/capture-2026-10-07.log`, `.runs/start-2026-10-07.log` and `.runs/host-2026-10-07.log` (not committed).

### Tool list

The tour printed `tools/list: 32 tools` and 32 names in server order. They equal the names a raw `POST /mcp` `tools/list` returned, in the same order (compared with `diff`, no difference).

### `npm run capture`

| Step | What it did | Result |
| --- | --- | --- |
| tools/list | 32 tools printed | Pass |
| free | `health` and `tradeVenues` answered with no payment | Pass |
| tradeSearch | Priced 5000 base units (0.005 USDC), paid once, receipt printed | Pass |
| tradeQuote | Priced 10000 base units (0.01 USDC), paid once, receipt printed | Pass |
| boxStatus (signed) | 404 `box_not_found` | Pass |
| boxCreate | Priced 50000 base units (0.05 USDC), paid once, receipt printed | Pass |
| boxStatus (signed) | 200, the box exists | Pass |
| second run: boxCreate | Priced 50000, signed and sent: `not charged: boxCreate box_exists`, no receipt | Pass, nothing charged |

The capture wrote the 15 files in `test/fixtures`.

### Settlements

Every paid call settled on Arc testnet `eip155:5042002` with `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0` as payer. `eth_getTransactionReceipt` on `https://rpc.testnet.arc.io` answered status `0x1` for each.

| Run | Tool | Amount (USDC) | Transaction |
| --- | --- | --- | --- |
| capture | tradeSearch | 0.005 | `0x6ef3dc3df08b39fc78ee3c10e24932b1580098249d1a6cd0d47ff8afe3f10b37` |
| capture | tradeQuote | 0.01 | `0x6f1edec1f1fd2fe4275f8976b48eed887eb7d021961de2b0e16b8ae4ab32a74b` |
| capture | boxCreate | 0.05 | `0x33cefeeac0e61f343db456c945954d8d54b5f3bdca26ae3a32939ec367d7d488` |
| capture (second run) | boxCreate | 0 | none: `box_exists`, not settled |
| start | tradeSearch | 0.005 | `0x0a1eb651256ffd8b14228c741fc89847747ac4ab858f06e2fe7e77614273ba51` |
| start | tradeQuote | 0.01 | `0xe9daebcff52df4c04049e8008ba1d5e35553dce1b4cb76d6c0e8381a5fe3513f` |

### The payer's USDC balance

Read with `eth_call` `balanceOf` on the USDC contract, in base units (6 decimals).

| When | Balance | Change |
| --- | --- | --- |
| Before capture | 1500000 | |
| After capture | 1435000 | 65000 = 5000 + 10000 + 50000 |
| After start | 1420000 | 15000 = 5000 + 10000 |

Four payments were signed in the capture (the second `boxCreate` too) and three settled: the balance fell by exactly the three settled prices, so `box_exists` was not charged.

### `npm start` with an existing box

The signed `boxStatus` answered 200 with the box, so the tour called no `boxCreate`. Only `tradeSearch` and `tradeQuote` were paid.

### A host that cannot pay

`claude -p --strict-mcp-config --mcp-config <file> --allowedTools mcp__arcgate__health,mcp__arcgate__tradeSearch`, with the file pointing `arcgate` at `http://127.0.0.1:19800/mcp`: the server connected, `health` returned `ok: true`, and `tradeSearch` with query `cirBTC` returned the payment-required result (5000 base units on `eip155:5042002`), not search results. No USDC was spent.

### Offline tests

`npm test`: 37 tests pass offline (every test file sets `globalThis.fetch` to a function that throws). `npm run typecheck` passes. The tests in `arc-circle`, `arc-metamask` and `arc-agent-box` still pass.

The spec tests are unchanged: `test/fake-mcp.ts`, `test/tour.test.ts`, `test/capture.test.ts` and `test/fixtures.test.ts` are byte-identical to commit `29f4653`, and in `test/fixtures/README.md` only the DATE and COMMIT placeholder was filled in. The cases added since live in `test/capture-guard.test.ts` and `test/mcp.test.ts`.
