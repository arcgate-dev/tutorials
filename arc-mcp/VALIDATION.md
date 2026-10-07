# Validation

## Production check, 2026-10-07 (UTC)

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
