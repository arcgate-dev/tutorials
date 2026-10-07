# Arcgate tutorials

Connect your wallet to [api.arcgate.dev](https://api.arcgate.dev). Arcgate searches for tokens, quotes trades, and returns unsigned swap transactions on Arc. Your wallet signs payments and sends transactions.

| Tutorial | What you will build |
| --- | --- |
| [Circle wallet → Arcgate](arc-circle/README.md) | Connect a Circle developer-controlled wallet, pay for API calls by x402 on Arc mainnet, or on Arc testnet against the arcgate localnet, and trade USDC for cirBTC. |
| [MetaMask Agent Wallet → Arcgate](arc-metamask/README.md) | Connect a MetaMask Agent Wallet with the `mm` CLI, pay for API calls with x402 on Arc mainnet (or preview against the arcgate localnet on Arc testnet), sign a Permit2 permit, and trade USDC for cirBTC. Every command runs in MetaMask's Beast Mode, since Guard Mode can't simulate the swap on Arc yet. |
| [Agent box → Arcgate](arc-agent-box/README.md) | Give an agent a box, an inbound address for outside services, watches over Arcgate's index and a webhook channel, with a private-key wallet: paid calls over x402 and owner calls signed by the wallet. It runs against an arcgate localnet until production serves /agent/v1. |

Each tutorial contains its complete source, dependency lockfile, configuration example, and tests. Start inside the tutorial's directory.

API reference: [docs.arcgate.dev](https://docs.arcgate.dev). Machine-readable contract: [OpenAPI](https://api.arcgate.dev/openapi.json).
