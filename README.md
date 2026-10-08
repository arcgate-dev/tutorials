# Arcgate tutorials

Connect your wallet to [api.arcgate.dev](https://api.arcgate.dev). Arcgate searches for tokens, quotes trades, and returns unsigned swap transactions on Arc. Your wallet signs payments and sends transactions.

| Tutorial | What you will build |
| --- | --- |
| [Circle wallet → Arcgate](arc-circle/README.md) | Connect a Circle developer-controlled wallet, pay for a token search and a quote to swap 1 USDC for cirBTC with x402, inspect the unsigned swap, optionally send it through Circle, and check the fill with the free receipt endpoint. The public service is on Arc mainnet; the arcgate localnet is on Arc testnet. |
| [MetaMask Agent Wallet → Arcgate](arc-metamask/README.md) | Connect a MetaMask Agent Wallet with the `mm` CLI, pay for API calls with x402, quote 0.50 USDC for cirBTC, sign a Permit2 permit and send the swap through MetaMask. The public service is on Arc mainnet; the localnet takes payments on Arc testnet and supports preview only. Every wallet command runs in MetaMask's Beast Mode, since Guard Mode can't simulate the swap on Arc yet. |
| [Agent box → Arcgate](arc-agent-box/README.md) | Create a box for an agent to hold messages, an inbound address that outside services post to, three watches and a webhook channel. A private-key wallet pays for calls with x402 on Arc and signs the owner calls. |
| [Arcgate as a paid MCP server](arc-mcp/README.md) | Connect an MCP client to Arcgate's `/mcp` endpoint, list its tools, call the free ones, pay for `tradeSearch`, `tradeQuote` and `boxCreate` with x402 on Arc. Then point Claude Code, Claude Desktop or Codex at the same server and see what a host that cannot pay gets. |
| [Claude Agent SDK bot → Arcgate](arc-claude-agent/README.md) | Build a Claude Agent SDK bot that sets up a box, a screen watch and an inbound address from one sentence, paying over x402 on Arc under a per-run cap. It then reads the box, summarises each message as untrusted data and deletes what it summarised. |

Each tutorial contains its complete source, dependency lockfile, configuration example, and tests. Start inside the tutorial's directory.

API reference: [docs.arcgate.dev](https://docs.arcgate.dev). Machine-readable contract: [OpenAPI](https://api.arcgate.dev/openapi.json).
