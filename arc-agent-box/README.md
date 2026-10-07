# Give an agent a box, inbound address, watches and a channel

Create an agent box on Arcgate to hold messages from watches and inbound posts, then read them. Your private-key wallet calls create-like operations with x402 payments and reads status/list/fetch/delete owner operations with EIP-712 signatures.

## Vocabulary

- **Box**: A message store for an agent on a single address. A box cannot be deleted; it holds an allowance of messages that expires after a time.
- **Inbound address**: An endpoint on the notifier origin where outside services post messages to the box. Each address has a secret for authentication.
- **Token watch**: A watch {kind:'token', token, where:[{field, op, value}]} that fires when the named token meets its clauses. It is a screen of one token: same clauses, AND only, one to eight.
- **Screen**: A watch {kind:'screen', where:[{field, op, value}]} that fires when any token meets all clauses. Same clauses as a token watch, AND only, one to eight.
- **Agent screen**: A watch {kind:'agents', chainId, on?, where?} that fires when an agent registers in the chain's agent directory (if 'registered' is in on) or changes (if 'updated' is in on), optionally narrowed by where clauses.
- **Agent watch**: A watch {kind:'agent', chainId, agentId, on?} that watches one named agent for changes: updated, owner_changed, wallet_changed, uri_changed, feedback, fetch_failed, fetch_ok.
- **Channel**: A webhook or Telegram chat to which arcgate pushes the box's messages its filter takes (watch.token, watch.screen, watch.agent, inbound, notice; every type by default); the box stays the record. The filter's 'watch' kind is shorthand for the three watch types.
- **Message**: An event stored in the box: an inbound post, a watch hit, or a notice from arcgate. A watch hit is a watch.token, watch.screen, or watch.agent message.
- **Allowance**: The box's limit on how many messages it can store and how long it can keep them. Top-up adds more.

A box persists; once created it is not deleted. Creating it a second time answers 409 box_exists. Use a dedicated key for this box: once an address has a box, it has one for good, so use a key you need for nothing else.

## Before you start

**Warnings:**
- Every tutorial that uses the same key shares one box, and `npm run cleanup` (and the cleanup at the end of `npm start`) deletes every inbound address, watch and webhook in that box, including ones another tutorial created; messages stay.
- A key that already has a box skips the 0.05 USDC box payment, so the start command costs about 0.105 USDC instead of 0.155 on a box that exists.

**Setup:**
- **Node.js 22.9 or newer** and npm.
- **A fresh private key** kept in `.env` (never shared, never on a command line). The key must hold about 3 USDC on **Arc testnet** (chain `eip155:5042002`). Both payments and gas use USDC. The wallet USDC must be at least 0.16 USDC (the per-run cap) before the first payment.
- **ARC_RPC_URL** must be an RPC for Arc testnet (the network where x402 payments settle). The chainId is checked against the 402's network.

The localnet API (http://127.0.0.1:19800) takes x402 payments on Arc testnet (eip155:5042002), so your key pays in testnet USDC. Arcgate production does not serve `/agent/v1` yet; use localnet for now.

Only `npm test` runs offline against a recorded fixture.

```sh
git clone https://github.com/arcgate-dev/tutorials.git
cd tutorials/arc-agent-box
npm ci
cp .env.example .env
```

Edit `.env` with a test private key (never a real key) and testnet RPC:

```sh
PRIVATE_KEY=0x...
API_URL=http://127.0.0.1:19800
ARC_RPC_URL=<Arc testnet RPC>
```

WEBHOOK_URL defaults to `https://192.0.2.10/arc-agent-box`, which only localnet's mock receiver answers. In production, it must be an https URL you own that echoes the ownership challenge.

## Commands and prices

Each `npm run` command is a step or a group of steps. Every command starts a new run with its own spending cap.

| Command | What it does | API fees |
| --- | --- | --- |
| `npm run box` | Creates or checks the box | 0.050 USDC (if created) |
| `npm run inbound` | Creates an inbound address and tests its secret rotation | 0.010 USDC |
| `npm run watch` | Creates three watches (token watch, screen and agent screen) and searches the token to fire them | 0.035 USDC |
| `npm run channel` | Creates a webhook channel and waits for the ownership challenge | 0.010 USDC |
| `npm run messages` | Waits for a watch hit, lists every page, fetches the newest inbound message and deletes it only when another inbound message stays | Free |
| `npm run topup` | Tops up the box's message allowance | 0.050 USDC (if charged) |
| `npm run cleanup` | Deletes the inbound address, watches and channels | Free |
| `npm run start` | Runs all seven steps, then verifies the box | About 0.155 USDC on a fresh box; 0.105 USDC when the box exists |
| `npm run capture` | npm start, whose topup is charged, then two extra topup runs of which at least one is 409 allowance_full and the first may be charged or 409; recorded to test/fixtures/localnet.json with secrets redacted | whatever the recorded run settled: the start run plus any charged extra topup (0.105 USDC in the recorded run) |
| `npm test` | Replays test/fixtures/localnet.json offline | Free |

Prices are read once per run from `GET /openapi.json` (x-payment.baseUnits) at runtime and enforced within your per-call cap (0.05 USDC) and per-run cap (0.16 USDC). An offer that differs is refused. API errors are not charged. A 409 (box_exists, allowance_full) or 403 payer_not_box is answered without settlement, so nothing is charged (paymentResponse is null in the log). Each `npm run watch` or `npm start` adds three watches with no dedupe: run `npm run cleanup` between attempts.

## How each call is authenticated

Arcgate has three authentication schemes:

**1. x402 (paid operations): boxCreate, boxTopUp, inboundCreate, watchCreate, webhookCreate, tradeSearch**

- **File and function**: `src/payment.js`, `createArcgateClient()`
- **Flow**: The API returns HTTP 402 with an x402 `PAYMENT-REQUIRED` header. The SDK signs an EIP-3009 `TransferWithAuthorization` of USDC to the API's fee recipient, encodes it in a `PAYMENT-SIGNATURE` header, and retries. The server settles the payment onchain and returns the paid answer.
- **Settlement**: The response has a `PAYMENT-RESPONSE` header with the transaction hash. inboundCreate, watchCreate and webhookCreate must be paid by the box's own address; if a different payer is used, the API returns 403 payer_not_box without settlement (no payment is charged).

**2. EIP-712 AgentRequest (owner operations): all list/fetch/delete/rotate/status calls**

- **File and function**: `src/agent.js`, `agentTypedData()` and `createAgentClient()`
- **Message fields**:
  - `address` (address): the box's address
  - `method` (string): GET, POST, or DELETE
  - `path` (string): the lowercased, filled-in path
  - `bodyHash` (bytes32): keccak256 of canonical JSON if the body is present, else keccak256 of empty bytes
  - `nonce` (bytes32): random
  - `expiry` (uint64): now + 60 seconds (the API refuses an expiry more than 300 s ahead)
- **Domain**: name 'arcgate', version '1' (no chainId)
- **Query**: for a message list, the query actually sent is the signed body, with cursor as a number; this tutorial sends no limit
- **Headers**: `AGENT-SIGNATURE`, `AGENT-NONCE`, `AGENT-EXPIRY`
- **Source files**: `src/agent.js` (`agentTypedData`, `createAgentClient`)

**3. Inbound posts (external services to the notifier origin)**

- **File and function**: `src/inbound.js`, `postInbound()`
- **Authentication**: Either `INBOUND-SIGNATURE` (HMAC-SHA256 keyed by the secret over `${timestamp}.` + raw body bytes) sent with `INBOUND-TIMESTAMP`, or the secret itself in `INBOUND-SECRET`
- **Note**: No wallet is involved; a sender without signing capability can use the secret.

## 1. Create the box

```sh
npm run box
```

The box is a message store for an agent. The step reads `boxStatus` first (free, signed). If the box exists (200), nothing is created and no payment is signed. If it does not exist (404 box_not_found), `boxCreate` is paid.

An existing box is reported with no payment signed. Each command prints 'Run log: .runs/<uuid>.jsonl' and appends one JSON line per signed payment, settled payment and API error (src/main.js, file mode 0600). On a key with no box, the run log shows the expected 404 as an error line.

Example boxStatus (existing box, not paid):

<!-- exchange 2 -->
```json
{
  "address": "0x06e594c677cd28643b82477b7b5328ac6817b2a0",
  "createdAt": 1791365243,
  "allowance": {
    "messagesLeft": 999,
    "expiresAt": 1796549243,
    "expired": false
  },
  "counts": {
    "messages": 0,
    "inboundAddresses": 1,
    "watches": 1,
    "channels": 0
  },
  "unstoredWatchHits": 0,
  "registeredAgents": {
    "chainId": 5042,
    "agents": []
  }
}
```

Example boxCreate response, from the 2026-10-06 capture (arcgate 917dd4a, a fresh key; exchange 4 of that fixture, no longer in localnet.json):

```json
{
  "address": "0x4189bc425bd880b163f386e5d5270fccb2c0a478",
  "granted": {
    "messages": 500,
    "days": 30
  },
  "allowance": {
    "messagesLeft": 500,
    "expiresAt": 1793918600
  }
}
```

The `address` is your wallet's address. `messagesLeft` and `expiresAt` are the current allowance. When the allowance runs out or expires, you must top up to receive more messages. A box cannot be deleted.

## 2. Create an inbound address

```sh
npm run inbound
```

An inbound address is an endpoint on the notifier origin where outside services post messages. The address has a secret that rotates; old secrets are refused, new ones are accepted.

The step sequence:
1. Create the address (paid)
2. Post to it with a signature (201 stored)
3. Rotate the secret; the old secret is killed at once
4. Post with the old secret (401 inbound_unauthorized)
5. Post with the new secret (201 stored)

An identical body is answered 200 duplicate (idempotent).

The URL is on the notifier origin (like `http://127.0.0.1:19803/<id>`, one path segment).

Example inbound address response (paid, exchange 4):

<!-- exchange 4 -->
```json
{
  "id": "jGzJwc9Ho_38jtTnloOKug",
  "url": "http://127.0.0.1:19803/jGzJwc9Ho_38jtTnloOKug",
  "secret": "<redacted>",
  "createdAt": 1791388325
}
```

The secret is shown once and kept in memory only. POST to the URL with `INBOUND-SECRET: <secret>` or with `INBOUND-SIGNATURE` and `INBOUND-TIMESTAMP`. Example signature post (exchange 5, unpaid):

<!-- exchange 5 -->
```json
{
  "stored": true,
  "idempotencyKey": "0xddb848e2dc335c12908245546090a6f32f5b4f9711d554579fe1763cd9f77f7b"
}
```

After rotation (exchange 6), the old secret is refused (exchange 7):

<!-- exchange 7 -->
```json
{
  "error": {
    "code": "inbound_unauthorized",
    "message": "send a valid INBOUND-SIGNATURE (with INBOUND-TIMESTAMP) or the address's INBOUND-SECRET"
  },
  "next": "fix_request"
}
```

And the new secret is accepted (exchange 8):

<!-- exchange 8 -->
```json
{
  "stored": true,
  "idempotencyKey": "0xc5dcdb22b6b6f4fb7902d1a4966adc51a3752ff8ad52050d2e8d9505e58fc05d"
}
```

## 3. Create watches

```sh
npm run watch
```

The step creates three watches and searches the token to trigger the index. The first is a token watch: a screen of one named token, watching 24-hour volume on FAZE (the default `WATCH_TOKEN`). The second is a screen: a multi-field watch over every token in the index, watching volume and safety verdict. The third is an agent screen: a watch over Arc mainnet's agent directory that fires when an agent registers.

With the indexer off (health indexer:null), a watch fires only when a search checks a token. A token is checked once per safety TTL; a rerun may see no new hit. Set WATCH_TOKEN to another token on a rerun. Watches fire on an edge with a cooldown (agent.watch.cooldown_seconds 3600).

The agent screen watches Arc mainnet's agent directory; `chainId: 5042` is the directory's chain, shown as `boxStatus.registeredAgents.chainId` in the first example. On localnet no agent registers during a run, so the agent screen is created and listed only and never fires. The old `{kind:'volume_24h', direction}` watch shape is now refused with 400 invalid_request 'No matching discriminator' (see Troubleshooting).

Example token watch response (paid):

<!-- exchange 10 -->
```json
{
  "id": "dvxnlleAXUxG4_oP5ZLgmw",
  "condition": {
    "kind": "token",
    "token": "0xf81afef268aca40717e0adcae7c41514327cfaab",
    "where": [
      {
        "field": "volume_24h",
        "op": "gt",
        "value": 100000
      }
    ]
  },
  "createdAt": 1791388330
}
```

Example screen watch response (paid):

<!-- exchange 12 -->
```json
{
  "id": "F8erlRYeh-WMOo5n5jq97Q",
  "condition": {
    "kind": "screen",
    "where": [
      {
        "field": "volume_24h",
        "op": "gt",
        "value": 100000
      },
      {
        "field": "safety_verdict",
        "op": "eq",
        "value": "ok"
      }
    ]
  },
  "createdAt": 1791388335
}
```

Example agent screen response (paid):

<!-- exchange 14 -->
```json
{
  "id": "0nmkWVwaNxE2B6OkZfruLw",
  "condition": {
    "kind": "agents",
    "chainId": 5042,
    "on": [
      "registered"
    ]
  },
  "createdAt": 1791388339
}
```

Example watchList (after all three watches are created):

<!-- exchange 15 -->
```json
{
  "watches": [
    {
      "id": "oGnXYai82uHjRH_M6rQtVg",
      "condition": {
        "kind": "screen",
        "where": [
          {
            "field": "volume_24h",
            "op": "gt",
            "value": 50000
          },
          {
            "field": "safety_verdict",
            "op": "eq",
            "value": "ok"
          }
        ]
      },
      "createdAt": 1791386194,
      "lastFiredAt": null,
      "matchingTokens": 0
    },
    {
      "id": "dvxnlleAXUxG4_oP5ZLgmw",
      "condition": {
        "kind": "token",
        "token": "0xf81afef268aca40717e0adcae7c41514327cfaab",
        "where": [
          {
            "field": "volume_24h",
            "op": "gt",
            "value": 100000
          }
        ]
      },
      "createdAt": 1791388335,
      "lastFiredAt": null,
      "matchingTokens": null
    },
    {
      "id": "F8erlRYeh-WMOo5n5jq97Q",
      "condition": {
        "kind": "screen",
        "where": [
          {
            "field": "volume_24h",
            "op": "gt",
            "value": 100000
          },
          {
            "field": "safety_verdict",
            "op": "eq",
            "value": "ok"
          }
        ]
      },
      "createdAt": 1791388339,
      "lastFiredAt": null,
      "matchingTokens": 0
    },
    {
      "id": "0nmkWVwaNxE2B6OkZfruLw",
      "condition": {
        "kind": "agents",
        "chainId": 5042,
        "on": [
          "registered"
        ]
      },
      "createdAt": 1791388344,
      "lastFiredAt": null,
      "matchingTokens": null
    }
  ]
}
```

The list's first watch is another tutorial's screen on the same shared box, which cleanup later deleted (exchange 33).

## 4. Create a webhook channel

```sh
npm run channel
```

A webhook channel sends inbound and watch messages to a URL. The step creates a webhook with a filter for `inbound` and `watch` messages, waits for the webhook URL's receiver to answer the ownership challenge, and rotates the secret.

Arcgate POSTs a challenge to the URL once the payment settles. The receiver must echo the challenge; nothing is delivered until this ownership check passes. When Arcgate later delivers a message, it POSTs to the URL with `ARCGATE-SIGNATURE` and `ARCGATE-TIMESTAMP` headers.

Example webhook response (paid, exchange 19):

<!-- exchange 19 -->
```json
{
  "id": "_XsK9A9S7cox8eD0TPl7Kg",
  "url": "https://192.0.2.10/arc-agent-box",
  "secret": "<redacted>",
  "filter": [
    "inbound",
    "watch"
  ],
  "createdAt": 1791388349
}
```

The step polls webhookList until verifiedAt is set (null before the URL answers the challenge, then a timestamp). The filter in the listing is checked against the one sent.

Example before verification (exchange 20):

<!-- exchange 20 -->
```json
{
  "webhooks": [
    {
      "id": "_XsK9A9S7cox8eD0TPl7Kg",
      "url": "https://192.0.2.10/arc-agent-box",
      "filter": [
        "inbound",
        "watch"
      ],
      "enabled": true,
      "verifiedAt": null,
      "failures": 0,
      "lastError": null,
      "createdAt": 1791388354
    }
  ]
}
```

After verification (exchange 21):

<!-- exchange 21 -->
```json
{
  "webhooks": [
    {
      "id": "_XsK9A9S7cox8eD0TPl7Kg",
      "url": "https://192.0.2.10/arc-agent-box",
      "filter": [
        "inbound",
        "watch"
      ],
      "enabled": true,
      "verifiedAt": 1791388354,
      "failures": 0,
      "lastError": null,
      "createdAt": 1791388354
    }
  ]
}
```

The step then calls webhookRotate (exchange 22) to rotate the channel's secret.

## 5. Wait for messages

```sh
npm run messages
```

This step waits up to 180 seconds for a watch to fire. It then lists all messages from the box by cursor until an empty page, fetches the newest inbound message, and deletes it if the box holds two or more inbound messages. If there is only one inbound message, it is kept.

The step reads the box from the start, so on a rerun a watch hit still held from an earlier run ends the wait at once. A new hit is not required. On a box shared with another tutorial, that tutorial's watch hit can end the 180-second wait.

When a watch fires, arcgate stores a message to the box. A `watch.token` or `watch.screen` hit's content is `{watchId, condition, changeId, token, symbol, observed}`, where `observed` is keyed by each clause's field (e.g., `{"volume_24h": 6112809.322525}`). The `previous` field appears only if the watch has a `changes` clause and the value changed, and `newest` (for lookalikes clauses) appears only then too. An `inbound` message contains the source address ID. A `watch.agent` hit's content is `{watchId, condition, changeId, chainId, agentId, change, agent}`, where `change` is what happened: `registered` or `updated` for an agent screen, or one of an agent watch's kinds (updated, owner_changed, wallet_changed, uri_changed, feedback, fetch_failed, fetch_ok). An agent screen fires only when an agent is registered or updated. The `previous` and `current` fields hold the old and new values only for owner_changed or wallet_changed.

A delete frees space but refunds no allowance.

Messages are paged by cursor until an empty page arrives (messages empty, nextCursor unchanged).

Example messages list (exchange 23, trimmed: idempotencyKey and box removed from each message):

<!-- exchange 23 -->
```json
{
  "messages": [
    {
      "kind": "inbound",
      "type": "inbound",
      "seq": 12,
      "createdAt": 1791388330,
      "expiresAt": 1793980330,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"run\":\"ab561c2f-7aa0-4d70-a810-604c62e4269d\",\"via\":\"signature\",\"sentAt\":1791388330266,\"note\":\"a message from an outside service\"}"
      },
      "source": {
        "inboundAddressId": "jGzJwc9Ho_38jtTnloOKug",
        "signatureVerified": true
      }
    },
    {
      "kind": "inbound",
      "type": "inbound",
      "seq": 13,
      "createdAt": 1791388330,
      "expiresAt": 1793980330,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"run\":\"ab561c2f-7aa0-4d70-a810-604c62e4269d\",\"via\":\"secret\",\"sentAt\":1791388330285,\"note\":\"a message from an outside service\"}"
      },
      "source": {
        "inboundAddressId": "jGzJwc9Ho_38jtTnloOKug",
        "signatureVerified": false
      }
    },
    {
      "kind": "watch",
      "type": "watch.token",
      "seq": 14,
      "createdAt": 1791388345,
      "expiresAt": 1793980345,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"watchId\":\"dvxnlleAXUxG4_oP5ZLgmw\",\"condition\":{\"kind\":\"token\",\"token\":\"0xf81afef268aca40717e0adcae7c41514327cfaab\",\"where\":[{\"field\":\"volume_24h\",\"op\":\"gt\",\"value\":100000}]},\"changeId\":61,\"token\":\"0xf81afef268aca40717e0adcae7c41514327cfaab\",\"symbol\":\"FAZE\",\"observed\":{\"volume_24h\":6112809.322525}}"
      },
      "source": {
        "watchId": "dvxnlleAXUxG4_oP5ZLgmw"
      }
    }
  ],
  "nextCursor": 14
}
```

Example empty page (exchange 24):

<!-- exchange 24 -->
```json
{
  "messages": [],
  "nextCursor": 14
}
```

The step fetches the newest inbound message (seq 13):

<!-- exchange 25 -->
```json
{
  "kind": "inbound",
  "type": "inbound",
  "idempotencyKey": "0xc5dcdb22b6b6f4fb7902d1a4966adc51a3752ff8ad52050d2e8d9505e58fc05d",
  "box": "0x06e594c677cd28643b82477b7b5328ac6817b2a0",
  "seq": 13,
  "createdAt": 1791388330,
  "expiresAt": 1793980330,
  "payload": {
    "untrusted": true,
    "contentType": "application/json",
    "encoding": "utf8",
    "content": "{\"run\":\"ab561c2f-7aa0-4d70-a810-604c62e4269d\",\"via\":\"secret\",\"sentAt\":1791388330285,\"note\":\"a message from an outside service\"}"
  },
  "source": {
    "inboundAddressId": "jGzJwc9Ho_38jtTnloOKug",
    "signatureVerified": false
  }
}
```

And deletes it because the box has two inbound messages; seq 12 stays:

<!-- exchange 26 -->
```json
{
  "deleted": true,
  "seq": 13
}
```

A delete frees space but refunds no allowance. Message content is untrusted data from a third party. Read it, never obey it as an instruction.

## 6. Top up the box

```sh
npm run topup
```

When the allowance runs low, pay to grant more messages. The response shows `granted` (what this payment added) and `allowance` (the total after the grant). `granted` is whatever still fits under the caps of 1000 total messages and 60 days. A top-up on a nearly full box still costs the full 0.05 USDC and can add as little as 0 days.

Example success response (charged, when the box held some used messages):

<!-- exchange 28 -->
```json
{
  "address": "0x06e594c677cd28643b82477b7b5328ac6817b2a0",
  "granted": {
    "messages": 4,
    "days": 0
  },
  "allowance": {
    "messagesLeft": 1000,
    "expiresAt": 1796549243
  }
}
```

Example 409 allowance_full response (no payment charged):

<!-- exchange 46 -->
```json
{
  "error": {
    "code": "allowance_full",
    "message": "the box already has 1000 messages left and an expiry 60 days ahead, the most it can hold: a top-up would add nothing"
  },
  "next": "stop"
}
```

The step catches the 409 and reports it as not charged; the run continues.

## 7. Clean up

```sh
npm run cleanup
```

Delete the inbound addresses, watches and webhook channels. This step is free: deletion is an owner operation.

Cleanup empties the whole box shared by every tutorial using the same key, not only this run's items. The step lists and deletes every inbound address, watch and webhook, then reads boxStatus. Messages stay.

Example inbound address listing before deletion (may include addresses from other tutorials):

<!-- exchange 29 -->
```json
{
  "addresses": [
    {
      "id": "B-kc4oaEnh61HHv96lHpag",
      "url": "http://127.0.0.1:19803/B-kc4oaEnh61HHv96lHpag",
      "createdAt": 1791386196
    },
    {
      "id": "jGzJwc9Ho_38jtTnloOKug",
      "url": "http://127.0.0.1:19803/jGzJwc9Ho_38jtTnloOKug",
      "createdAt": 1791388330
    }
  ]
}
```

Example final boxStatus after deletion:

<!-- exchange 39 -->

```json
{
  "address": "0x06e594c677cd28643b82477b7b5328ac6817b2a0",
  "createdAt": 1791365243,
  "allowance": {
    "messagesLeft": 1000,
    "expiresAt": 1796549243,
    "expired": false
  },
  "counts": {
    "messages": 2,
    "inboundAddresses": 0,
    "watches": 0,
    "channels": 0
  },
  "unstoredWatchHits": 0,
  "registeredAgents": {
    "chainId": 5042,
    "agents": []
  }
}
```

Note: messages stay (count 2). The inbound addresses, watches and channels are now all zero.

## Turning a channel off and Telegram

There is no webhookDisable route. To disable a channel, delete it or create one with a narrower filter.

After agent.channel.max_failures (12) failed deliveries in a row, arcgate disables the channel and stores a notice message in the box. webhookEnable only resumes such a channel; this tutorial never calls it.

Telegram channels work the same way as webhooks: they are created with a cost, have filters, are listed and deleted. `telegramCreate` costs 0.01 USDC, one per box, and is created unlinked. A chat is linked by sending its one-time code to Arcgate's bot as `/start <code>`, and `/stop` unlinks it. `telegramLink` issues a new one-time code. Telegram is outbound only; this tutorial needs no Telegram account.

## Troubleshooting and tests

**Error codes**:

- **box_exists**: A second boxCreate answered 409 instead of creating another box.
- **box_not_found**: boxStatus returned 404 before a successful boxCreate. Expected on the first run; the step creates the box.
- **allowance_full**: The box is at 1000 messages and 60 days. No payment is charged and the run continues.
- **payer_not_box** (403): A paid call was made by a different address. The API did not settle, so nothing was charged (paymentResponse is null).
- **inbound_unauthorized** (401): An inbound post used an old secret or wrong signature. Rotate kills the old secret at once.
- **signature_* or nonce_reused** (401): An owner call's signature was invalid or stale. Sign again with a fresh nonce and expiry.
- **rate_limited** (429): The address hit a rate limit. Retry after a delay.
- **allowance_exhausted** (402): An inbound post arrived but the box's allowance is out. No message was stored. Top up to add more.
- **watch_limit** (409): A box collected watches across multiple attempts without cleanup (no dedupe). Run `npm run cleanup` between attempts.
- **No matching discriminator** (400 invalid_request): A watch condition in a retired shape (e.g., the old `{kind:'volume_24h', direction}` instead of `{kind:'token', where:[{field:'volume_24h', op:'gt', value}]}`). Update to the current tutorial: the watch conditions are built in src/config.js (tokenWatch, SCREEN_WATCH, AGENTS_WATCH).
- **No watch hit on localnet**: Set WATCH_TOKEN to a different token. cirBTC is pinned and never checked; FAZE is checkable but only once per safety TTL. On a rerun, set WATCH_TOKEN to try another token.
- **Unreadable response after signing**: A payment was signed but the response body could not be parsed as JSON. This is what happens if a 402 has an empty body: http.js readApiResponse throws, '<operation>: unreadable response (HTTP 402, requestId=…). Outcome may be uncertain; do not automatically retry.' Check the run log for a settled entry and the USDC balance before starting another paid run.

Run the offline test suite:

```sh
npm test
```

The tests replay test/fixtures/localnet.json offline, exercising the payment signature flow, owner call signatures, inbound secret rotation, per-run spending caps, and error handling. The fixture was captured by `npm run capture` on a localnet run (arcgate 12b0368f, Arc testnet), with secrets redacted. The capture contract is: `npm run start` (all seven steps, whose topup is charged, a nearly full box can grant 0 days), then two extra `npm run topup` runs, of which at least one is 409 allowance_full and the first may be charged or 409. In the recorded run both extra topups were 409, so the capture settled 0.105 USDC.

To record a new capture from a running localnet:

```sh
CAPTURE_API_COMMIT=<arcgate HEAD> npm run capture
```

This runs the start command (whose topup is charged) under a recording fetch, then captures two extra topup runs, and writes test/fixtures/localnet.json with redacted secrets.

For more information, see [Arcgate docs](https://docs.arcgate.dev) and the test evidence in [VALIDATION.md](VALIDATION.md).
