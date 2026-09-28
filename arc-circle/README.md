# Connect a Circle wallet to Arcgate

Use your own Circle wallet to call **https://api.arcgate.dev**. You will connect the wallet, pay for a token search with x402, quote 1 USDC for cirBTC, inspect the unsigned swap, and optionally send it through Circle.

Everything you need to run the example is in this folder. The dependencies are the public Circle SDK, x402 SDK, and viem. Arcgate does not need an API key: your wallet pays per call. Your Circle credentials go to Circle, never to Arcgate.

## Before you start

- **Node.js 22 or newer**, npm, and Git.
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
| `npm run trade -- --execute` | Runs the same three calls, then broadcasts | 0.025 USDC, plus the trade and gas |

Each command starts a new run. Running all four paid commands costs 0.07 USDC in API fees. A preview pays for its API calls even though it does not send the swap. The code refuses prices above its limits.

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
4. Run `npm run wallet:create`. It creates a wallet set and one `ARC` EOA through the public Circle SDK. Paste the printed `CIRCLE_WALLET_ID=…` line into `.env`. If that variable is already set, the command validates the existing wallet instead.
5. Fund the printed address with USDC on **Arc mainnet**. Check the destination network before transferring.

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
3. Ask the x402 SDK to build an **EIP-3009 `TransferWithAuthorization`**. Its signer calls `circle.signTypedData({ walletId, data })`. Circle keeps the wallet key; the script receives a signature and verifies that it recovers to your wallet address.
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
  "slippageBps": 100
}
```

Here `amount` is a **human-readable token amount**: `"1"` means 1 USDC. Slippage is 100 basis points, or 1%. You can lower `SELL_AMOUNT` in `.env`; the tutorial caps it at 1 USDC.

The response includes `quoteId`, `expiresAt`, the tokens, routes, `best`, and `safety`. For an exact-input quote, the input is `sell.amount` / `sell.amountRaw`. `best.amountOutQuoted` and `best.minAmountOut` are human-readable output amounts. The script preserves that original minimum when it later checks the swap calldata.

Quotes normally expire after 120 seconds. The preview and trade commands request a fresh quote and use it immediately. They stop if the quote is expired or the safety verdict is anything other than `ok` or `pinned`.

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

`POST /trade/v1/swap` simulates the trade from your wallet, so you need the sell amount even for a preview. Arcgate returns unsigned `transactions[]`. This tutorial requests **`approval: "approve"`**: at most one ERC-20 approval for the exact sell amount, followed by the swap. An existing allowance or a route funded by native USDC can make the approval unnecessary. The API's default is Permit2, which can require signing a permit and making another paid `/swap` call; that is a separate approval flow.

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

Circle's `amount` is a decimal native-currency amount, not wei. The helper in [src/circle.js](src/circle.js) supplies an idempotency key, records Circle's transaction ID, waits for `COMPLETE`, and returns the transaction hash. The flow also checks the onchain receipt before sending the next transaction. An approval failure stops the swap.

Finally it compares the cirBTC balance increase with both the Transfer events and the original quote's minimum. A successful run prints the settlement hashes, approval/swap hashes, and delivered amount. Prices and hashes will differ each time.

Run logs are saved under `.runs/`. They contain public transaction IDs and hashes, not credentials or reusable payment signatures. If a payment response or Circle transaction times out, the script stops instead of submitting a new payment or transaction. Inspect the recorded transaction in Circle Console and on the network before retrying. Rerunning the whole trade creates a new order and can trade again.

## Troubleshooting

| Result | What to check |
| --- | --- |
| Circle 401/403 or wallet not found | The API key, registered entity secret, and wallet ID must belong to the same Circle account and environment. |
| `ARC-TESTNET`, `TEST_API_KEY`, or SCA refused | Use a mainnet `ARC` developer-controlled **EOA** and live credentials. |
| Payment requirements differ | Run `npm run inspect`. Check the public service configuration and documented addresses before changing the pinned recipient or limits. |
| 402 after signing | Check USDC balance and the payment error. The script does not keep signing new payments. |
| HTTP 410 | The quote expired. A new run gets a new quote and incurs new successful-call fees. |
| HTTP 422 | Read the error code: the order may lack liquidity, fail simulation, or be non-executable for this wallet. |
| Swap guard refuses a changed minimum | The swap no longer preserves the earlier quote's output floor. Review a new quote. |
| Circle timeout or `SENT` | A submitted transaction may still execute. Look up its recorded Circle ID before retrying. |
| Receipt reverted | Stop. Previously paid API fees and onchain gas are separate from the failed trade. |

## Tests and verification

```sh
npm test
```

The tests use generated local signing keys and injected HTTP, Circle, and RPC responses. They require no credentials, funded wallet, or deployed service. See [VALIDATION.md](VALIDATION.md) for the checks actually run and the limits of live verification.

For other tokens, order sizes, approval modes, and MCP access, use the [API reference](https://docs.arcgate.dev) and [OpenAPI document](https://api.arcgate.dev/openapi.json). Review the example's token and spending checks before changing its scope.
