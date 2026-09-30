# Connect MetaMask Agent Wallet to Arcgate

Use **MetaMask Agent Wallet 7.0.0**, its `mm` CLI, and [MetaMask's skills for Claude Code](https://github.com/MetaMask/agent-skills) to call **https://api.arcgate.dev**. You will pay for API calls with x402, search for cirBTC, quote **0.50 USDC**, inspect the swap, sign its Permit2 permit, and send the transactions through MetaMask.

Everything needed by the application is in this folder. Dependencies are public npm packages; wallet keys and MetaMask login credentials stay in `mm`. Arcgate needs no API key. Both API payments and the swap use **Arc mainnet, chain `5042`**.

**Guard Mode doesn't work for this swap on Arc yet, so the trade step runs in Beast Mode.** MetaMask's Guard Mode refuses the router transaction with `Policy evaluator ... degraded: unavailable`: its outflow and token-recipient checks need a transaction simulation that MetaMask can't run for this call on Arc. This is a MetaMask-side limitation; no policy change works around it. Beast Mode skips those two checks and keeps MetaMask's threat scanning. On September 30, 2026 the trade completed on Arc mainnet in Beast Mode ([swap](https://explorer.arc.io/tx/0x5629fced0a8514384079109b269e8811c8ad90f97de9014b58c2ee2a02ef844b), Arcgate `/receipt` `pass`). Payments, search, quote, preview, Permit2 signing and decoding worked in both modes, and the one-time USDC approval was sent in Guard Mode on September 29. See [VALIDATION.md](VALIDATION.md).

## Before you start

- Node.js **22.18 or newer**, npm, Git, and Claude Code. The optional chain-list filter uses `jq`.
- `@metamask/agent-wallet@7.0.0` and the MetaMask Agent Wallet skill.
- A **dedicated** MetaMask **server wallet**, funded with only a few USDC on Arc mainnet. You will switch it to Beast Mode for the trade and back to Guard Mode afterward. Bring-your-own-key (`byok`) uses a different custody and policy model and isn't covered here.

This walkthrough spends real funds. The application limits each API payment to **0.01 USDC**, each command to **0.025 USDC in API fees**, and each trade to **at most 1 USDC**. The configured order is **0.50 USDC**. Gas costs extra, in USDC. About 2 USDC gives headroom for the example, though gas varies.

| Command | What it does | API fees at current prices |
| --- | --- | --- |
| `npm run inspect` | Checks the service and an unpaid 402 response | Free |
| `npm run connect` | Checks `mm`, networks, wallet mode, policy and balance | Free |
| `npm run policy` | Saves a policy proposal for your review | Free; applies nothing |
| `npm run search` | Resolves cirBTC | 0.005 USDC |
| `npm run quote` | Searches, then quotes | 0.015 USDC total |
| `npm run preview` | Searches, quotes, builds and decodes the first swap response | 0.025 USDC total |
| `npm run trade -- --execute --beast` | Runs the Permit2 flow, broadcasts and confirms with `/receipt` (wallet in Beast Mode) | 0.025 USDC, plus the trade and gas |
| `npm run receipt -- <quoteId> <txHash>...` | Asks Arcgate whether a sent swap delivered its minimum | Free |

Every wallet command expects the wallet in Guard Mode unless you add `--beast`; it then expects Beast Mode. It checks the mode with MetaMask's server and never changes it. Each command starts a fresh run. Running all four paid commands costs **0.07 USDC** in API fees. Preview pays its API fees even though it sends no transactions.

There are **two different allowances** in the Permit2 flow: the API returns an unlimited ERC-20 approval from USDC to the fixed Permit2 contract; the signed Permit2 permit grants ArcgateRouter only the exact sell amount, with a 30-day allowance expiry and a short signature deadline. The ERC-20 approval can remain after trading. Use a dedicated wallet and review both permissions.

## 1. Install the tutorial and MetaMask skills

```sh
git clone https://github.com/arcgate-dev/tutorials.git
cd tutorials/arc-metamask
npm ci
cp .env.example .env
npm install -g @metamask/agent-wallet@7.0.0
claude plugin marketplace add MetaMask/agent-skills
claude plugin install metamask-agent-wallet@metamask
mm --version
```

Start a new Claude Code session to load the skill. The plugin supplies wallet guidance; the CLI is installed separately. These instructions were checked against [agent-skills commit `9909fa4`](https://github.com/MetaMask/agent-skills/tree/9909fa472b52032dd3bb4995a807e524c36c71b2), which targets CLI 7.0.0.

Run the npm commands from **`tutorials/arc-metamask`**. Only this folder's `.env` is loaded:

```dotenv
API_URL=https://api.arcgate.dev
ARC_RPC_URL=https://rpc.mainnet.arc.io
ARCGATE_PAY_TO=0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e
ARCGATE_ROUTER_ADDRESS=0x6cf4f7785d479b9ec1c3abe2fb569525380baede
SELL_AMOUNT=0.50
```

No wallet secret belongs in this file. `ARCGATE_PAY_TO` is Arcgate's fee recipient, not your wallet. Addresses are pinned locally so a server response cannot silently replace them. `ARC_RPC_URL` is used for readbacks and receipts; it does **not** change where `mm` broadcasts.

You can inspect the public API before connecting a wallet:

```sh
npm run inspect
```

The unpaid `POST /trade/v1/search` must return HTTP **402**, with x402 v2 requirements for `exact`, `eip155:5042`, the USDC contract `0x3600000000000000000000000000000000000000`, and the configured fee recipient. Search costs `5000` atomic USDC units, or 0.005 USDC.

## 2. Connect and fund your wallet

```sh
mm doctor --json
```

If unauthenticated, run `mm login` and finish its login flow. If uninitialized, choose the wallet mode this tutorial assumes:

```sh
mm init --wallet server-wallet --mode guard
mm doctor --json
mm init show --json
mm wallet address --json
```

Do not reinitialize an existing wallet to follow a tutorial. Check its mode first. This walkthrough requires `walletMode: "server-wallet"`. Start in Guard Mode; step 7 switches to Beast Mode only for the trade. In BYOK mode, `mm wallet policy get` returns `WRONG_WALLET_MODE`.

Send USDC to the printed address on **Arc mainnet (5042)**, then:

```sh
npm run connect
```

This reads the selected wallet, policy and USDC balance. It signs nothing and pays nothing. Use your own address; no Circle account or Arcgate server is needed.

Confirm both Arc entries:

```sh
mm chains list --json | jq '.data.chains[] | select(.key == "arc" or .key == "arc-testnet")'
```

| CLI key | Chain ID | Role here |
| --- | --- | --- |
| `arc` | `5042` | API payments, Permit2 signature, approval and swap |
| `arc-testnet` | `5042002` | Availability check only; testnet funds cannot pay this API |

`mm` uses numeric IDs in `--chain-id`. Arc is gated server-side by **NetworkRegistry**: local chain constants do not establish service support. Stop if the expected entries are absent. `relaySupported: false` is a relay capability flag, not proof that ordinary wallet signing or broadcasting is unavailable. Chain listing also does not prove policy acceptance.

## 3. Understand the two trading modes

A MetaMask server wallet runs in one of two trading modes. The mode applies to the whole wallet, not to one command:

| Guardrail | Guard Mode | Beast Mode |
| --- | --- | --- |
| Threat scanning (Blockaid; covered on Arc) | ✓ | ✓ |
| Network allowlist | ✓ | No |
| Address and token-recipient allowlists | ✓ | No |
| Rolling 24-hour USD outflow limit | ✓ | No |

**On Arc, Guard Mode can't send this swap.** Its outflow limit and token-recipient allowlist are computed by simulating the transaction, and MetaMask reports that simulation as unavailable for the ArcgateRouter call. The transaction is refused with `TX_FAILED: Policy evaluator outflow.limit_usd degraded: unavailable` (or `whitelist.token_recipient` with no USD limit). Removing the USD limit and allowlisting every address involved both failed. The same transaction succeeds with a direct `eth_call` on Arc, and it broadcasts and fills in Beast Mode. The plain USDC `approve` passed in Guard Mode. Beast Mode skips the checks that refused the swap, so it shouldn't refuse the approval either, but a fresh wallet's approve-then-swap sequence has only been run in Guard (where the swap was refused), not end to end in Beast. [VALIDATION.md](VALIDATION.md) has the full record.

So this tutorial runs searches, quotes and the preview in **Guard Mode**, and switches to **Beast Mode** only to send the trade. What you give up in Beast Mode is MetaMask's own limit and allowlists. This application checks the same things for its own transactions before it signs anything:

- each API payment is capped at 0.01 USDC and each run at 0.025 USDC, paid only to the pinned fee recipient on chain 5042;
- the order is capped at 1 USDC and pinned to the cirBTC contract;
- every transaction is decoded with a bundled ABI, and its destination (the pinned ArcgateRouter or USDC), input amount, output token, recipient (your wallet), output floor and deadline must match the quote;
- the Permit2 permit must name ArcgateRouter, the exact sell amount and short deadlines;
- delivery is checked on chain and with Arcgate's `/receipt`.

Those checks cover what this application sends. They don't restrict anything else that can use the wallet while it is in Beast Mode. That's why you should use a dedicated wallet with only a few USDC, and switch back to Guard as soon as the trade is done.

### Allow Arc in the Guard policy

Guard Mode only considers requests on chains in the wallet's policy, and a new wallet's policy doesn't include Arc. Add it before the paid commands:

```sh
npm run policy
```

This saves the current policy, MetaMask's template and a proposal under `.runs/policy-…/`. The proposal adds chain `5042`, raises `rolling_24h` to at least $2, and adds this tutorial's addresses only if your allowlist is already nonempty. It never removes a restriction. It **applies nothing**; compare `proposed.yaml` with `before.yaml`, then apply it with the path it printed:

```sh
mm wallet policy set --policy "$(cat .runs/policy-REPLACE_WITH_PRINTED_ID/proposed.yaml)" --no-wait --json
mm wallet policy get --json
npm run connect
```

Adding a chain or raising a limit requires **MetaMask MFA**; follow the notice, then reread the policy. A `pending_approval` answer is not a rejection; don't submit a duplicate. `npm run connect` prints `problems: []` once the policy is ready. When MetaMask's Arc simulation works, `npm run trade -- --execute` without `--beast` will use this policy and refuse to start until that review passes.

## 4. Pay for a search

```sh
npm run search
```

The request is `POST https://api.arcgate.dev/trade/v1/search` with:

```json
{"query":"cirBTC","limit":5}
```

[src/payment.js](src/payment.js) reads the 402 offer, checks the chain, USDC contract, recipient, amount and expiry, and asks the x402 SDK to create an **EIP-3009 `TransferWithAuthorization`**. Its signer calls:

```sh
mm wallet sign-typed-data --chain-id 5042 --payload '<complete EIP-712 JSON>' --wait --wallet-timeout 60 --json
```

The [CLI adapter](src/metamask.js) passes argument arrays without a shell. It verifies `SIGNED` and recovers the signature to your selected wallet. The x402 client explicitly allows Arc USDC through `spendControls.allowedAssets`, retries the identical HTTP request once with `PAYMENT-SIGNATURE`, and checks the settlement in `PAYMENT-RESPONSE`.

A repeated 402 or lost paid response stops the run. The client reserves its budget before signing and does not free it after a timeout. It never signs another payment automatically for the same call.

The search must resolve to the verified, unflagged cirBTC contract:

```text
0x171a4217b86a807a64eb94757db6849fb4bdbaa0
```

Ambiguous results, a different contract, an unverified token or flags stop the flow.

## 5. Get a quote

```sh
npm run quote
```

After searching, [src/flow.js](src/flow.js) pays for `POST /trade/v1/quote`:

```json
{
  "sell": "0x3600000000000000000000000000000000000000",
  "buy": "0x171a4217b86a807a64eb94757db6849fb4bdbaa0",
  "amount": "0.50",
  "side": "exactIn",
  "venues": ["uniswap_v3"],
  "slippageBps": 100
}
```

`amount` is in human-readable USDC, and 100 basis points is 1% slippage. The input is returned as `sell.amount` / `sell.amountRaw`; the output quote and floor are `best.amountOutQuoted` and `best.minAmountOut`, in cirBTC units.

The tutorial chooses Uniswap v3 to demonstrate ERC-20 input and Permit2. A native-funded route would skip the permit. Quotes normally live 120 seconds. Only safety verdicts `ok` and `pinned` are accepted, and the original quote's output floor is retained for all later checks.

## 6. Inspect the swap with `mm decode`

```sh
npm run preview
```

This obtains a fresh search and quote, then requests:

```js
const request = {
  quoteId: quote.quoteId,
  taker: wallet.address,
  recipient: wallet.address,
  approval: 'permit2',
  deadlineSec: 300,
};
const first = await api('swap', request);
```

For a fresh Permit2 allowance, the response contains a `PermitSingle` signing request and a placeholder swap transaction. If needed, it also contains a USDC approval to Permit2. **Never broadcast the placeholder swap.** A funded wallet is required even for preview because `/swap` simulates the order.

Before any submission, [src/guards.js](src/guards.js) decodes the entire batch using the included ERC-20 and ArcgateRouter ABIs. It verifies destinations, approval spender, tokens, exact input, recipient, original minimum output, deadline, zero native value and Permit2 pull mode. Then the adapter calls `mm decode` on **both the approval and swap calldata**:

```sh
mm decode --payload '<swap transaction data>' --json
```

During the mainnet check, `mm decode` recognized both `approve` and `executeGraph`. The 7.0.0 decoder uses a public selector database, which may return `Call unknown function` for `executeGraph` (`0xfdbcb692`). The example prints that result alongside the independent, bundled-ABI review. An unknown selector alone is never permission to send: failed ABI decoding or mismatched order fields stop the run. A conflicting function name also stops it.

The checked permit must use Permit2 on chain 5042, authorize only ArcgateRouter, spend exactly the configured USDC amount, and have bounded expiry and signature deadlines. Preview displays the permit but **does not sign it or send transactions**. Its x402 payment signatures still spend API fees.

These guards check the order and its permissions; they do not independently price the token or audit every nested venue call. Review the output floor and decoded route targets.

## 7. Sign Permit2 and send through MetaMask

Review the preview's order, floor, permit and route first. Then switch the wallet to Beast Mode. MetaMask asks you to confirm by email (or MetaMask Mobile); wait for the server to report `beast`:

```sh
mm wallet trading-mode set beast --no-wait --json
mm wallet trading-mode get --json
```

Run the trade:

```sh
npm run trade -- --execute --beast
```

Then switch back. Tightening to Guard applies immediately, without MFA:

```sh
mm wallet trading-mode set guard --no-wait --json
mm wallet trading-mode get --json
```

With `--beast`, the run requires the server to report `beast` before it starts and before every signature and transaction, and stops if the mode changed. It never changes the mode itself. Beast Mode doesn't enforce the policy YAML, so the local policy review is skipped.

The executing flow gets a fresh quote and first swap response, repeats the checks, and:

1. Signs `first.signatures[0].typedData` with **`mm wallet sign-typed-data --chain-id 5042`**, verifying the recovered signer.
2. Sends any USDC approval with **`mm wallet send-transaction`** and waits for a successful onchain receipt.
3. Calls **`/trade/v1/swap/tx`** with the same `quoteId`, `taker`, `recipient` and `deadlineSec`, plus `permit: { message: typedData.message, signature }`. This second round is **free**: the paid `/swap` call already covered it. It takes no `approval` field; the API rejects unknown keys.
4. Decodes the returned swap again with `mm decode` and the bundled ABI. It requires no outstanding signature request and checks that the embedded permit and signature exactly match what the wallet signed.
5. Sends the final swap with `mm wallet send-transaction`, checks the receipt, and verifies cirBTC delivery against the original minimum and Transfer logs.
6. Asks the free **`/trade/v1/receipt`** with the `quoteId` and every hash it sent. It requires `pass` and the same `delivered` amount the local check measured. A `pending` answer is asked again every 6 seconds, up to four times; after that, run the printed `npm run receipt -- ...` command yourself. Never rerun the trade to check it.

The adapter sends only transaction fields:

```js
const payload = {
  to: tx.to,
  data: tx.data,
  value: numberToHex(BigInt(tx.value)),
  gas: numberToHex(BigInt(tx.gas)),
};
```

```sh
mm wallet send-transaction --chain-id 5042 --payload '<payload JSON>' --wait --wallet-timeout 60 --json
```

The API's `value` and `gas` are decimal integer strings; the CLI expects hex quantities. The Permit2 route uses `value: "0x0"`. Native Arc USDC transaction values use 18 decimals, while ERC-20 USDC amounts use 6.

`BROADCASTED` or `CONFIRMED` plus a hash establish submission, not successful delivery. The script waits for receipts and compares the cirBTC balance increase with both Transfer logs and the original quote floor.

If MFA takes longer than the quote lifetime, the run can stop after approval. Check the existing transaction before starting a new order. Logs under `.runs/` record payment hashes and MetaMask request IDs, without credentials or reusable signatures. Rerunning the whole trade creates a new order and may trade again.

In Claude Code, give the agent the concrete scope: follow this tutorial, buy 0.50 USDC of the pinned cirBTC contract on Arc mainnet, use 1% slippage, cap each payment at 0.01 USDC and the executing command's API fees at 0.025 USDC. Preview in Guard Mode; for the trade, ask me to approve the switch to Beast Mode, run with `--beast`, and switch back to Guard right after. Review the permit, persistent Permit2 approval and decoded order before execution; handle MFA on the existing request.

## Troubleshooting

| Result | What to check |
| --- | --- |
| `mm doctor` is not ready | Complete login and initialization; rerun doctor before wallet commands. |
| Missing `arc` or `arc-testnet` entry | Resolve MetaMask NetworkRegistry/service support. A policy edit cannot enable an unsupported chain. |
| Policy preflight refuses execution | Only in Guard Mode. Inspect current policy, the proposal and service template. Confirm MFA completed and reread the applied policy. |
| `The wallet is in guard mode; this run expects beast` (or the reverse) | The server's trading mode doesn't match the flag. After `trading-mode set beast`, approve the email and check `mm wallet trading-mode get` before retrying. |
| `Policy evaluator ... degraded: unavailable` | MetaMask could not complete a server-side policy check. This is not a pending MFA request. Guard Mode's outflow and token-recipient checks need a MetaMask-side simulation that is unavailable for this Arc router call; neither removing the USD ceiling nor an allowlist resolved it. Send the trade in Beast Mode (step 7). See [VALIDATION.md](VALIDATION.md). |
| `AWAITING_MFA` | MetaMask is waiting for the wallet owner to approve this request through the email or Mobile prompt in its notice. For a signing/transaction job, use `mm wallet requests watch <polling-id>`. For policy changes, approve the notice and reread `policy get`; policy MFA IDs are not wallet-job IDs. |
| Timeout while waiting | The existing MetaMask request may still complete. Inspect that request before retrying. Do not submit a duplicate or automatically change wallet mode. |
| `HTTP 402` right after a payment was signed | The payment facilitator refused the payment; nothing settled. It has intermittently answered `invalid_exact_evm_signature` for valid signatures. Rerun the command. |
| Payment requirements differ | Run `npm run inspect`; check the public configuration before changing pinned addresses or limits. |
| `/receipt` is `pending` or unavailable | The swap already mined if the local delivery check passed. Wait at least 5 seconds and run the printed `npm run receipt -- <quoteId> <hashes>`; it is free. Do not rerun the trade. |
| `swap/tx` answers `409 no_pending_swap` | The free round needs the same `quoteId`, `taker` and `recipient` as a paid `/swap` call, and succeeds only once. Start a new quote. |
| No fresh Permit2 request | Existing allowance or native funding skipped signing. Use an appropriate dedicated wallet; do not claim a Permit2 signing test. |
| HTTP 410 or `quote_stale` | The quote expired or changed. Inspect existing approvals, then obtain a fresh quote and review its floor. |
| HTTP 422 | Read the error code; the order may lack liquidity or fail simulation. |
| Unknown calldata | The bundled exact ABI must decode successfully and pass every order check; unknown alone is not approval. |
| Shield or recipient refusal | Review the reported contract/recipient and route. Policy YAML cannot disable these service checks. |
| Reverted receipt or delivery mismatch | Stop and inspect receipts. API fees and gas are separate from the failed trade. |

## Tests and verification

```sh
npm test
```

Tests use generated local signing keys, constructed calldata and injected CLI, HTTP and RPC responses. They need no credentials, `mm` installation, funded wallet or deployed service. See [VALIDATION.md](VALIDATION.md) for live results and limitations.

For the API contract, see the [API reference](https://docs.arcgate.dev) and [OpenAPI document](https://api.arcgate.dev/openapi.json). The [Circle tutorial](../arc-circle/README.md) demonstrates the separate `approval: "approve"` path.
