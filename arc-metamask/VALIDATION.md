# Validation

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

Separately, the x402 facilitator (`facilitator.arcusnetwork.co`) intermittently answered `invalid_exact_evm_signature` (402, nothing settled) for valid `mm` signatures: 3 of 16 payment attempts that day, all from ad-hoc scripts that reused the tutorial's payment client (two searches and a quote for another token); no tutorial command hit it. The signatures had `v` 27/28 and low `s`, and recovered to the wallet. An immediate retry settled each time.

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
