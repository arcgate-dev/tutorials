# Validation

## OpenAPI check — October 7, 2026

OpenAPI check: sha256 `72fb8c6a90ff9d0641e3b46b38cba013cef5068706f54d2da1f3a57910a9da41`, validated with Ajv2020 and ajv-formats: **14 checked, 0 failed**. Per schema, the passing checks were `SearchRequest` 1, `QuoteRequest` 1, `SwapRequest` 2, `ReceiptRequest` 1, `ReceiptResponse` 2, `HealthResponse` 1, `PaymentRequired` 3 and `PaymentRequiredBody` 3, with no failures. The Ajv output for this run is not kept in the repository.

This run did not record the paid `SearchResponse`, `QuoteResponse`, `SwapResponse` or `SettleResponse`, so those were **not validated** in this run. The October 6 capture-based check below covers them.

## Localnet run — October 6, 2026

The tutorial ran end to end against the arcgate localnet on **October 6, 2026 (UTC)**, captured at `2026-10-06T22:09:38.795Z`. Every step passed, and the free receipt returned `pass`.

| Item | Value |
| --- | --- |
| API | `http://127.0.0.1:19800` |
| `/health` commit | `null`, so the arcgate checkout is `917dd4a`; `rulesVersion` `r2-383954828c` |
| Payment network | `eip155:5042002` (Arc testnet), settled through Arcus |
| Trade chain | the localnet's Arc mainnet fork, chain `5042`, at `127.0.0.1:19845` |
| `payTo` | `0x987F719b516f528f4080EF0853E37aD5d7E773A0`, set through `ARCGATE_PAY_TO` because it is the stack's `PAY_TO`; the row default is `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Router | `0x0eA7461542fE051c013AB0f5860190bC847f3271` |
| `SELL_AMOUNT` | `1` |
| Taker | `0x5Edff82F0E7DC25968cba8B614beDD782ac2cEDD`, an `ARC-TESTNET` EOA |

| Step | Result | Detail |
| --- | --- | --- |
| search | pass | Paid 5000 units. Settlement `0xa547ade055b454464b2debecb91ea4b06841cbafff4c04baa99fe1042dc291c1`, request ID `73147186`. |
| quote | pass | Paid 10000 units. Settlement `0x6d35ef3778a89e4d841972b3f1bc4f44ee99bbd86a4c404c138ce75e595fc31e`, request ID `132b84e7`, quote `q_9b4fe45c89ab130a`, `next` `swap`. |
| swap | pass | Paid 10000 units. Settlement `0x6fc5f682800a9a446d3cb373f2b5bf5f4778bdaba5b1c06490921fcaac5649f7`, request ID `709cadec`, `next` `send`. |
| sign | pass | Circle `signTypedData` signed each x402 authorization, and each recovered to the wallet. The settlement `payer` is present in all three. |
| send | pass | Approve `0x28c89355113d5b36a092703b1c4ecb261ddf988984f877cf61ca59686fb043d8` (block 23584079, success) and swap `0x37bb05a16dd3467609ed9ddc426cb2de3810d92535dc601a3162481fc2288058` (block 23584080, success), broadcast by impersonating the wallet address on the fork. Delivered **1193** cirBTC units against `minAmountOut` **1181**. |
| receipt | pass | `result` `pass`, `next` `done`. In-flow request ID `887e1863`; the separate `npm run receipt` command had request ID `fa70ca95`. |

Total fees were **25000 units (0.025 USDC)**, equal to the `maxTotal` budget.

Circle signed every x402 payment. Circle cannot sign or broadcast for a router that exists only on the fork, so the approve and swap were sent from the wallet's address on the fork instead. This stands in for Circle's broadcast on localnet; the mainnet walkthrough below used Circle for that step.

Offline tests: `npm test` in `arc-circle` passed **56 of 56** tests and in `arc-metamask` **37 of 37**, on fixtures captured in this run ([localnet-free.json](test/fixtures/localnet-free.json) and [localnet-run.json](test/fixtures/localnet-run.json)).

OpenAPI check: `../arcgate/docs/openapi.json`, version 3.1.0, sha256 `c47db591d9c4d32fcf9c37f44007f03aa048f72736283cd5fc626da27ef90398`, validated with Ajv2020 and ajv-formats. Every request sent (`SearchRequest`, `QuoteRequest`, `SwapRequest`, `ReceiptRequest`) and every captured response (`HealthResponse`, `SearchResponse`, `QuoteResponse`, `SwapResponse`, `ReceiptResponse`, `PaymentRequired`, `PaymentRequiredBody`, `SettleResponse`) is valid. The only failures were the unsent `{}` probe bodies in `localnet-free.json`.

No Circle keys, entity secrets or wallet IDs are recorded here or in the fixtures.

## API compatibility review — September 30, 2026

Reviewed the tutorial against the live [docs OpenAPI document](https://docs.arcgate.dev/openapi.json), [API OpenAPI document](https://api.arcgate.dev/openapi.json), and Circle's current [typed-data signing](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data) and [contract execution](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution) references.

Fixed the outdated instruction to submit a signed Permit2 permit to another paid `/swap` call: the current second round is free `/trade/v1/swap/tx`. The runnable example continues to use exact ERC-20 approval. It now supplies `taker` for quote readiness, checks the API's stop/executability signals, preserves structured error guidance and replacement quotes, and checks the free receipt after local delivery verification. A separate `receipt` command can recheck an existing trade without Circle credentials or payments. The README and Arcgate's docs-site tutorial source were synchronized.

Checks completed:

- `npm test`: **30 tests passed**, including readiness refusals, receipt pass/pending/fail handling, preservation of free replacement quotes and request IDs, empty middleware 402 bodies and settlement failure headers, and prevention of automatic payment or transaction retries.
- Arcgate's `pnpm exec vitest run scripts/docs.test.mjs`: **12 tests passed**, including docs rendering/build checks.
- Captured the example's actual search, quote and swap request bodies in an injected preview run and validated them, plus the receipt request, against **both published OpenAPI schemas**. The readiness and receipt response fixtures also matched both schemas.
- Ran `node src/main.js inspect` without loading `.env`: health returned 200 with x402 enabled on `eip155:5042`; unpaid search returned 402 offering 0.005 USDC to the pinned recipient.
- An unpaid quote including `taker` returned 402 offering 0.01 USDC. A free receipt lookup for an unknown quote returned 404 `swap_not_found` / `next: "stop"`. A `/swap/tx` request without its required permit returned 400 `invalid_request` / `next: "fix_request"`, without payment gating.

[API review evidence](evidence/api-review-2026-09-30.json) records schema hashes, public request IDs and unpaid responses. **No funds were spent, no Circle signatures were requested, and no transactions were broadcast in this review.** Successful paid responses and mined receipt handling were tested offline; the funded end-to-end validation below predates these changes.

## Earlier mainnet walkthrough — September 29, 2026

The published tutorial completed a real mainnet walkthrough on **September 29, 2026 (UTC)** against `https://api.arcgate.dev`, with `SELL_AMOUNT=0.50`. Circle signed the x402 payments and signed and broadcast the approval and swap on Arc, chain `5042`.

**Result: 0.50 USDC → 0.00000598 cirBTC**, above the quoted minimum of 0.00000592 cirBTC. Both Circle transactions reached `COMPLETE`; both onchain receipts succeeded. The balance increase at the swap block was 598 atomic units and matched the Transfer logs. The exact-amount USDC allowance was fully consumed, leaving zero allowance to ArcgateRouter.

| Tutorial command | Result |
| --- | --- |
| `npm run wallet:create` | Created a wallet set and an `ARC` EOA; rerunning with its saved wallet ID validated the existing wallet |
| `npm run connect` | Loaded the funded mainnet EOA and read its USDC balance |
| `npm run inspect` | Health OK; unpaid search returned HTTP 402 with x402 v2 requirements on `eip155:5042` |
| `npm run search` | Paid 0.005 USDC; resolved verified cirBTC and flagged same-ticker impostors |
| `npm run quote` | Search and quote passed; sold amount 0.50 USDC, output 0.00000598 cirBTC, minimum 0.00000592 |
| `npm run preview` | Search, quote and swap construction passed; decoded a 0.50 USDC approval and matching router call; broadcast nothing |
| `npm run trade -- --execute` | All three paid API calls passed; Circle approval and swap completed; delivery verified |

The walkthrough ran the commands from `arc-circle` with its own `.env`, public npm dependencies, and no private Arcgate imports. It needed no application code changes to complete the mainnet trade.

## Mainnet receipts

These are the three payments and two wallet transactions from the executing trade command:

| Step | Amount / result | Receipt |
| --- | --- | --- |
| x402 search | 0.005 USDC | [Transaction](https://explorer.arc.io/tx/0x5ebf6344ad4ba445d32ce76ec048135f4101b5a518336b18f3c118cf243bf482) |
| x402 quote | 0.01 USDC | [Transaction](https://explorer.arc.io/tx/0x631ea2dd040fc42c42af8c2468ea22cc6e342f4d398a8d07bc468a97eef841ef) |
| x402 swap construction | 0.01 USDC | [Transaction](https://explorer.arc.io/tx/0x4286a85525b55d0bde809a0aad5cbced846a0198190706cff794635ec0379978) |
| Circle ERC-20 approval | Exactly 500,000 USDC atomic units to ArcgateRouter | [Transaction](https://explorer.arc.io/tx/0x5ef3b8c04d15814d100463deaf93d58cab0122267515b4e19ccd3ea4da02f285) |
| Circle swap | 500,000 USDC atomic units in; 598 cirBTC atomic units delivered | [Transaction](https://explorer.arc.io/tx/0x391b5ef95c6cfb2483f729f2b343a003756165da4592ee0d734500ac2a69f42a) |

An independent readback checked Circle's transaction states, the onchain receipts, each payment's USDC transfer to the configured fee recipient, the signed transaction destinations and decoded calldata, historical cirBTC balances before and after the swap, and the remaining USDC allowance. Full public evidence, including every walkthrough payment, is in [mainnet-2026-09-29.json](evidence/mainnet-2026-09-29.json). It contains no credentials, Circle wallet IDs, or reusable signatures.

## Cost and scope

Running all four paid commands cost **0.07 USDC** in API fees. The approval and swap used **0.00760525642471332 USDC** in gas. The traded input was **0.50 USDC**.

An additional PEEPER search cost 0.005 USDC and returned `resolution: "ambiguous"` with taxed results. No PEEPER trade was attempted. Including that search, the complete validation spent **0.58260525642471332 USDC**, of which 0.50 USDC was exchanged for cirBTC.

The free `/trade/v1/venues` and `/openapi.json` endpoints also returned HTTP 200, with all three paid operations present in the schema. This validates the documented Circle EOA flow and this trade, not every token, venue, account type, or market condition.

## Offline checks and earlier integration

- Public dependency installation passed, including an anonymous download of this repository followed by `npm ci`.
- `npm test` passed all **19 offline tests**. GitHub Actions passed on Node.js 22 in a fresh Linux checkout.
- The tests exercise the real x402 SDK's payment payload, local EIP-712 signing and recovery, budget and network refusals, payment retry behavior, wallet eligibility, decoded swap checks, Circle transaction states, approval ordering, and delivery. All service responses are injected; the tests need no deployment, credentials, or funds.
- An earlier September 28 integration run used real Circle signatures and 0.025 testnet USDC in payments against a local API, with an impersonated swap on an Arc mainnet fork. It delivered 1,191 atomic cirBTC units for 1 USDC, above its 1,179-unit minimum. The mainnet run above separately verified Circle's actual broadcasting path.
