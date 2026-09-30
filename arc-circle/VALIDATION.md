# Validation

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
