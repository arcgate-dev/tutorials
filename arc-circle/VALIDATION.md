# Validation

Checked September 28, 2026 using the source in this directory.

| Check | Result |
| --- | --- |
| Public npm dependency installation | Passed; no authenticated registry or workspace packages |
| `npm test` | Passed: 19 offline tests |
| GitHub Actions | Passed on Node.js 22 in a fresh Linux checkout |
| `npm run inspect` against `https://api.arcgate.dev` | Passed: health OK, HTTP 402, x402 v2 on `eip155:5042`, search price 0.005 USDC |
| Configured mainnet router | Non-empty contract code at `0x6cf4f7785d479b9ec1c3abe2fb569525380baede` on chain 5042 |
| Circle wallet connection | Passed with an existing `ARC-TESTNET` EOA through the included Circle adapter |
| Real Circle x402 signing and settlement | Passed for search, quote, and swap, paying 0.025 testnet USDC total |
| Search → quote → swap → delivery | Passed against a local API and Arc mainnet fork: 1 USDC sold; 1,191 atomic cirBTC units delivered, minimum 1,179 |
| Paid requests against the public mainnet API | **Not run** with Circle in this validation |
| Circle mainnet transaction broadcast | **Not run**; requires a funded live `ARC` wallet |

The integration run used the tutorial's `circle.js`, `payment.js`, `guards.js`, and `flow.js`. A separate maintainer harness supplied local API/RPC addresses, an Arc testnet payment configuration, and an impersonated broadcaster on the fork. Circle signed the payments for real; it did not sign or broadcast the fork transactions. The fork result is not evidence of a completed mainnet trade.

The reader workflow uses `api.arcgate.dev`, a live `ARC` Circle wallet, and Circle's own broadcast API. It does not require that integration harness or a local API. The automated tests inject all service responses and do not depend on any deployment.

The offline tests exercise the real x402 SDK's signed payment payload, EIP-712 serialization and recovery, budget and network refusals, one-retry payment behavior, wallet eligibility, decoded swap checks, Circle transaction states, approval ordering, and output delivery. They do not establish Circle account eligibility or execution success for a particular mainnet wallet.
