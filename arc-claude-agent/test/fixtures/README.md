# Fixtures

Every file here is one response body captured by `npm run capture` from the arcgate localnet (`POST http://127.0.0.1:19800/mcp`,
headers `content-type: application/json` and `accept: application/json, text/event-stream`), byte for byte, except that the inbound
address's `secret` is replaced by `<redacted>` in `inbound-create.paid.json`, in `structuredContent` and in the text JSON that copies it.
None is written by hand. The tests answer with them through `test/fake-mcp.ts`, which rewrites only the JSON-RPC `id`.

Captured on: 2026-10-07, from the localnet whose `/health` answered `ok: true` and `commit: null`, arcgate checkout commit 94806e7, settling x402 on Arc testnet (`eip155:5042002`).

The capture runs with the shared testnet payer, which already has a box, so the no-box branch (`boxStatus` answers `box_not_found`, then a paid `boxCreate`) cannot be captured, so no test runs it against a captured answer.

| File | Request |
| --- | --- |
| `initialize.json` | `initialize` with protocolVersion `2025-11-25`, the one `@modelcontextprotocol/sdk` 1.30.1 sends |
| `tools-list.json` | `tools/list`: 32 tools |
| `mcp-get.event-stream.json` | `GET /mcp` with `accept: text/event-stream`, the request the SDK makes: status 405, the server offers no event stream (the body's `id` is `null`) |
| `box-status.json` | `boxStatus` with a valid `agentSignature` for the payer's box: 200 |
| `box-create.payment-required.json` | unpaid `boxCreate` for the payer's address: 50000 base units |
| `box-create.exists.json` | paid `boxCreate` for the same address: the `box_exists` error result, no receipt, not charged |
| `watch-create.payment-required.json` | unpaid `watchCreate` with the capture's screen (`volume_24h` gt 75000 and `safety_verdict` eq ok): 10000 base units |
| `watch-create.paid.json` | paid `watchCreate`: 200 with a receipt |
| `watch-list.json` | `watchList` with a valid `agentSignature`, after the watch was created |
| `inbound-create.payment-required.json` | unpaid `inboundCreate`: 10000 base units |
| `inbound-create.paid.json` | paid `inboundCreate`: 200 with a receipt, the address's `url` and its `secret` as `<redacted>` |
| `box-message-list.json` | `boxMessageList` with a valid `agentSignature` and no cursor or limit, after an outside sender posted a note with an instruction in it to the inbound address with the `INBOUND-SECRET` header |
| `box-message-delete.json` | `boxMessageDelete` of the seq the page returned |
| `box-message-list.empty.json` | `boxMessageList` again, after every seq the page returned was deleted |
