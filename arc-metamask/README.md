# Connect MetaMask Agent Wallet to Arcgate

Use **MetaMask Agent Wallet 7.0.0**, its `mm` CLI, and [MetaMask's skills for Claude Code](https://github.com/MetaMask/agent-skills) to call **https://api.arcgate.dev**. You will pay for API calls with x402, search for cirBTC, quote **0.50 USDC**, inspect the swap, sign its Permit2 permit, and send the transactions through MetaMask.

Everything needed by the application is in this folder. Dependencies are public npm packages; wallet keys and MetaMask login credentials stay in `mm`. Arcgate needs no API key. Against https://api.arcgate.dev, API payments and the swap both use **Arc mainnet, chain `5042`**. Against the arcgate localnet, the API takes its x402 payments on Arc testnet (`5042002`) and still trades on a fork of Arc mainnet; `preview` works there, `trade` does not (see step 1).

**Every wallet command runs only in Beast Mode.** MetaMask's Guard Mode refuses the router transaction with `Policy evaluator ... degraded: unavailable`: its outflow and token-recipient checks need a transaction simulation that MetaMask can't run for this call on Arc. This is a MetaMask-side limitation; no policy change works around it. Beast Mode skips those two checks and keeps MetaMask's threat scanning. The tutorial reads the trading mode from MetaMask's server before anything else, refuses in Guard Mode without touching the network, and never changes the mode itself: the wallet owner switches it. On September 30, 2026 the trade completed on Arc mainnet in Beast Mode ([swap](https://explorer.arc.io/tx/0x5629fced0a8514384079109b269e8811c8ad90f97de9014b58c2ee2a02ef844b), Arcgate `/receipt` `pass`). See [VALIDATION.md](VALIDATION.md).

## Before you start

- Node.js **22.18 or newer**, npm, Git, and Claude Code. The optional chain-list filter uses `jq`.
- `@metamask/agent-wallet@7.0.0` and the MetaMask Agent Wallet skill.
- A **dedicated** MetaMask **server wallet** in **Beast Mode**, funded with only a few USDC on Arc mainnet. Bring-your-own-key (`byok`) uses a different custody and policy model and isn't covered here.

This walkthrough spends real funds. The application limits each API payment to **0.01 USDC**, each command to **0.025 USDC in API fees**, and each trade to **at most 1 USDC**. The configured order is **0.50 USDC**. Gas costs extra, in USDC. About 2 USDC gives headroom for the example, though gas varies.

| Command | What it does | API fees at current prices |
| --- | --- | --- |
| `npm run inspect` | Checks the service and an unpaid 402 response | Free |
| `npm run connect` | Checks `mm`, networks, trading mode and balance | Free |
| `npm run search` | Resolves cirBTC | 0.005 USDC |
| `npm run quote` | Searches, then quotes | 0.015 USDC total |
| `npm run preview` | Searches, quotes, builds and decodes the first swap response | 0.025 USDC total |
| `npm run trade -- --execute` | Runs the Permit2 flow, broadcasts and confirms with `/receipt` | 0.025 USDC, plus the trade and gas |
| `npm run receipt -- <quoteId> <txHash>...` | Asks Arcgate whether a sent swap delivered its minimum | Free |

Every wallet command (`connect`, `search`, `quote`, `preview`, `trade`) first checks the trading mode with MetaMask's server and stops unless it is Beast Mode. Nothing here changes the mode. Each command starts a fresh run. Running all four paid commands costs **0.07 USDC** in API fees. Preview pays its API fees even though it sends no transactions.

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
SELL_AMOUNT=0.50
```

No wallet secret belongs in this file. The API names its payment network in `/health` and in the 402, and that network picks the row of chains, RPC, fee recipient and router this run uses. Each row's defaults are pinned in [src/config.js](src/config.js), so a server response cannot silently replace them: a network outside the table, or a 402 that offers a different one than `/health`, stops the run before anything is signed. To use the arcgate localnet, change only `API_URL=http://127.0.0.1:19800`; the localnet pays x402 on Arc testnet, so set `ARCGATE_PAY_TO` to your stack's `PAY_TO`. `ARC_RPC_URL`, `ARCGATE_PAY_TO` and `ARCGATE_ROUTER_ADDRESS` are optional overrides, commented out in `.env.example`. The RPC is used for readbacks and receipts; it does **not** change where `mm` broadcasts, and `mm` broadcasts to the real chain, which a localnet fork never sees. That is why `trade` runs only where the API pays on Arc mainnet and `preview` is the localnet command.

You can inspect the public API before connecting a wallet:

```sh
npm run inspect
```

The unpaid `POST /trade/v1/search` must return HTTP **402**, with x402 v2 requirements for `exact`, the network `/health` reports (`eip155:5042` on production), the USDC contract `0x3600000000000000000000000000000000000000`, and the row's fee recipient. Search costs `5000` atomic USDC units, or 0.005 USDC.

## 2. Connect and fund your wallet

```sh
mm doctor --json
```

If unauthenticated, run `mm login` and finish its login flow. If uninitialized, create a server wallet:

```sh
mm init --wallet server-wallet --mode guard
mm doctor --json
mm init show --json
mm wallet address --json
```

Do not reinitialize an existing wallet to follow a tutorial. Check it first. This walkthrough requires `walletMode: "server-wallet"` and, for every command, the server's trading mode to be `beast` (step 3).

Send USDC to the printed address on **Arc mainnet (5042)**, then:

```sh
npm run connect
```

This reads the selected wallet, its trading mode and its USDC balance. It signs nothing and pays nothing. Use your own address; no Circle account or Arcgate server is needed.

Confirm both Arc entries:

```sh
mm chains list --json | jq '.data.chains[] | select(.key == "arc" or .key == "arc-testnet")'
```

| CLI key | Chain ID | Role here |
| --- | --- | --- |
| `arc` | `5042` | API payments, Permit2 signature, approval and swap |
| `arc-testnet` | `5042002` | Availability check only; testnet funds cannot pay this API |

`mm` uses numeric IDs in `--chain-id`. Arc is gated server-side by **NetworkRegistry**: local chain constants do not establish service support. Stop if the expected entries are absent. `relaySupported: false` is a relay capability flag, not proof that ordinary wallet signing or broadcasting is unavailable. Chain listing also does not prove policy acceptance.

## 3. Switch the wallet to Beast Mode

A MetaMask server wallet runs in one of two trading modes. The mode applies to the whole wallet, not to one command, and only its owner can change it:

| Guardrail | Guard Mode | Beast Mode |
| --- | --- | --- |
| Threat scanning (Blockaid; covered on Arc) | ✓ | ✓ |
| Network allowlist | ✓ | No |
| Address and token-recipient allowlists | ✓ | No |
| Rolling 24-hour USD outflow limit | ✓ | No |

**On Arc, Guard Mode can't send this swap.** Its outflow limit and token-recipient allowlist are computed by simulating the transaction, and MetaMask reports that simulation as unavailable for the ArcgateRouter call. The transaction is refused with `TX_FAILED: Policy evaluator outflow.limit_usd degraded: unavailable` (or `whitelist.token_recipient` with no USD limit). Removing the USD limit and allowlisting every address involved both failed. The same transaction succeeds with a direct `eth_call` on Arc, and it broadcasts and fills in Beast Mode. The plain USDC `approve` passed in Guard Mode. Beast Mode skips the checks that refused the swap, so it shouldn't refuse the approval either, but a fresh wallet's approve-then-swap sequence has only been run in Guard (where the swap was refused), not end to end in Beast. [VALIDATION.md](VALIDATION.md) has the full record.

So this tutorial runs in **Beast Mode** only. The owner switches the wallet once; MetaMask asks to confirm by email (or MetaMask Mobile), so wait for the server to report `beast`:

```sh
mm wallet trading-mode set beast --no-wait --json
mm wallet trading-mode get --json
```

In Guard Mode every command stops at its first step with an error naming this switch, before any network request, signature or transaction. What you give up in Beast Mode is MetaMask's own limit and allowlists. This application checks the same things for its own transactions before it signs anything:

- each API payment is capped at 0.01 USDC and each run at 0.025 USDC, paid only to the pinned fee recipient on chain 5042;
- the order is capped at 1 USDC and pinned to the cirBTC contract;
- every transaction is decoded with a bundled ABI, and its destination (the pinned ArcgateRouter or USDC), input amount, output token, recipient (your wallet), output floor and deadline must match the quote;
- the Permit2 permit must name ArcgateRouter, the exact sell amount and short deadlines;
- delivery is checked on chain and with Arcgate's `/receipt`.

Those checks cover what this application sends. They don't restrict anything else that can use the wallet while it is in Beast Mode. That's why you should use a dedicated wallet with only a few USDC.

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

Review the preview's order, floor, permit and route first. Then run the trade, against an API that pays on Arc mainnet:

```sh
npm run trade -- --execute
```

Before every signature and transaction the run rereads the server's trading mode and stops if it is no longer `beast`. It never changes the mode itself. Against the localnet, `trade` stops before any payment, because `mm` would broadcast to the real chain.

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

In Claude Code, give the agent the concrete scope: follow this tutorial, buy 0.50 USDC of the pinned cirBTC contract on Arc mainnet, use 1% slippage, cap each payment at 0.01 USDC and the executing command's API fees at 0.025 USDC. Preview first; for the trade, check the wallet is already in Beast Mode (the owner switches it, not the agent). Review the permit, persistent Permit2 approval and decoded order before execution; handle MFA on the existing request.

## Troubleshooting

| Result | What to check |
| --- | --- |
| `mm doctor` is not ready | Complete login and initialization; rerun doctor before wallet commands. |
| Missing `arc` or `arc-testnet` entry | Resolve MetaMask NetworkRegistry/service support.  |
| `The wallet is in Guard Mode and this tutorial runs only in Beast Mode` | The owner switches it once: `mm wallet trading-mode set beast`, approve the email, then check `mm wallet trading-mode get`. The tutorial never switches it. |
| `The API pays on eip155:5042002 but trades on eip155:5042` | `trade` against the localnet. Use `npm run preview` there; the trade runs against https://api.arcgate.dev. |
| `Unsupported payment network`, or a 402 on another network than `/health` | The API named a network outside the table. Run `npm run inspect`; nothing was signed. |
| `Policy evaluator ... degraded: unavailable` | MetaMask could not complete a server-side policy check. This is not a pending MFA request. Guard Mode's outflow and token-recipient checks need a MetaMask-side simulation that is unavailable for this Arc router call. The wallet must be in Beast Mode (step 3). See [VALIDATION.md](VALIDATION.md). |
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
| Shield or recipient refusal | Review the reported contract/recipient and route. |
| Reverted receipt or delivery mismatch | Stop and inspect receipts. API fees and gas are separate from the failed trade. |

## Tests and verification

```sh
npm test
```

Tests use generated local signing keys and injected CLI, HTTP and RPC answers. Every API response they use is a clone of a capture in `test/fixtures/` (the arcgate localnet and the production API), with the clock pinned to the capture's moment, except the final `/swap/tx` and `/receipt` answers, which stay hand-built until the Beast Mode trade is captured (#8). They need no credentials, `mm` installation, funded wallet or deployed service. One test refuses every wallet command in Guard Mode. See [VALIDATION.md](VALIDATION.md) for live results and limitations.

For the API contract, see the [API reference](https://docs.arcgate.dev) and [OpenAPI document](https://api.arcgate.dev/openapi.json). The [Circle tutorial](../arc-circle/README.md) demonstrates the separate `approval: "approve"` path.
