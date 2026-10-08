# Validation

## Production check, 2026-10-08 (UTC)

A free, unpaid, unsigned probe of `https://api.arcgate.dev` at 14:27Z, at commit `6e04f6a`. Nothing was signed or paid. Source: `.runs/prod-check-20261008T142719Z-41260.log`, not committed.

- `GET /health` is `ok: true`, with `x402.network` `eip155:5042`. Production serves `/agent/v1` on Arc mainnet, where payments are real USDC.
- `GET /agent/v1/<address>/box/status` with no signature answers 401 `signature_required`, as JSON.
- `POST /agent/v1/<address>/box` with no payment answers 402 `payment_required` on `eip155:5042`.

Validation runs stay on the arcgate localnet (Arc testnet), and they never spend mainnet USDC.

## Epic #7 check: localnet run at arcgate 27c0ddb3, 2026-10-08 (UTC)

The epic branch `epic/7` at `41e891b` ran `npm start` against the arcgate localnet from 14:08:55Z to 14:10:01Z, after arc-mcp and arc-claude-agent because its cleanup empties the shared box. Every step passed (box, inbound, watch, channel, messages, topup, cleanup) and so did the final check. Sources: `.runs/start-epic-1008.log` and the run log `.runs/68b4b209-bac6-471d-bf23-0541be51c21e.jsonl`, not committed.

- API `http://127.0.0.1:19800`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `commit: null`. The localnet api container was built at 12:14Z from the arcgate checkout, whose last commit before then is `27c0ddb3`; the service does not confirm it. `ARC_RPC_URL` the public Arc testnet RPC; `WEBHOOK_URL` the default `https://192.0.2.10/arc-agent-box`.
- Agent (box) address `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. The box already existed, so there was no `boxCreate`. No key is recorded here.

| Operation | Amount (base units) | Settlement | Request ID |
| --- | --- | --- | --- |
| `inboundCreate` | 10000 | `0xcd13f717bb22cd60b41cf14f71420c752bdb04f444bd64f0a8ec7d385b006bf9` | `01e4454d` |
| `watchCreate` (token) | 10000 | `0x2f7e79035679fea1c044a4711b8fabdc19cb80086534a9e1bc74abe4fa0f6bf3` | `ae40edc2` |
| `watchCreate` (screen) | 10000 | `0xf7db1787013e62f4256c00b370e58f8be0b32eccee066b6e66e9acf64d9ade62` | `0d8c7ca1` |
| `watchCreate` (agents) | 10000 | `0xc42db56aaae13869d8e57da9b90ebf1c25d2f047b9ab2bfd3ed7a9310d2f853c` | `c5554c50` |
| `tradeSearch` | 5000 | `0x6b36cee1b47011d5e2d147006996bea213504d4b855328f92372f34d37c41aaa` | `e9591578` |
| `webhookCreate` | 10000 | `0x54a7ac7268de6d463a077a3510fc15ed79ee0815acdb15a2d84f9d2ee689bfeb` | `c2fd3db7` |
| `boxTopUp` | 50000 | `0x361fb7ceb742bd2c676429425ab5881f8a46cb63b3843ffddf76f2b6f100b1ea` | `c2174860` |

Total **105000** base units (0.105 USDC). The run printed a start balance of 0.418776; a balance read on Arc testnet afterward showed 313776 base units, which reconciles: 418776 - 105000 = 313776.

- Both inbound posts were stored (201); the old secret was refused with 401 `inbound_unauthorized` after the rotation. The webhook url answered the ownership challenge. The token watch fired on FAZE: the box held 26 inbound, 27 inbound and 28 `watch.token`; seq 27 was deleted. The top-up granted 4 messages and 1 day.
- Cleanup deleted 2 inbound addresses, 4 watches and 1 webhook channel. One inbound address (`YEFxaiIONBKutAJs5clHRA`) and one watch (screen `V14OFiTcXLoQVPLayeIMJA`) were arc-claude-agent's from its run minutes earlier.
- The final check left 26 inbound and 28 `watch.token` in the box.

Offline: `npm test` passed **78** tests. `npm run capture` was not run, so `test/fixtures/localnet.json` stays the `12b0368f` capture.

## Epic #7 check: localnet run at arcgate 5addf63f, 2026-10-07 (UTC)

The epic branch `epic/7` at `18adb0a` ran `npm start` against the arcgate localnet from 23:55:17Z to 23:55:47Z, last of the five tutorials because its cleanup empties the shared box. Every step passed (box, inbound, watch, channel, messages, topup, cleanup) and so did the final check. Sources: `.runs/start-epic.log` and the run log `.runs/2e732838-909a-4a46-9fb8-b732ed1d373e.jsonl`, not committed.

- API `http://127.0.0.1:19800`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `commit: null`, so the arcgate checkout is `5addf63f`; the service does not confirm it. `ARC_RPC_URL` the public `https://rpc.testnet.arc.io`; `WEBHOOK_URL` the default `https://192.0.2.10/arc-agent-box`.
- Agent (box) address `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. The box already existed, so there was no `boxCreate`. No key is recorded here.

| Operation | Amount (base units) | Settlement | Request ID |
| --- | --- | --- | --- |
| `inboundCreate` | 10000 | `0xe71d43371cece1f5906e40bd1e9abcbc0a9f5afb33b4d7f9ff0b64bc1b04a43c` | `e2dc61ee` |
| `watchCreate` (token) | 10000 | `0xf415b98f346f7561e30ed843b88a77be5a21d11719b5d338fdcaa497acdd4311` | `8434fdc7` |
| `watchCreate` (screen) | 10000 | `0x88a1e9eb1f0259407cc26c4da1ea116f0d59419e536f4ce59aa63265f4ffc57c` | `91191d72` |
| `watchCreate` (agents) | 10000 | `0x3f11d951d15788de194cc812614e954a21fd99f707caf2141ae33d49274564ca` | `8e071bb3` |
| `tradeSearch` | 5000 | `0x952bf9dfaae3593e0ad8c32db0b3352bf8433ac31be5a5eaf922015254939e51` | `df794e3a` |
| `webhookCreate` | 10000 | `0x6512fdaa59f069e40944d68fa74824548ad28dddcee4f24a76d889501fdbe978` | `7d243197` |
| `boxTopUp` | 50000 | `0x64da387be915a54d7a34a78c1a1885d9ec5b58f2d3809a525bcc915e2ab97dc9` | `ce7af91b` |

Total **105000** base units (0.105 USDC). The run printed a start balance of 0.558776; a balance read on Arc testnet afterward showed 453776 base units, which reconciles: 558776 - 105000 = 453776.

- The inbound post was stored (201). The token watch fired on FAZE: the box held 22 inbound, 23 inbound and 24 `watch.token`; seq 23 was deleted. The top-up granted 4 messages and 0 days.
- Cleanup deleted 2 inbound addresses, 4 watches and 1 webhook channel. One inbound address (`fMOpihnijPYUq2_PXc2RKA`) and one watch (screen `U1qr7JRzse8QX1zn1EqElg`) were arc-claude-agent's from its run minutes earlier; the screen id is in the watch list this run printed.
- The final check left 22 inbound and 24 `watch.token` in the box.

Offline: `npm test` passed **78** tests. `npm run capture` was not run, so `test/fixtures/localnet.json` stays the `12b0368f` capture.

## Localnet run at arcgate 5addf63f — 2026-10-07 (UTC)

`npm start` ran on October 7, 2026 (about 23:05 UTC) against an arcgate localnet. Every step passed (box, inbound, watch, channel, messages, topup, cleanup), and so did the final check. Sources: `.runs/start-5addf63f.log` and the run log `.runs/52f308c9-b5c9-40fe-b1c6-938162adca94.jsonl`.

- API: `http://127.0.0.1:19800`. `/health` reports `commit: null` on localnet, so the arcgate checkout is `5addf63f`; the service does not confirm it.
- Agent (box) address: `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0`. The box already existed, so there was no `boxCreate`.
- `ARC_RPC_URL` was the public `https://rpc.testnet.arc.io`.
- Order: this run went last, after arc-mcp, arc-claude-agent and arc-circle, because its cleanup empties the shared box.

| Operation | Amount (base units) | Settlement | Request ID |
| --- | --- | --- | --- |
| `inboundCreate` | 10000 | `0xa7697214d7a8d2a801cbf7ff2f80b57558c2f6c847a931c14150311e6d216d20` | `8f55182b` |
| `watchCreate` | 10000 | `0x87a328cdd418c16da29ec5b9afee934c843d95f05370b9fee0149ebb8c02b014` | `b255ab82` |
| `watchCreate` | 10000 | `0xf87ebf2e743c31286188891fc22734ede6e0a9591daff74241ea09731efe145a` | `45dbc1af` |
| `watchCreate` | 10000 | `0x4dfe76c1c16cc66391eff020475d6c3f3318f0fcf945d4230c915b933067bc38` | `6c420e97` |
| `tradeSearch` | 5000 | `0xc5acd86a6add424c552593701ca7f8cab43363b3f35f09dcbe3f98ad99d2a04d` | `da527b8b` |
| `webhookCreate` | 10000 | `0x925164348b7c02cd2df31c23152848f370e288e4743fa2569b4fedb4ed8f98ec` | `a6de2210` |
| `boxTopUp` | 50000 | `0xf3c16b41953d7db7be0824ab94c2cc2646d7e86713e25305814070cb0a62ae9d` | `9b3595e6` |

Total **105000** base units (0.105 USDC). The payer's USDC balance went from 698776 (the log prints `0.698776` at the start) to 593776, which reconciles: 698776 - 105000 = 593776.

Cleanup deleted 4 watches, 2 inbound addresses and 1 webhook channel. Because the box is shared, that included work left by an earlier tutorial's run:

- One of the 4 watches was arc-claude-agent's screen `1GaY52Muj9By8NI1HzvGzA`. That id is confirmed: it appears in the watch list this run printed.
- One of the 2 inbound addresses was arc-claude-agent's `j_JpOCeMTNJQwYwkWlkrMg`. That is inferred, because the log prints only the count (`inboundDelete: deleted 2`).

Offline tests: `npm test` in `arc-agent-box` passed **78** tests.

`npm run capture` was not run, so `test/fixtures/localnet.json` stays the `12b0368f` capture recorded below. No key is recorded here.

## Localnet run — 2026-10-07 (UTC)

`CAPTURE_API_COMMIT=12b0368f npm run capture` ran on October 7, 2026 against an arcgate localnet:

- API: `http://127.0.0.1:19800`. `/health` reports `commit: null` on localnet, so the arcgate commit recorded is the fixture's `apiCommit`, `12b0368f`.
- Payments: x402 on Arc testnet `eip155:5042002` through the facilitator `https://facilitator.arcusnetwork.co`, in USDC `0x3600000000000000000000000000000000000000`, paid to `0x987F719b516f528f4080EF0853E37aD5d7E773A0`, the `payTo` in the fixture's 402s.
- Agent (box) address: `0x06E594c677Cd28643B82477B7B5328Ac6817b2A0` only. It is an existing shared box, so there was no `boxCreate`. Its state before the run: created at `1791365243`, 999 messages left, expiry `1796549243`, 0 messages, 1 inbound address (`B-kc4oaEnh61HHv96lHpag`), 1 watch (another track's screen `oGnXYai82uHjRH_M6rQtVg`: `volume_24h gt 50000` AND `safety_verdict eq ok`) and 0 webhooks.
- The capture is three command runs under one recording fetch: `start` (all seven steps and the final check), then `topup`, then `topup`. It wrote `test/fixtures/localnet.json` (`capturedAt` `2026-10-07T15:52:38Z`) and one run log, `.runs/dff999a1-cf8b-4f79-9546-3b659b7ed60a.jsonl`. `WATCH_TOKEN` was unset, so the token watch used the default, FAZE `0xf81afef268aca40717e0adcae7c41514327cfaab`.

Exchange numbers below are indexes into `exchanges` in the fixture.

| Step | What it did | Result |
| --- | --- | --- |
| box | `boxStatus` answered 200 (ex. 2); nothing was created or paid | Pass |
| inbound | `inboundCreate` paid (ex. 3–4), id `jGzJwc9Ho_38jtTnloOKug`; post with INBOUND-SIGNATURE 201 stored (ex. 5); `inboundRotate` (ex. 6); post signed with the old secret 401 `inbound_unauthorized` (ex. 7); post with the new secret 201 stored (ex. 8) | Pass |
| watch | Token watch `dvxnlleAXUxG4_oP5ZLgmw`, `{kind:'token', token: FAZE, where:[volume_24h gt 100000]}`, paid (ex. 9–10); screen `F8erlRYeh-WMOo5n5jq97Q`, `volume_24h gt 100000` AND `safety_verdict eq ok`, paid (ex. 11–12); agent screen `0nmkWVwaNxE2B6OkZfruLw`, `{kind:'agents', chainId:5042, on:['registered']}`, paid (ex. 13–14); `watchList` (ex. 15) lists all three with the conditions sent, plus the other track's screen; one paid `tradeSearch` (ex. 16–17) | Pass |
| channel | `webhookCreate` `_XsK9A9S7cox8eD0TPl7Kg` paid (ex. 18–19); `webhookList` (ex. 20–21); `webhookRotate` (ex. 22) | Pass |
| messages | The first page (cursor 0, ex. 23) holds the `watch.token` hit; the empty page ended the listing (ex. 24); fetched and deleted the newest inbound message, seq 13 (ex. 25–26) | Pass |
| topup | `boxTopUp` paid (ex. 27–28), charged, granted 4 messages and 0 days, allowance 1000 messages and expiry `1796549243` | Pass |
| cleanup | `inboundList` (ex. 29); deleted the other track's inbound address `B-kc4oaEnh61HHv96lHpag` (ex. 30) and the run's `jGzJwc9Ho_38jtTnloOKug` (ex. 31); `watchList` (ex. 32); deleted the other track's screen `oGnXYai82uHjRH_M6rQtVg` (ex. 33) and the run's three watches (ex. 34–36); the webhook (ex. 37–38); `boxStatus` shows 2 messages and no inbound addresses, watches or channels (ex. 39) | Pass |
| final check | `boxStatus` and the full message list (ex. 40–42) hold seq 12 `inbound` and seq 14 `watch.token` | Pass |
| topup (extra run 1) | Signed, answered 409 `allowance_full` (ex. 43–46), nothing charged | Pass, nothing charged |
| topup (extra run 2) | Signed, answered 409 `allowance_full` (ex. 47–50), nothing charged | Pass, nothing charged |

Cleanup deleted another track's screen and inbound address from this shared box, because `cleanup` removes everything the box holds, not only what the run created.

### Watch hit

The box holds a watch hit at seq 14: type `watch.token`, `source.watchId` `dvxnlleAXUxG4_oP5ZLgmw`, `changeId` 61, symbol FAZE, `observed.volume_24h` 6112809.322525. Its content keys are exactly `watchId`, `condition`, `changeId`, `token`, `symbol` and `observed`; there is no `previous`, since the token watch has no `changes` clause. The screen and the agent screen did not fire. On localnet no agent registers during a run.

### Settlements

Every paid call settled on Arc testnet `eip155:5042002` with the agent address as payer.

| Run | Operation | Amount (USDC) | Transaction |
| --- | --- | --- | --- |
| start | inboundCreate | 0.01 | `0x528a451e24507778abfa35df676b27b8383a9cf670ed3d7660cee310965c978b` |
| start | watchCreate (token watch) | 0.01 | `0x7b57d5037e9bfcad5d15c00d8e8e07531b3e0f2ef1645ab2f2cb3d2765bac99b` |
| start | watchCreate (screen) | 0.01 | `0x1ee462dd6105f4a9c98405101325e380d0af396013af8898faf9b8aab95a4a14` |
| start | watchCreate (agent screen) | 0.01 | `0x69cdc7a4321f29db4c1cbfd72d010f03046d7fa833428bee9beb37214e62822b` |
| start | tradeSearch | 0.005 | `0xd3189633d4e2f8643af5384d1b75da51c4d8ef3602536b6fc3cd84468aa77dc2` |
| start | webhookCreate | 0.01 | `0x65e1baabe69b1bf7a0a1e78693188c3df3a336916a898dddc98c7c02b5dae972` |
| start | boxTopUp | 0.05 | `0x28d82576679aa0714dff86b35887c4e72a7e64e509bd7c78b1bc231da3eb377d` |
| topup (extra run 1) | boxTopUp | 0 | none: 409 `allowance_full`, not settled |
| topup (extra run 2) | boxTopUp | 0 | none: 409 `allowance_full`, not settled |

`start` cost 0.105 USDC and the whole capture 0.105 USDC: both extra topups were signed but answered 409 and never settled. The payer balance went from 1.045 to 0.94 USDC.

### Offline tests

After the capture, `npm test` passed 75 of 75 tests offline on `test/fixtures/localnet.json`.

## Earlier runs (arcgate 917dd4a, retired watch shape)

### Localnet run — 2026-10-06 (UTC)

`CAPTURE_API_COMMIT=917dd4a npm run capture` ran on October 6, 2026 against an arcgate localnet:

- API: `http://127.0.0.1:19800`. `/health` reports `commit: null` and `indexer: null` on localnet, so the arcgate commit recorded is the checkout HEAD, `917dd4a`.
- Payments: x402 on Arc testnet `eip155:5042002` through the facilitator `https://facilitator.arcusnetwork.co`, in USDC `0x3600000000000000000000000000000000000000`, paid to `0x987F719b516f528f4080EF0853E37aD5d7E773A0`.
- Agent (box) address: `0x4189Bc425BD880b163f386e5D5270FCcb2C0A478`, a fresh throwaway key funded with testnet USDC. It had no box, so the box was created.
- The capture is three command runs under one recording fetch: `start` (all seven steps and the final check), then `topup`, then `topup`. It wrote `test/fixtures/localnet.json` (`capturedAt` `2026-10-06T22:43:51.434Z`) and one run log, `.runs/69b0e984-3890-450a-91c9-62457b03ef0d.jsonl`. The command exited 0.

Exchange numbers below are indexes into `exchanges` in the fixture.

| Step | What it did | Result |
| --- | --- | --- |
| box | `boxStatus` answered 404 `box_not_found` (ex. 2); `boxCreate` was paid, granting 500 messages for 30 days (ex. 3–4); `boxStatus` read again (ex. 5) | Pass |
| inbound | `inboundCreate` paid (ex. 6–7), url `http://127.0.0.1:19803/wvzarH5ZijOgl4vgSHPfYA`; post with INBOUND-SIGNATURE 201 stored (ex. 8); `inboundRotate` (ex. 9); post signed with the old secret 401 `inbound_unauthorized` (ex. 10); post with the new secret in INBOUND-SECRET 201 stored (ex. 11) | Pass |
| watch | Token watch `volume_24h` above 100000 on FAZE `0xf81afef268aca40717e0adcae7c41514327cfaab` paid (ex. 12–13); screen `volume_24h gt 100000` AND `safety_verdict eq ok` paid (ex. 14–15); `watchList` (ex. 16); one paid `tradeSearch` `{"query":"0xf81afef268aca40717e0adcae7c41514327cfaab","limit":5}` (ex. 17–18) | Pass |
| channel | `webhookCreate` to `https://192.0.2.10/arc-agent-box` with filter `["inbound","watch"]` paid (ex. 19–20); `webhookList` showed `verifiedAt: null` (ex. 21), then `1791326619` with the same filter (ex. 22); `webhookRotate` (ex. 23). No enable or disable request was made | Pass |
| messages | The first page (cursor 0, ex. 24) already held the watch hit; the empty page at cursor 3 ended the listing (ex. 25); fetched the newest inbound message, seq 2 (ex. 26), and deleted it because the box held two inbound messages (ex. 27); seq 1 stays | Pass |
| topup | `boxTopUp` paid, granted 500 messages and 30 days, allowance 997 messages left (ex. 28–29) | Pass |
| cleanup | Listed and deleted the inbound address (ex. 30–31), both watches (ex. 32–34) and the webhook (ex. 35–36); `boxStatus` shows 2 messages and no inbound addresses, watches or channels (ex. 37) | Pass |
| final check | `boxStatus` and the full message list (ex. 38–40) hold seq 1 `inbound` and seq 3 `watch.token` | Pass |
| topup (extra run 1) | Paid, granted 3 messages and 0 days, allowance 1000 messages left (ex. 41–44) | Pass, charged |
| topup (extra run 2) | Signed, answered 409 `allowance_full` with no PAYMENT-RESPONSE (ex. 45–48) | Pass, nothing charged |

#### How the watch hit was produced

`WATCH_TOKEN` was unset, so the token watch used the default, FAZE. The plan named cirBTC, but cirBTC is a pinned asset: a search never checks it, so it never writes a change that could fire a watch. With the localnet indexer off, the only writer of changes is search enrichment, so the watch step searches the watched token once after creating the watches. That search wrote change 35 for FAZE, and the token watch fired: message seq 3, `watch.token`, `observed` 6112809.322525, `previous` null (ex. 24). The screen did not fire; its threshold was not lowered, because the token watch already gave the hit the acceptance asks for.

#### Settlements

Every paid call settled on Arc testnet `eip155:5042002` with the agent address as payer.

| Run | Operation | Amount (USDC) | Transaction |
| --- | --- | --- | --- |
| start | boxCreate | 0.05 | `0x2589458f3974f915b7faee50c282a7cfca444920d1221999bd9a952268daae86` |
| start | inboundCreate | 0.01 | `0x50f12e0b0d8dba012eb0bd8ba888a25d79b41e855d7e27c59a8e4a9ea9096a2d` |
| start | watchCreate (token watch) | 0.01 | `0xab4d1727b8e06ddee7914b5ba097b91eb34ccbd855c28956d8630aada4f4e824` |
| start | watchCreate (screen) | 0.01 | `0xfce16c13b7435e2ab53db4966187605991193759895775ca89336196d57a21d7` |
| start | tradeSearch | 0.005 | `0x960c9ebb85bebd2b35bdf85b8be55adc53d2cebc5f2a173b77fbc4241cf41cad` |
| start | webhookCreate | 0.01 | `0x75538f4394f6954e919d562a2690d3e9d2b6323706547f00e4a52c70e00a4a51` |
| start | boxTopUp | 0.05 | `0xac45bda3af990eadd07c3dab3438985b777b216be4ca0202691bba1230ec9059` |
| topup (extra run 1) | boxTopUp | 0.05 | `0x1d8a87e7e237099bf4a6645ced14aa46fb93fcf83f6fff6e4a943e447aa21735` |
| topup (extra run 2) | boxTopUp | 0 | none: 409 `allowance_full`, not settled |

`start` cost 0.145 USDC and the whole capture 0.195 USDC.

#### Offline tests

After the capture, `npm test` passed 73 of 73 tests offline on `test/fixtures/localnet.json`, with the test files unchanged. Every test file makes `globalThis.fetch` throw. The fixture holds four `secret` fields, all `<redacted>`, and no PAYMENT-SIGNATURE or AGENT-* header.

### Rerun on the same key

`npm start` ran a second time on `0x4189Bc425BD880b163f386e5D5270FCcb2C0A478` (`.runs/dbafd6bd-6bd1-4dd5-bf0c-ace7941bee78.jsonl`, 22:44:18–22:44:45 UTC). The box already existed, so no `boxCreate` was signed. The run log has no error line. It settled:

| Operation | Amount (USDC) | Transaction |
| --- | --- | --- |
| inboundCreate | 0.01 | `0x2f4a151c6b32879243b22403cc5843e78c31b34fefac94e903f3f288963e8dc7` |
| watchCreate | 0.01 | `0xd96f5b0b3955a8e1162aff484f6a0cf2ce41c344dc01a64cc2f0080a49d335d7` |
| watchCreate | 0.01 | `0x9214b48b8f9acc971e3c47d96d32f03a76cba45e093e112b724b7df2e6133f83` |
| tradeSearch | 0.005 | `0x54d1a71c434a6d949d9668aa1e52b5b9130c1ff4b7a8ac1271c1a650af9ef7e1` |
| webhookCreate | 0.01 | `0xae7746ff09fec95c6e0331d60293cbdee10c674a1400c5f918b5f5ad0887f01b` |
| boxTopUp | 0.05 | `0x3ef211910f0ba27a6fe767b5f289cc6952059589c86759e993e49b99de34578b` |

That is 0.095 USDC. The topup was charged, not refused: the run had used messages, so a top-up again had room to grant some. The messages step reads the box from the start, so the watch hit still held from the capture (seq 3) ended its wait at once; a rerun needs no new hit.

### Earlier attempt (another key)

Before the capture, the tutorial ran with an earlier throwaway key, `0x9A42C1C8760bBBc411ac897eea4Dc5E8cA9F73b9`, and the plan's cirBTC watch:

- Runs `2f7d22b8-a5e4-481a-a953-e2c1d50de739` (22:35:16 UTC) and `8020cc97-d60e-464a-b91e-7aee437f8028` (22:35:34 UTC) logged only the 404 `box_not_found` and signed nothing.
- `start` run `a5e92f79-7d4a-4540-89c0-baf2ad584ea9` (22:35:39–22:36:05 UTC) settled boxCreate `0x67bb7ea47eee1f9034bb65d2f7a10eb39d1f690db4d10635826852ae2c4e673f` (0.05), inboundCreate `0x5776bcd8f2f13714233a982133aa28655395f694314587ced6409114f753b817` (0.01), watchCreate `0xfe41b6ebbf227ac77b158b6658771d3a0a33625e2acb8e1b1c05d4fe3620b630` and `0x31b8ddf1dd5043df5b886605f8a0ba0ccdcb8758332532191dbdef1a62ae9803` (0.01 each), tradeSearch `0xab44eadc6beb5e34d79e3624fff55081701fe949fcbb9525af5956c795b87106` (0.005) and webhookCreate `0x046d83645de733c4ef4378c9027f2813eace739e4d2809006477bb94bdc39061` (0.01), 0.095 USDC in all. It failed in the messages step: the cirBTC search wrote no change, so no watch fired within 180 s, and the run stopped before topup.
- Two `watch` runs then tried other tokens: `df065205-dcce-44ab-9512-a4f650701e29` settled `0x568167a5dabb82425bacfa01fdab9495d86e0af0adcbd438f42f2c62e4a51abd`, `0x9880f531fc9e544d9809dd8e4be9e15698ec2ec98fd84a93d71906707a349e8b` and `0xaed62f034b5736331d0b43bfb32edb989173b21ad3acb567d12024847f0271fc`, and `d850f269-d515-4490-99ee-a3fe27dd1aad` settled `0xdd926c0f0fadd858fb977e96d7f32d2d4a18e385cd475749201d477cc268890c`, `0x3c4978a145671e8022b8f69d97bc65091be5f65134b853f9f1e9838054bf4f44` and `0x566b308b0efc50f622f0b2849e84b01137415ec9aacd4da72ae8677865836232`, 0.025 USDC each. Both got a `watch.token` hit, which showed that a token a search checks does fire a watch. That led to the FAZE default and to a fresh key for the capture, so the capture would create its box.

That key spent 0.145 USDC in all. Its box remains, since a box can't be deleted.

### Acceptance-wording corrections

The localnet run showed four places where the acceptance wording didn't match the API, and the tests follow the API:

- Inbound posts go to the notifier, not the API, and its answers carry no `x-request-id`. `fixtures.test.js` requires the header on every exchange except the inbound posts.
- The inbound url is on the notifier origin (localnet `IN_URL`, `http://127.0.0.1:19803`) with one path segment, the address id, for example `http://127.0.0.1:19803/wvzarH5ZijOgl4vgSHPfYA`. `inboundUrl` in `src/config.js` applies the same origin rule as `apiOrigin` and allows that one path segment.
- `npm run capture` is `start` plus two `topup` command runs and costs about 0.195 USDC: the first extra topup is charged (it grants the messages the run used), and only the second answers 409 `allowance_full`, with nothing charged.
- A rerun's topup is charged (200), not refused with 409 `allowance_full`.

No private key, inbound or webhook secret, keyed RPC URL or payment or agent signature is written to the fixture, the run logs or this file.
