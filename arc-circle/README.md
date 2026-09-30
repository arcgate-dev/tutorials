# Connect a Circle wallet to Arcgate

Use your own Circle wallet to call **https://api.arcgate.dev**. You will connect the wallet, pay for a token search with x402, quote 1 USDC for cirBTC, inspect the unsigned swap, optionally send it through Circle, and check the fill with Arcgate's free receipt endpoint.

Everything you need to run the example is in this folder. The dependencies are the public Circle SDK, x402 SDK, and viem. Arcgate does not need an API key: your wallet pays per call. Your Circle credentials go to Circle, never to Arcgate.

**Earlier mainnet validation, September 29, 2026 (UTC):** the commands paid through x402, previewed the swap, and used Circle to approve and trade 0.50 USDC for 0.00000598 cirBTC. **API compatibility review, September 30:** updated for wallet readiness, free receipts, and the current error and Permit2 flows. The update was checked with offline tests and unpaid public requests; it did not repeat the funded trade. See [the validation record and transaction receipts](VALIDATION.md).

## Before you start

- **Node.js 22.9 or newer**, npm, and Git.
- A [Circle developer account](https://console.circle.com) with mainnet access.
- A **developer-controlled EOA wallet on `ARC`**, a live API key, and the entity secret registered for that account. A user-controlled wallet or smart contract account needs a different integration.
- USDC on **Arc mainnet, chain `5042`**. API payments and swaps both use this network on the public service. `ARC-TESTNET` wallets and faucet USDC cannot pay it.

This walkthrough uses real funds. Its default limits are **0.01 USDC per API call**, **0.025 USDC in API fees per command**, and **1 USDC sold per trade**. Gas is additional and also paid in USDC. Fund a dedicated wallet with enough for those amounts plus gas; 2 USDC gives headroom for the 1 USDC example, but gas costs vary.

| Command | What it does | API fees at the current prices |
| --- | --- | --- |
| `npm run inspect` | Checks service health and displays an unpaid payment request | Free |
| `npm run connect` | Reads your Circle wallet and its USDC balance | Free |
| `npm run search` | Resolves cirBTC | 0.005 USDC |
| `npm run quote` | Searches, then quotes 1 USDC | 0.015 USDC total |
| `npm run preview` | Searches, quotes, and builds an unsigned swap | 0.025 USDC total |
| `npm run trade -- --execute` | Runs the same three calls, broadcasts, then checks the receipt | 0.025 USDC, plus the trade and gas |
| `npm run receipt -- <quoteId> <txHash> [txHash ...]` | Checks an already submitted trade without Circle credentials | Free |

Each command starts a new run. Running all four paid commands costs 0.07 USDC in API fees. A preview pays for its API calls even though it does not send the swap. The code refuses prices above its limits.

These prices apply to this tutorial's trade of at most 1 USDC. The API's swap fee increases for larger orders; see [current pricing](https://docs.arcgate.dev/#arcgate/description/prices). API errors are not charged. A successful quote with an unsafe verdict or insufficient wallet readiness is still a paid answer, even though this tutorial stops on it.

## 1. Install the tutorial

```sh
git clone https://github.com/arcgate-dev/tutorials.git
cd tutorials/arc-circle
npm ci
cp .env.example .env
```

Run every command below from `tutorials/arc-circle`. Only this folder's `.env` is loaded. You do not need Docker or an Arcgate server.

You can already inspect the public service without a wallet:

```sh
npm run inspect
```

It checks `GET /health` and makes an unpaid `POST /trade/v1/search`. The latter returns **HTTP 402**, with a base64 JSON `PAYMENT-REQUIRED` header. Relevant fields from the public service on September 28, 2026:

```json
{
  "scheme": "exact",
  "network": "eip155:5042",
  "amount": "5000",
  "asset": "0x3600000000000000000000000000000000000000",
  "payTo": "0x08A4f8734ADAB08d3461E356b5A498b893Bd7B5e",
  "maxTimeoutSeconds": 300,
  "extra": { "name": "USDC", "version": "2" }
}
```

`amount` is in six-decimal USDC units: `5000` means 0.005 USDC. `payTo` is **Arcgate's fee recipient**, not your wallet. The example pins that address in `.env.example` and checks each offer against it before signing.

## 2. Connect your Circle wallet

If you already have a developer-controlled `ARC` EOA, use its existing credentials and wallet ID. Find them in [Circle Console](https://console.circle.com):

```dotenv
# .env — keep this file private
CIRCLE_API_KEY=LIVE_API_KEY:your_key_here
CIRCLE_ENTITY_SECRET=your_registered_64_character_hex_secret
CIRCLE_WALLET_ID=your_wallet_uuid
```

`CIRCLE_WALLET_ID` is Circle's UUID for the wallet, **not** its `0x` address. The API key and entity secret must belong to the account that owns it. Use the existing registered entity secret; do not generate a replacement for an existing account.

For a new Circle account:

1. Enable mainnet access and create a **live** API key in Circle Console.
2. Generate and register an entity secret using [Circle's setup instructions](https://developers.circle.com/wallets/dev-controlled/register-entity-secret). Keep the recovery file outside this repository.
3. Set `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` in `.env`, leaving `CIRCLE_WALLET_ID` empty.

Create the wallet programmatically with the included script:

```sh
npm run wallet:create
```

[src/create-wallet.js](src/create-wallet.js) follows Circle's [Create your first developer-controlled wallet](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet) guide: call `createWalletSet`, then `createWallets`. It sets `blockchains: ['ARC']` and `accountType: 'EOA'` for this mainnet tutorial. Circle's quickstart uses `ARC-TESTNET` in its example.

Paste the printed `CIRCLE_WALLET_ID=…` line into `.env`. If that variable is already set, the command validates the existing wallet instead of creating another. Fund the printed address with USDC on **Arc mainnet**, leaving additional USDC for gas.

Then connect:

```sh
npm run connect
```

Expected shape, with your address and balance:

```json
{
  "address": "0xYourWalletAddress",
  "blockchain": "ARC",
  "usdcBalance": "2"
}
```

Connecting reads the wallet and balance; it does not sign or pay. The check requires `accountType: "EOA"`, `blockchain: "ARC"`, and `state: "LIVE"`. `state: "LIVE"` means the wallet is active; the separate `blockchain` check establishes its network. Circle documents Arc support in its [supported blockchains](https://developers.circle.com/wallets/supported-blockchains) table.

The connection code is ordinary Circle SDK code, included in [src/circle.js](src/circle.js):

```js
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});
const response = await circle.getWallet({ id: process.env.CIRCLE_WALLET_ID });
const wallet = response.data.wallet;
```

## 3. Pay for a search

```sh
npm run search
```

The request is:

```http
POST https://api.arcgate.dev/trade/v1/search
Content-Type: application/json

{"query":"cirBTC","limit":5}
```

[src/payment.js](src/payment.js) handles the payment:

1. Send the request without payment and read the 402 requirements.
2. Check the network, USDC contract, fee recipient, amount, and authorization timeout.
3. Ask the x402 SDK to build an **EIP-3009 `TransferWithAuthorization`**. Its signer calls [`circle.signTypedData({ walletId, data })`](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data), where `data` is the EIP-712 payload serialized as a JSON string, including `types.EIP712Domain`. The helper converts big integers to decimal strings. Circle keeps the wallet key; the script receives a signature, normalizes its recovery ID, and verifies that it recovers to your wallet address.
4. Retry the identical request once, with the signed payload in `PAYMENT-SIGNATURE`.
5. Read the result and the settlement receipt in `PAYMENT-RESPONSE`.

Arc USDC must be explicitly listed in the x402 client's `spendControls.allowedAssets`. The included client sets that allowlist as well as the per-call and total budgets.

The result contains `resolution` and `results[]`, including each token's contract address, verification, and flags. This tutorial expects the verified cirBTC contract:

```text
0x171a4217b86a807a64eb94757db6849fb4bdbaa0
```

It stops on ambiguous results, a different address, an unverified token, or any flags. A matching ticker alone is not enough to choose a token.

## 4. Get a quote

```sh
npm run quote
```

After search, the script makes this paid request:

```http
POST https://api.arcgate.dev/trade/v1/quote
Content-Type: application/json

{
  "sell": "0x3600000000000000000000000000000000000000",
  "buy": "0x171a4217b86a807a64eb94757db6849fb4bdbaa0",
  "amount": "1",
  "side": "exactIn",
  "slippageBps": 100,
  "taker": "0xYourCircleWalletAddress"
}
```

Here `amount` is a **human-readable token amount**: `"1"` means 1 USDC. Slippage is 100 basis points, or 1%. You can lower `SELL_AMOUNT` in `.env`; the tutorial caps it at 1 USDC.

The verified mainnet walkthrough used `SELL_AMOUNT=0.50`. Set that value in `.env` to follow the same trade size.

The response includes `quoteId`, `expiresAt`, the tokens, routes, `best`, and `safety`. For an exact-input quote, the input is `sell.amount` / `sell.amountRaw`. `best.amountOutQuoted` and `best.minAmountOut` are human-readable output amounts. The script preserves that original minimum when it later checks the swap calldata.

The script supplies your wallet address as `taker`, so the response also reports `readiness` at the quote's block:

- `balance`: whether the wallet holds the input amount, in raw token units.
- `approve.needs`: whether this tutorial's `approval: "approve"` flow needs an ERC-20 approval, already has allowance (`none`), or uses native USDC (`native`). `approval.needs` describes the separate default Permit2 flow.
- `gas` and `fees`: estimated native USDC gas and the remaining swap API fee, with balance checks for the taker and x402 payer.
- `totalCostUsdc`: swap fee plus estimated gas, excluding the traded principal and the search/quote fees already paid. The gas estimate uses the default Permit2 plan, so the exact-approval flow's actual gas can differ.

The script prints readiness and stops if `readiness.ready` is false, `next` is `stop`, or `best.executable` is false. This snapshot does not reserve funds or guarantee execution; `/swap` checks the wallet again.

Quotes expire after 120 seconds by default; optional `ttlSec` can shorten that lifetime to 1–120 seconds. The preview and trade commands request a fresh quote and use it immediately. They also stop if the quote is expired or the safety verdict is anything other than `ok` or `pinned`.

## 5. Inspect the swap

```sh
npm run preview
```

This runs search and quote, then:

```js
const swap = await api('swap', {
  quoteId: quote.quoteId,
  taker: wallet.address,
  recipient: wallet.address,
  approval: 'approve',
  deadlineSec: 300,
});
```

`api` is the paid HTTP helper from [src/payment.js](src/payment.js); `runFlow` shows all three calls together in [src/flow.js](src/flow.js).

`POST /trade/v1/swap` re-quotes and simulates the trade from your wallet, so you need the sell amount and gas headroom even for a preview. Arcgate returns unsigned `transactions[]`. This tutorial requests **`approval: "approve"`**: at most one ERC-20 approval for the exact sell amount, followed by the swap. An existing allowance or a route funded by native USDC can make the approval unnecessary. `signatures` must be empty before this example will send anything.

`deadlineSec: 300` sets the onchain execution deadline. It does not extend the quote's 120-second lifetime for requesting swap construction. The swap response's `minAmountOut` and `amountOutSimulated` are raw output-token units; the quote's `best.minAmountOut` is human-readable. The guard decodes the calldata and compares it with the original quote minimum converted to raw units.

**If you choose Permit2 in another integration:** call paid `/trade/v1/swap` first. If it returns `next: "sign_permit"` and a nonempty `signatures` array, validate and sign `signatures[0].typedData` with the taker's Circle wallet, then call **free `POST /trade/v1/swap/tx`** with the same `quoteId`, `taker`, `recipient`, optional `deadlineSec`, and `permit: { message: typedData.message, signature }`. Send only the final response's transactions, in order. `/swap/tx` accepts no `approval` field, and `/swap` accepts no `permit` field. The free round requires a pending paid swap for that quote, taker and recipient, a live quote, and is consumed by its first successful response. This tutorial keeps exact approval throughout; its x402 signing policy accepts payment authorizations only, so implementing Permit2 also requires a separate permit validation policy.

Before sending anything, [src/guards.js](src/guards.js) decodes the entire transaction batch. It checks the approval spender and amount, router address, input and output tokens, sell amount, recipient, minimum output, deadline, native value, and input pull mode. The router is pinned to the public deployment:

```text
0x6cf4f7785d479b9ec1c3abe2fb569525380baede
```

The script prints the decoded fields and stops. **No approval or swap is broadcast in preview.** API fees have still been paid.

Arc has two representations of USDC: ERC-20 amounts use **6 decimals**, while native transaction `value` uses **18 decimals**. The example handles both; it does not send a six-decimal integer as native value.

These checks bind the transaction to the order you requested. They do not independently price the asset or audit every venue call inside the route. Review the quoted price and minimum before choosing to trade.

## 6. Send the trade through Circle

When you are ready to spend the configured amount:

```sh
npm run trade -- --execute
```

This fetches a **new** quote and swap, applies the same checks, then asks Circle to sign and broadcast each transaction in order:

```js
const created = await circle.createContractExecutionTransaction({
  walletId: wallet.id,
  contractAddress: tx.to,
  callData: tx.data,
  amount: formatUnits(BigInt(tx.value), 18),
  fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  idempotencyKey,
});
```

Circle's [`amount`](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution) is a decimal native-currency amount, not wei. Use `callData` with the returned raw transaction data; do not combine it with `abiFunctionSignature` or `abiParameters`. The helper in [src/circle.js](src/circle.js) supplies an idempotency key, records Circle's transaction ID, waits for `COMPLETE`, and returns the transaction hash. The flow also checks the onchain receipt before sending the next transaction. An approval failure stops the swap.

It compares the cirBTC balance increase with both the Transfer events and the original quote's minimum, then checks Arcgate's free receipt as described below. A successful run prints the settlement hashes, approval/swap hashes, delivered amount and receipt result. Prices and hashes will differ each time.

Run logs are saved under `.runs/`. They contain Circle transaction IDs, quote IDs, onchain hashes, readiness, receipts and API error guidance, not credentials or reusable payment signatures. If a payment response or Circle transaction times out, the script stops instead of submitting a new payment or transaction. Inspect the recorded transaction in Circle Console and on the network before retrying. Rerunning the whole trade creates a new order and can trade again.

## 7. Check the fill for free

After the transactions confirm, the trade command calls **`POST /trade/v1/receipt`** with plain `fetch`, without an x402 payment:

```js
const response = await fetch(`${config.apiUrl}/trade/v1/receipt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ quoteId: quote.quoteId, txHashes }),
});
const receipt = await response.json();
if (!response.ok) throw new Error(`receipt: ${response.status} ${receipt.error?.code}`);
```

`txHashes` contains the onchain swap hash and any approval hashes (1–4 total), not Circle transaction IDs or x402 settlement hashes. The included [receipt helper](src/receipt.js) preserves API errors and never signs a payment. It works for this Circle EOA's direct transactions; the endpoint does not support Safe, ERC-4337 or batching EIP-7702 execution.

- `result: "pass"`: `delivered` meets `minAmountOut`. Both are raw units of `token` received by `recipient`; cirBTC has 8 decimals. The script also checks them against its locally verified fill.
- `result: "pending"`: wait at least 5 seconds and query the receipt again. Do not broadcast again.
- `result: "fail"`: inspect `reason` and `next`. `stop` means a swap succeeded but the fill failed the check; do not trade again. `requote` means no swap succeeded; inspect the transactions before deciding on a new trade.

The trade command prints a ready-to-run `npm run receipt -- ...` command with its quote ID and hashes. You can also fill them in yourself:

```sh
npm run receipt -- <quoteId> <swapTxHash> [approvalTxHash]
```

Replace the placeholders, omitting the brackets and optional approval hash when none was sent. This command needs no Circle credentials and spends nothing. If the receipt lookup fails after a trade, use it to check that same trade; rerunning `trade` would submit a new order. Receipt records are available for one hour after swap construction. Requests are limited to one chain read per quote every 5 seconds and 132 reads per quote; respect `retryAfterSec` on a rate limit.

## API errors and replacement quotes

Errors carry `error.code`, optional `error.hint`, and a top-level `next`: `requote`, `retry`, `fix_request`, `stop` or `pay`. `retryAfterSec`, when present, supplies the delay; `X-Request-Id` identifies the request for support. The client prints and records these fields. `sign_permit` is the action on a successful Permit2 swap response, not permission to broadcast its unfinished transaction.

`/swap` can return **409 `quote_stale`** or **410 `quote_expired`** with a free replacement in `quote` and `next: "requote"`. Review its price, safety and readiness before using its new `quoteId`; accepting it may change the trade's output floor. This courtesy is limited to one fresh quote per paid quote and is unavailable after some expiry/retry conditions. When it cannot offer a tradable replacement, the response may say `stop` with a reason, or `requote` without a quote. `/swap/tx` never includes this free replacement.

This tutorial records any replacement quote but stops for review; it does not automatically accept a new price or sign another payment. In a custom client, the structured response is also available on `ArcgateError.body`. A new command starts from a new paid search and quote.

## Troubleshooting

| Result | What to check |
| --- | --- |
| Circle 401/403 or wallet not found | The API key, registered entity secret, and wallet ID must belong to the same Circle account and environment. |
| `ARC-TESTNET`, `TEST_API_KEY`, or SCA refused | Use a mainnet `ARC` developer-controlled **EOA** and live credentials. |
| Payment requirements differ | Run `npm run inspect`. Check the public service configuration and documented addresses before changing the pinned recipient or limits. |
| 402 after signing | Check USDC balance and the payment error. The script does not keep signing new payments. |
| HTTP 409 `quote_stale` / 410 `quote_expired` | Review `next`, `error.hint` and any free replacement `quote` in the run log. The tutorial stops; starting a new run incurs new successful-call fees. |
| Quote `next: "stop"` or readiness false | Review the printed balance, gas, fee and route checks. Fix the cause before paying for a new quote. |
| HTTP 429 | Respect `next` and `retryAfterSec`. `swap_attempts_exhausted` requires a new quote; repeatedly retrying the same one will not help. |
| HTTP 422 | Read the error code: the order may lack liquidity, fail simulation, or be non-executable for this wallet. |
| Swap guard refuses a changed minimum | The swap no longer preserves the earlier quote's output floor. Review a new quote. |
| Circle timeout or `SENT` | A submitted transaction may still execute. Look up its recorded Circle ID before retrying. |
| Receipt reverted | Stop. Previously paid API fees and onchain gas are separate from the failed trade. |
| Free receipt pending or unavailable | Use the printed receipt command to check the existing trade. Do not rerun `trade`. A 404 `swap_not_found` can mean its one-hour receipt record expired; use the onchain hashes. |

## Tests and verification

```sh
npm test
```

The tests use generated local signing keys and injected HTTP, Circle, and RPC responses. They require no credentials, funded wallet, or deployed service. See [VALIDATION.md](VALIDATION.md) for the checks actually run and the limits of live verification.

For other tokens, order sizes, approval modes, and MCP access, use the [API reference](https://docs.arcgate.dev) and [OpenAPI document](https://api.arcgate.dev/openapi.json). Review the example's token and spending checks before changing its scope.
