# Validation

## Epic #7 check: Beast Mode preview on the arcgate localnet, October 8, 2026 (UTC): not passed, wallet out of testnet USDC

The epic branch `epic/7` at `41e891b` ran `npm run connect` (14:12:15Z) and `npm run preview` (14:12:18Z to 14:13:09Z) against the arcgate localnet. `preview` did **not** pass. Sources: `.runs/connect-epic-1008.log`, `.runs/preview-epic-1008.log` and the run logs `.runs/6222be9e-1e75-4609-9423-ba55e8959fa2.jsonl` and `.runs/ee740579-b7b5-4ff8-a31c-23cf7a377b06.jsonl`, not committed.

- API `http://127.0.0.1:19800`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `rulesVersion` `r2-383954828c`, `commit: null`. The localnet api container was built at 12:14Z from the arcgate checkout, whose last commit before then is `27c0ddb3`; the service does not confirm it. `ARCGATE_PAY_TO` `0x987F719b516f528f4080EF0853E37aD5d7E773A0`.
- `mm wallet trading-mode get --json` reported `beast` for `0x72e17261e04e6162a62f034d8d71053ea37d35a3`. `connect` passed and printed testnet USDC **0.03**, enough for one 0.025 preview.
- Two `preview` processes ran at the same time on this wallet (started 14:12:26Z and 14:12:27Z, one run log each). Each paid search (5000; `0x290f1246e0d7195e8f70fe753b204c537a4ebc235cc0a0a4105c882bf5f2588b` and `0xfee093fc3faa317a2c58e4ed0c2ef25e19ef322cc83e35fcc1f32846a938a73f`) and quote (10000; `0xc6faba8f7f6cb05d6ee360a85e106121ceb0af11f2557a9e6757021dc47e9dc3` and `0x303333749b99553019cb23a6b884a26d4d40b1938ffef703122a6632e84177c7`). Quote `q_50945d59bcf8755b`: sell 0.5 USDC, quoted 0.00000596 cirBTC, minimum 0.0000059.
- Both swaps were then refused with **HTTP 402** before settling (`request_failed`, request IDs `97dadbd2` and `591a31dc`, no payment response): the two runs had spent the whole 0.03. `connect` afterward printed testnet USDC **0**.
- Nothing was signed beyond the x402 authorizations and nothing was sent.
- Not rerun: the wallet needs at least 0.025 testnet USDC, and funding it is the owner's call. The last passing preview is October 7's, below.
- The balance re-read at 14:27:29Z was 0 (0 base units) on Arc testnet USDC, so it was not rerun, and funding is the owner's step. Source: `.runs/balance-20261008T142719Z-41260.log`, not committed.

Offline: `npm test` reports 67 pass, 0 fail.

## Epic #7 check: Beast Mode preview on the arcgate localnet, October 7, 2026 (UTC)

The epic branch `epic/7` at `18adb0a` ran `npm run preview` (23:54:17Z to 23:55:07Z) and `npm run trade -- --execute` (23:55:10Z) against the arcgate localnet. Sources: `.runs/preview-epic.log`, `.runs/trade-epic.log` and the run log `.runs/7d93ef69-d046-4e94-99b0-f115eea05f5e.jsonl`, not committed.

- API `http://127.0.0.1:19800`. `/health` is `ok: true`, `x402.network` `eip155:5042002`, `rulesVersion` `r2-383954828c`, `commit: null`, so the arcgate checkout is `5addf63f`; the service does not confirm it. `ARCGATE_PAY_TO` `0x987F719b516f528f4080EF0853E37aD5d7E773A0`.
- `mm wallet trading-mode get --json` reported `beast` for `0x72e17261e04e6162a62f034d8d71053ea37d35a3` before the run; it was not switched.
- `preview` passed. Testnet USDC was 0.055 at the start:
  - search `0x1b158d3153774f159d0972317bb7b90467730866120ad4971779d376138aac0e` (`4c2831e4`, 5000 base units)
  - quote `0xcb6c278f9817cbaab770b3b0a4dbd491e50bec18313d7c0b202b37f2e0b72023` (`8b075782`, 10000)
  - swap `0x3349fe53505b343a34d632666fbdd11b70f753fd300b32527db4b758203ef8ed` (`a8905d58`, 10000)
- Quote `q_d3451165bb2b9778`: sell 0.5 USDC, quoted 0.00000596 cirBTC, minimum 0.0000059. `mm decode` read `executeGraph` through router `0x0ea7461542fe051c013ab0f5860190bc847f3271`, `amountIn` 500000, `minOut` 590, recipient the wallet, funding Permit2, `permitAttached` false. The permit was not signed and nothing was sent.
- `trade -- --execute` was refused before any payment, as designed on this row: "The API pays on eip155:5042002 but trades on eip155:5042. mm broadcasts to the real chain, so the trade runs only where the API pays on Arc mainnet. Use npm run preview here. No payment signed."
- A balance read on Arc testnet afterward showed 0.030 USDC, which reconciles with the 25000 base units spent.

Offline: `npm test` reports 67 pass, 0 fail.

## October 7, 2026 (UTC): Beast Mode on the arcgate localnet (testnet x402)

Beast Mode, against the arcgate localnet at `http://127.0.0.1:19800`. The API takes its x402 payments on Arc testnet (`eip155:5042002`) and trades on a fork of Arc mainnet, so `trade` is refused before any payment. The run logs (`.runs/e946fb7f-41fb-4ff5-a3e7-f8376b9e30af.jsonl` and `.runs/135bf36b-066a-48a1-a38b-6114fe51aa88.jsonl`) are not committed.

- Arcgate checkout `5addf63f`. `/health` reports `commit: null`, so that commit is not confirmed by the service.
- `API_URL` `http://127.0.0.1:19800`. `/health` is `ok: true` with `x402.network` `eip155:5042002` and `rulesVersion` `r2-383954828c`.
- The `mm` trading mode was `beast`, read before the run and never switched. The payer is the server wallet `0x72e17261e04E6162a62f034D8d71053Ea37D35A3`.
- The 402 offered `payTo` `0x987F719b516f528f4080EF0853E37aD5d7E773A0`, which was set as `ARCGATE_PAY_TO`. `inspect` passed and showed the same `/health` and 402 blocks that `connect` and `preview` printed; its output was not saved.
- `connect` passed at 22:17:06Z.
- `preview` passed at 22:17:11Z. Testnet USDC was 0.105 before the run (printed by `connect` and `preview`). The three x402 settlements below took 25000 base units, leaving 0.080 (derived, not read):
  - search `0x44c73192ac9333206d785a0be483cc1223469a0897e66f26335c26aebe9ad951` (requestId `93e8e93c`, 5000 base units)
  - quote `0x7d14595b86a36f64d35b8e95dcae4d7c587425ab3802529b2ab9d12d612fd145` (`e5658371`, 10000)
  - swap `0x7ab65f8ac26ca1d6625358a7850c35c5ed9b2ca4f79bf9ae06b902fb48931489` (`37c48d8d`, 10000)
- The quote was `q_268dcf17694b3475`: sell 0.5 USDC, quoted output 0.00000596 cirBTC, minimum 0.0000059 cirBTC.
- `mm decode` read the swap as `executeGraph` through router `0x0ea7461542fe051c013ab0f5860190bc847f3271`: `amountIn` 500000, `minOut` 590, recipient the wallet, funding through Permit2, `permitAttached` false.
- The Permit2 permit had domain chainId 5042, spender `0x0ea7461542fe051c013ab0f5860190bc847f3271`, amount 500000, expiration 1794003456, nonce 0 and sigDeadline 1791411756. The permit was not signed and nothing was sent.
- `trade -- --execute` at 22:17:45Z was refused before any payment. Its last line was: "The API pays on eip155:5042002 but trades on eip155:5042. mm broadcasts to the real chain, so the trade runs only where the API pays on Arc mainnet. Use npm run preview here. No payment signed."

Why the trade was refused: `mm` broadcasts to the real chain, but the localnet trades on a fork. Signing this Permit2 would authorize the fork's router address on real Arc mainnet. The mainnet trade belongs to #11.

QA's confirming preview ran at 22:23Z (`.runs/135bf36b-066a-48a1-a38b-6114fe51aa88.jsonl`, not committed) and passed: search `0xffe1e91627ccbb626ce4363ce786877c8af3a2ada073926602f218206e6a5f7b` (`e4cceee7`), quote `0x355c48285322543d503cdf4e085aa05a01b64f5a0b6c362d0e6034f8752f4c53` (`58276dcd`), swap `0xbfd71ad8c1b177daea5306ba69279b029678434acfec42c3294b599c2f1d4710` (`8b06c15f`). It spent another 0.025 testnet USDC. A balance read afterward on Arc testnet showed 55000 base units (0.055).

Offline: `npm test` reports 67 pass, 0 fail.

## October 7, 2026 (UTC): Beast Mode only, network row, captured responses; the mainnet trade is blocked at payment

The tutorial now runs every wallet command in Beast Mode only (no `--beast` flag, no policy script), takes its payment network from `/health` and the 402, and its tests clone every API response from a capture. No Beast Mode trade was completed on October 7, and the mainnet-trade replay test was later dropped because the trade capture and its test are #11's.

Offline: 67 tests, 67 pass. `every wallet command refuses to run in Guard Mode` passes (connect, search, quote, preview and `trade --execute` read `wallet trading-mode get`, refuse with the Guard Mode message, and sign, send and fetch nothing). The same test fails against the code before this change (commit `7ddf913`'s source): with only `src/config.js` updated so the import resolves, `main()` ignores the injected `mm` runner, so it never reads the trading mode and tries to start the real `mm` (`message must name Guard Mode: Could not start mm`).

Live, against `https://api.arcgate.dev` (commit `603c5f1`, `/health` ok, `x402.network` `eip155:5042`):

- `mm wallet trading-mode get --json` reported `beast`. `npm run inspect` and `npm run connect` passed; the wallet held 7.959815 USDC on Arc mainnet.
- `npm run trade -- --execute` ran twice (09:20:24Z and 09:20:45Z, the allowed maximum). Both stopped at the first paid call: `search` signed its x402 payment with `mm`, and the API answered **HTTP 402 with an empty body and no `PAYMENT-RESPONSE`** (`requestId` `a80a73bc` and `a9ceb06e`; run logs `.runs/2855b233-d189-493d-92e2-0b981eee9a17.jsonl` and `.runs/d48846c0-d13d-47d6-a6f1-3234ffef4b26.jsonl`, not committed). No settlement hash was returned, the USDC balance was unchanged at 7.959815 afterward, and no transaction was sent. The 0.50 USDC order was never started.
- Earlier on October 7 (00:09Z to 02:58Z), 38 runs mostly failed at the same facilitator step (`402 invalid_exact_evm_transaction_failed` "Request exceeds defined limit", or no `PAYMENT-RESPONSE`) and spent 0.23 USDC. The production preview that did succeed is captured in `test/fixtures/mainnet-run.json` (00:23:19Z).

Against the arcgate localnet (`http://127.0.0.1:19800`, payment on `eip155:5042002`): `inspect` and `connect` passed with `ARCGATE_PAY_TO` taken from the 402. The `mm` wallet held 0.005 testnet USDC, less than the 0.025 a preview costs, so `preview` was not rerun; the preview that is recorded is the 2026-10-07T00:11Z one in `test/fixtures/localnet-run.json`. `trade` on this row is refused before any payment, because `mm` broadcasts to the real chain and the localnet is a fork. That was superseded the same day by the funded run in the section above, where `preview` passed.

OpenAPI gate (Ajv 2020 with ajv-formats, outside the repository) over every request and response in `test/fixtures/*.json` against `arcgate/docs/openapi.json` (sha256 `a7bbe7e4ea6730df974bb1b7c9b9b11cdff77c5bc9cf3520702d2890253ee698`): 46 checks, 44 pass. Both failures are the deployed API's own drift from that spec in `mainnet-run.json`: the search result lacks `evidence.trades24h`, `sells24h`, `sellers24h`, `topTraderShare24h` and `origin.website`/`twitter`, and the quote lacks the required `next` and has extra `buy.verification` properties. Every localnet capture passes. The trade schemas match `cf70f87`, where the localnet capture was taken, except one description line in `QuoteBestOut`. They differ from the deployed `https://api.arcgate.dev/openapi.json`, which lags (26 of the 37 trade, health and payment schemas differ).

## Retest on September 30, 2026 (UTC): current API, same MetaMask blocker

The tutorial now uses the current Arcgate API: the Permit2 second round is the **free `POST /trade/v1/swap/tx`** (not a second paid `/swap`), and a finished trade is confirmed with the **free `POST /trade/v1/receipt`**. The executing command's API budget fell from 0.035 to **0.025 USDC**. All 36 offline tests pass.

Against `https://api.arcgate.dev` (commit `5600fdb`) and Arc mainnet:

- `inspect` and `connect` passed; the wallet was server-wallet / guard with Arc allowed and a $2 ceiling.
- Unpaid probes: `/swap/tx` for an unpaid quote answered `409 no_pending_swap` and `/receipt` for an unknown quote `404 swap_not_found`; neither asked for payment.
- `preview` paid search, quote and swap (0.025 USDC) and decoded the permit.
- `trade -- --execute` paid the same three calls (0.025 USDC), signed the Permit2 permit through `mm`, received the final swap from `/swap/tx` with that permit embedded, and passed the bundled-ABI and `mm decode` checks. The standing Permit2 approval from September 29 meant no approval transaction was needed.
- `mm wallet send-transaction` then failed exactly as before: **`TX_FAILED: Policy evaluator outflow.limit_usd degraded: unavailable`**. No swap was broadcast; the 0.50 USDC was not spent.

MetaMask's documentation explains the pattern. Guard Mode computes USD outflow and token recipients by **simulating** the transaction ("When an outflow can't be tracked reliably, such as when a transaction can't be simulated, fall back on your allowlists"). The service reports that simulation as unavailable for this Arc router call, and Guard fails closed. The September 29 results fit: a plain `approve` passed, removing the USD ceiling moved the failure to `whitelist.token_recipient`, and an allowlist did not help. **Beast Mode** skips exactly those two evaluators (outflow limit, token recipient allowlist) and keeps Blockaid threat scanning, which MetaMask lists as covered on Arc. Switching modes is the wallet owner's decision and was not done in this run.

## Beast Mode on September 30, 2026 (UTC): swap completed

The owner switched the wallet to Beast Mode (`mm wallet trading-mode set beast`, email MFA approved; server confirmed `mode: beast`). With `npm run trade -- --execute --beast`:

- Search, quote and swap were paid (0.025 USDC), the Permit2 permit was signed through `mm`, and `/swap/tx` returned the swap with it embedded.
- `mm wallet send-transaction` **broadcast** the swap: [`0x5629fced…f844b`](https://explorer.arc.io/tx/0x5629fced0a8514384079109b269e8811c8ad90f97de9014b58c2ee2a02ef844b), block 23605625.
- Delivered **0.00000597 cirBTC** against a 0.00000591 minimum; the balance change matched the Transfer logs, and Arcgate's `/receipt` answered `pass` with the same `delivered` (597).
- The wallet was switched back with `mm wallet trading-mode set guard`, which applied immediately without MFA; the server confirmed `mode: guard`.

This isolates the Guard Mode failure to its outflow and token-recipient evaluators: the same transaction path passes when only threat scanning applies.

Separately, the x402 facilitator (`facilitator.arcusnetwork.co`) intermittently answered `invalid_exact_evm_signature` (402, with no settlement transaction in `PAYMENT-RESPONSE`) for valid `mm` signatures: 3 of 16 payment attempts that day, all from ad-hoc scripts that reused the tutorial's payment client (two searches and a quote for another token); no tutorial command hit it. The signatures had `v` 27/28 and low `s`, and recovered to the wallet. As history only: each new payment made afterward settled.

## September 29, 2026 (UTC)

**Blocked before swap broadcast. No end-to-end mainnet trade completed.** These checks ran against `https://api.arcgate.dev` and **Arc mainnet (5042) on September 29, 2026 (UTC)**.

## What passed

- `mm` reported **7.0.0**, authenticated and initialized. The existing **server-wallet / guard** wallet was reused; initialization was not repeated.
- `mm chains list` exposed `arc` / 5042 and `arc-testnet` / 5042002. Testnet was checked for availability only; all live payments used mainnet.
- Free API inspection, wallet connection, paid search, quote and preview passed.
- `mm wallet sign-typed-data` produced real EIP-3009 payment signatures and Permit2 `PermitSingle` signatures. The application recovered each signer locally.
- Both `/trade/v1/swap` rounds succeeded: the initial signing request and the final transaction containing the signed permit. The order was **0.50 USDC → cirBTC**, with 1% slippage and an ERC-20 Uniswap v3 route.
- `mm decode` recognized both `approve` and `executeGraph`. Independent ABI checks verified the order, recipient, original output floor and embedded permit before submission.
- `mm wallet send-transaction` broadcast the USDC approval to Permit2. Its [receipt](https://explorer.arc.io/tx/0xaa206549844e5d73e35baefb339a6cced16bcf16aba329a9237a2b5cbc8dd9b9) succeeded, and MetaMask subsequently reported `CONFIRMED`.

The approval grants Permit2 the maximum ERC-20 allowance and remains in place. The separately signed Permit2 permits authorize only the 0.50 USDC order to ArcgateRouter; signing them did not execute a swap.

## What blocked the swap

The initial policy omitted Arc and had a $0 daily outflow ceiling. The owner approved adding 5042 and raising the ceiling to **$2**. Policy readback confirmed the change.

| Applied policy | Result of the router submission |
| --- | --- |
| `guard`, Arc allowed, `rolling_24h: 2`, empty address lists | `TX_FAILED: Policy evaluator outflow.limit_usd degraded: unavailable` |
| `guard`, same policy with owner-approved temporary `rolling_24h: null` | `TX_FAILED: Policy evaluator whitelist.token_recipient degraded: unavailable` |
| `guard`, Arc allowed, `rolling_24h: 2`, seven explicitly allowed route addresses | `TX_FAILED: Policy evaluator outflow.limit_usd degraded: unavailable` |

The temporary change was approved and applied before the second result. It was not waiting for MFA. A `finally` cleanup restored **`rolling_24h: 2`**, and a separate policy read confirmed restoration. The wallet remained in **server-wallet / guard** mode throughout.

No swap hash was returned. After the attempts, cirBTC delivery was zero, confirmed and pending transaction counts were both 1, and MetaMask's request list contained only the confirmed approval transaction. The CLI payload uses the documented `to`, `data`, hexadecimal `value` and hexadecimal `gas` fields. The final applied policy includes Arc, a $2 ceiling, seven allowlisted addresses and no blocklist entries; server-side mode is `guard`.

The service error identifies a policy evaluator failure but does not explain its cause. It does not establish whether MetaMask's Arc support, handling of this router call or a temporary dependency failure is responsible. **No working policy YAML workaround has been verified.** Neither removing the USD ceiling nor adding an explicit route allowlist resolved it. No wallet-mode change was attempted.

Read-only diagnostics following MetaMask's [troubleshooting guide](https://docs.metamask.io/agent-wallet/troubleshooting/) confirmed authentication and initialization, a parseable live policy with Arc allowed, and server-side Guard mode. The CLI's only doctor hint was that no installed AI skill was detected. The price service returned USD prices for Arc native USDC (`eip155:5042/slip44:5042`), ERC-20 USDC and cirBTC. No pending job was listed, but CLI 7.0.0's request list reads its local job cache; immediately failed submissions can be thrown before they are cached, so this is not a complete server history.

MetaMask's [outflow-policy limitations](https://docs.metamask.io/agent-wallet/reference/outflow-policy/#limitations) recommend using allowlists when outflow cannot be reliably simulated. The owner approved an explicit allowlist for USDC, Permit2, ArcgateRouter, Uniswap v3 SwapRouter02, cirBTC, the wallet recipient and Arcgate's fee recipient, all scoped to 5042. The applied policy was verified before one additional executing attempt. That attempt failed at the same USD evaluator.

## Exact transaction diagnostic

The final attempt captured the direct MetaMask service response, without retaining request bodies, credentials or signatures:

- Time: **2026-09-29 10:08:44 UTC**.
- Transaction request ID: **`d16dd88e-7279-4ca7-8474-30b9fbddff5f`**.
- HTTP response: **201**, job status **`FAILED`**.
- Failure code: **`POLICY_EVALUATOR_FAILED`**.
- Failure description: **`Policy evaluator outflow.limit_usd degraded: unavailable`**.

CLI `wallet requests watch` could not find the immediately failed request in its local cache. A read-only call through the CLI's bundled SDK retrieved the existing server job and confirmed the same failure, with no transaction hash. The server response included the prepared transaction but no deeper evaluator trace.

That exact stored transaction was then simulated directly through Arc RPC with its sender, calldata, value, gas limit and fee fields. A second check included its nonce and used the historical block matching the failed request's timestamp:

| Read-only check | Block | cirBTC output, atomic | Original minimum |
| --- | --- | --- | --- |
| Latest state, before permit expiry | 23352609 | 593 | 588 |
| State at 2026-09-29 10:08:44 UTC | 23352153 | 594 | 588 |

Both `eth_call` checks succeeded without state overrides. These results show the stored transaction was executable on Arc under those states and narrow the observed blocker to MetaMask's policy evaluation. They do **not** constitute a signed transaction broadcast or token delivery. No extra payment, signature, policy change or broadcast was made for these diagnostic checks.

## Payment evidence

All **22 x402 settlements**, totaling **0.185 USDC** across the search, quote, preview and four executing attempts, were independently checked through successful receipts and matching USDC Transfer events. The approval cost another **0.001187521088253082 USDC** in gas. The 0.50 USDC swap input was not spent.

The final attempt's API payments were:

| API operation | Fee | Mainnet receipt |
| --- | --- | --- |
| Search | 0.005 USDC | [Receipt](https://explorer.arc.io/tx/0x7af382a83808cdef8116c964ffe18175ae6098a04c9f95ee83e73a7a554aae40) |
| Quote | 0.010 USDC | [Receipt](https://explorer.arc.io/tx/0x4d43d1a0e34cf77de6bf75294b8d328dfca7d450c2615c4781ff161f90560b05) |
| Initial swap response | 0.010 USDC | [Receipt](https://explorer.arc.io/tx/0xc0c95d962fae767dce5cd7506234862f9b4cca4b68c8b973a99f775b72438755) |
| Final signed-permit swap response | 0.010 USDC | [Receipt](https://explorer.arc.io/tx/0xc7f70439dda9e4b5e86d68587f3fb140860951f88d9c4aaf1480a3e7a1ffde00) |

These receipts prove API payments, not a successful trade.

## Offline verification and limits

All **28 offline tests** pass. They use generated signing keys, constructed calldata and injected CLI, HTTP and RPC responses; they need no deployments, accounts or funds. A clean standalone installation outside both repositories passed, and the public dependency audit reported no known vulnerabilities.

Live testing exposed CLI 7.0.0's stderr error envelopes, plain-text progress mixed with JSON, and `_summary` / `_error` envelopes after MFA notices. The adapter handles these formats, with regression tests. After the first ambiguous result, the chain and MetaMask request history were checked and its permit expired before another attempt.

The actual wallet operations ran through `mm`. The MetaMask skill's 7.0.0 reference was reviewed; a complete Claude Code host session with the plugin was not separately exercised. The earlier maintainer localnet proof used impersonated transaction broadcasting and never called `mm wallet send-transaction`. It does not establish this public server-wallet broadcast path.
