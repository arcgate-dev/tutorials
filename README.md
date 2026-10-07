# Arcgate tutorials

Connect your wallet to [api.arcgate.dev](https://api.arcgate.dev). Arcgate searches for tokens, quotes trades, and returns unsigned swap transactions on Arc. Your wallet signs payments and sends transactions.

| Tutorial | What you will build |
| --- | --- |
| [Circle wallet → Arcgate](arc-circle/README.md) | Connect a Circle developer-controlled wallet, pay for API calls by x402 on Arc mainnet, or on Arc testnet against the arcgate localnet, and trade USDC for cirBTC. |
| [MetaMask Agent Wallet → Arcgate](arc-metamask/README.md) | Connect a MetaMask Agent Wallet with the `mm` CLI, pay for API calls with x402, sign a Permit2 permit, and trade USDC for cirBTC. The trade runs in MetaMask's Beast Mode, since Guard Mode can't simulate the swap on Arc yet. |
| [Agent box → Arcgate](arc-agent-box/README.md) | Give an agent a box, an inbound address for outside services, three watches (a token watch and a screen over Arcgate's index plus an agent screen over the agent directory) and a webhook channel, with a private-key wallet: paid calls over x402 and owner calls signed by the wallet. It runs against an arcgate localnet until production serves /agent/v1. |
| [Arcgate as a paid MCP server](arc-mcp/README.md) | Connect an MCP client to Arcgate's `/mcp` endpoint, list its tools, call the free ones, pay for `tradeSearch`, `tradeQuote` and `boxCreate` with x402 on Arc under a per-call and a per-run cap, and read the box with an agent signature (`boxStatus` first). Add Arcgate to Claude Code, Claude Desktop or Codex, and see what a host that can't pay gets: the price, as a tool result. It runs against an arcgate localnet until production serves /mcp. |
| [Claude Agent SDK bot → Arcgate](arc-claude-agent/README.md) | Build a Claude Agent SDK bot that turns one sentence into a box, a screen watch and an inbound address through an in-process MCP server that fills the box address, signs owner calls, pays over x402 under a per-run cap and keeps the inbound secret from the model, then watches the box, summarises each message as untrusted data and deletes it. It runs against an arcgate localnet until production serves /mcp. |

Each tutorial contains its complete source, dependency lockfile, configuration example, and tests. Start inside the tutorial's directory.

API reference: [docs.arcgate.dev](https://docs.arcgate.dev). Machine-readable contract: [OpenAPI](https://api.arcgate.dev/openapi.json).
