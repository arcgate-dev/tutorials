# Fixtures

Every file here is one response body captured from the arcgate localnet (`POST http://127.0.0.1:19800/mcp`,
headers `content-type: application/json` and `accept: application/json, text/event-stream`), byte for byte.
None is written by hand. The tests answer with them through `test/fake-mcp.ts`, which rewrites only the JSON-RPC `id`.

Captured on 2026-10-06 from the localnet whose `/health` answered `ok: true` and `commit: null`, settling x402 on Arc testnet (`eip155:5042002`).

| File | Request |
| --- | --- |
| `initialize.json` | `initialize` with protocolVersion `2025-11-25`, the one `@modelcontextprotocol/sdk` 1.30.1 sends |
| `tools-list.json` | `tools/list`: 32 tools |
| `health.json` | `tools/call` `health` |
| `trade-venues.json` | `tools/call` `tradeVenues` |
| `trade-search.payment-required.json` | unpaid `tradeSearch` `{query:'cirBTC',limit:5}`: payment-required result, 5000 base units |
| `trade-quote.payment-required.json` | unpaid `tradeQuote` USDC to cirBTC, amount `1`: 10000 base units |
| `box-create.payment-required.json` | unpaid `boxCreate` for a random scratch address: 50000 base units |
| `box-status.signature-required.json` | `boxStatus` without `agentSignature`: the 401 `signature_required` result |
| `mcp-get.event-stream.json` | `GET /mcp` with `accept: text/event-stream`, the request the SDK makes: status 405, the server offers no event stream (the body's `id` is `null`) |

Not captured yet, because capturing them settles payments on Arc testnet and needs a funded throwaway payer:

| File | Request |
| --- | --- |
| `trade-search.paid.json` | paid `tradeSearch`: 200 with `_meta["x402/payment-response"]` |
| `trade-quote.paid.json` | paid `tradeQuote`: 200 with a receipt |
| `box-create.paid.json` | paid `boxCreate`: 200 with a receipt |
| `box-create.exists.json` | a second `boxCreate` for the same address: the `box_exists` error result, no receipt |
| `box-status.json` | `boxStatus` with a valid `agentSignature` for the created box: 200 |
