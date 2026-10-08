# Give an agent a box, inbound address, watches and a channel

Create an agent box on Arcgate to hold messages from watches and inbound posts, then read them. Your private-key wallet pays for create-like operations with x402 payments and reads status, list, fetch and delete operations with EIP-712 signatures.

Everything here runs against production, `https://api.arcgate.dev`, on Arc mainnet (`eip155:5042`). Payments are real USDC. A full run costs 0.155 USDC.

## Vocabulary

- **Box**: A message store for an agent on a single address. A box cannot be deleted; it holds an allowance of messages that expires after a time.
- **Inbound address**: An endpoint where outside services post messages to the box. Each address has a secret for authentication.
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
- A key that already has a box skips the 0.05 USDC box payment, so the start command costs 0.055 to 0.105 USDC instead of 0.155 (0.055 when the top-up answers allowance_full and is not charged).

**Setup:**
- **Node.js 22.9 or newer** and npm.
- **A fresh private key** kept in `.env` (never shared, never on a command line). Fund it with USDC on **Arc mainnet** (chain `eip155:5042`). Each command checks, before its first payment, that the wallet holds at least 0.16 USDC (the per-run cap). So `npm start` on a fresh key needs at least 0.16 USDC (about 0.20 is comfortable). Running the steps one command at a time needs at least 0.265 USDC: 0.105 is spent before `npm run topup`, which then checks for 0.16 again.
- **No separate gas.** x402 payments are EIP-3009 authorizations that the API submits, so the wallet needs only USDC.
- **ARC_RPC_URL** must be an RPC for Arc mainnet (default `https://rpc.mainnet.arc.io`). The chainId is checked against the 402's network.
- **cloudflared**, to give the webhook receiver a public https URL (see below).

Only `npm test` runs offline against a recorded fixture.

```sh
git clone https://github.com/arcgate-dev/tutorials.git
cd tutorials/arc-agent-box
npm ci
cp .env.example .env
```

Edit `.env`:

```sh
PRIVATE_KEY=0x...
# Optional; these are the defaults:
API_URL=https://api.arcgate.dev
ARC_RPC_URL=https://rpc.mainnet.arc.io
# Required for the channel step and npm start; see "Start the receiver" below:
WEBHOOK_URL=https://<words>.trycloudflare.com
```

### Start the receiver

A webhook channel needs a public https URL that answers arcgate's ownership challenge. This tutorial ships a small receiver for that and uses a Cloudflare quick tunnel to make it public.

1. Install cloudflared: `brew install cloudflared` on macOS. On other systems, use Cloudflare's [downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Terminal 1: `npm run receiver`. It listens on `http://localhost:8787` (set `PORT` to change it).
3. Terminal 2: `cloudflared tunnel --url http://localhost:8787`. It prints an `https://<words>.trycloudflare.com` URL.
4. Copy that URL into `.env` as `WEBHOOK_URL`. No trailing path is needed.
5. Terminal 3: run the steps below.

Quick tunnels get a new URL each time. When you restart the tunnel, update `WEBHOOK_URL`.

The receiver answers `{type:"challenge", channelId, challenge}` with `{"challenge": <same value>}`. For each message arcgate pushes, it prints one line: the type, the seq and the `ARCGATE-TIMESTAMP`, never the content. It does not check `ARCGATE-SIGNATURE`, because the channel step does not keep the secret. A receiver you keep must verify it: HMAC-SHA256 hex, keyed by the secret, over `${ARCGATE-TIMESTAMP}.` plus the raw body. Reject timestamps more than 5 minutes off.

`npm run channel` and `npm start` refuse to run without `WEBHOOK_URL`: "Set WEBHOOK_URL in .env to the https URL of your receiver (npm run receiver behind a tunnel). No payment signed."

## Run everything

With the receiver and tunnel up:

```sh
npm start
```

This runs all seven steps below in one run with one spending cap, then verifies the box. On a fresh key it costs 0.155 USDC: box 0.05, inbound address 0.01, three watches 0.03, search 0.005, webhook 0.01, top-up 0.05.

The top-up is charged on a fresh box. A new box holds 500 messages and 30 days. A top-up adds up to what fits under 1000 messages and 60 days, so it grants 500 messages and 30 days.

The numbered sections explain each step with output captured from production on 2026-10-08. Each names the command that runs that step alone.

## Commands and prices

Each `npm run` command is a step or a group of steps. Every command starts a new run with its own spending cap.

| Command | What it does | API fees |
| --- | --- | --- |
| `npm run receiver` | Local webhook receiver on port 8787 | Free |
| `npm run box` | Creates or checks the box | 0.050 USDC (if created) |
| `npm run inbound` | Creates an inbound address and tests its secret rotation | 0.010 USDC |
| `npm run watch` | Creates three watches (token watch, screen and agent screen) and searches the token | 0.035 USDC |
| `npm run channel` | Creates a webhook channel and waits for the ownership challenge | 0.010 USDC |
| `npm run messages` | Waits for a watch hit, lists every page, fetches the newest inbound message and deletes it only when another inbound message stays | Free |
| `npm run topup` | Tops up the box's message allowance | 0.050 USDC (if charged) |
| `npm run cleanup` | Deletes the inbound addresses, watches and channels | Free |
| `npm start` | Runs all seven steps, then verifies the box | 0.155 USDC on a fresh box |
| `npm run channel`, then `npm run inbound` | Step 8: shows a push reaching the receiver | 0.020 USDC |
| `npm test` | Replays test/fixtures/mainnet.json offline | Free |
| `npm run capture` | Maintainer: re-records test/fixtures/mainnet.json against production (see Tests) | The start run plus any charged extra top-up |

Prices as of 2026-10-08, from `https://api.arcgate.dev/openapi.json` (`x-payment.baseUnits`, 6 decimals, USDC): boxCreate 0.05, boxTopUp 0.05, inboundCreate 0.01, watchCreate 0.01 each, webhookCreate 0.01, tradeSearch 0.005.

The code reads prices from that document at runtime. It refuses an offer above the per-call cap (0.05 USDC) or a run that would pass the per-run cap (0.16 USDC). A 409 (box_exists, allowance_full) or 403 payer_not_box is answered without settlement, so nothing is charged (paymentResponse is null in the log). A 502 on a paid call, or a settlement failure with `payment_response_expired`, may have settled; the error then says `; the payment may have settled; check the PAYMENT-RESPONSE transaction or your USDC balance before paying again`. Each `npm run watch` or `npm start` adds three watches with no dedupe: run `npm run cleanup` between attempts.

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

**3. Inbound posts (external services to the inbound address)**

- **File and function**: `src/inbound.js`, `postInbound()`
- **Authentication**: Either `INBOUND-SIGNATURE` (HMAC-SHA256 keyed by the secret over `${timestamp}.` + raw body bytes) sent with `INBOUND-TIMESTAMP`, or the secret itself in `INBOUND-SECRET`
- **Note**: No wallet is involved; a sender without signing capability can use the secret.

## 1. Create the box

```sh
npm run box
```

The box is a message store for an agent. The step reads `boxStatus` first (free, signed). If the box exists (200), nothing is created and no payment is signed. If it does not exist (404 box_not_found), `boxCreate` is paid.

Each command prints 'Run log: .runs/<uuid>.jsonl' and appends one JSON line per signed payment, settled payment and API error (src/main.js, file mode 0600). On a key with no box, the run log shows the expected 404 as an error line.

On a fresh key, boxStatus answers 404:

<!-- exchange 2 -->
```json
{
  "error": {
    "code": "box_not_found",
    "message": "this address has no box"
  },
  "next": "fix_request"
}
```

Then `boxCreate` is paid (0.05 USDC) and answers:

<!-- exchange 4 -->
```json
{
  "address": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "granted": {
    "messages": 500,
    "days": 30
  },
  "allowance": {
    "messagesLeft": 500,
    "expiresAt": 1794064560
  }
}
```

The step reads the box back with a signed boxStatus:

<!-- exchange 5 -->
```json
{
  "address": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "createdAt": 1791472564,
  "allowance": {
    "messagesLeft": 500,
    "expiresAt": 1794064564,
    "expired": false
  },
  "counts": {
    "messages": 0,
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

The `address` is your wallet's address. `messagesLeft` and `expiresAt` are the current allowance. When the allowance runs out or expires, you must top up to receive more messages. A box cannot be deleted.

## 2. Create an inbound address

```sh
npm run inbound
```

An inbound address is an endpoint where outside services post messages. The address has a secret that rotates; old secrets are refused, new ones are accepted.

The step sequence:
1. Create the address (paid)
2. Post to it with a signature (201 stored)
3. Rotate the secret; the old secret is killed at once
4. Post with the old secret (401 inbound_unauthorized)
5. Post with the new secret (201 stored)

An identical body is answered 200 duplicate (idempotent).

The URL is `https://in.arcgate.dev/<id>`, one path segment.

Inbound address response (paid, 0.01 USDC):

<!-- exchange 7 -->
```json
{
  "id": "39GFK4lyg1qyNGsehwQG_Q",
  "url": "https://in.arcgate.dev/39GFK4lyg1qyNGsehwQG_Q",
  "secret": "<redacted>",
  "createdAt": 1791472564
}
```

The secret is shown once and kept in memory only. POST to the URL with `INBOUND-SECRET: <secret>` or with `INBOUND-SIGNATURE` and `INBOUND-TIMESTAMP`. The signature post (unpaid):

<!-- exchange 8 -->
```json
{
  "stored": true,
  "idempotencyKey": "0x4d73f2ee0b8b524101d6bf75932f0e92281c6790f212d2209f73ba23f584676e"
}
```

After the rotation, the old secret is refused:

<!-- exchange 10 -->
```json
{
  "error": {
    "code": "inbound_unauthorized",
    "message": "send a valid INBOUND-SIGNATURE (with INBOUND-TIMESTAMP) or the address's INBOUND-SECRET"
  },
  "next": "fix_request"
}
```

And the new secret is accepted:

<!-- exchange 11 -->
```json
{
  "stored": true,
  "idempotencyKey": "0xce71d260105ae7cfed4a764b718d4527b714a906cc561c268f36298004958d10"
}
```

## 3. Create watches

```sh
npm run watch
```

The step creates three watches, then searches the token once (0.005 USDC). The search makes arcgate look at the token now; a trade on it also makes the index report it, and either can fire the watch. The first is a token watch: a screen of one named token, watching 24-hour volume on FAZE (the default `WATCH_TOKEN`). The second is a screen: a multi-field watch over every token in the index, watching volume and safety verdict. The third is an agent screen: a watch over Arc mainnet's agent directory that fires when an agent registers.

A watch fires on an edge. It fires when the index first reports a token that meets every clause after the watch was created. After it fires, it waits one hour (agent.watch.cooldown_seconds 3600) before it can fire again. If FAZE does not fire, set `WATCH_TOKEN` to another active token.

In this run the token watch fired during the run: its hit is message 3 in step 5. The screen and the agent screen did not fire. The `chainId: 5042` in the agent screen is the directory's chain, the same value as `boxStatus.registeredAgents.chainId`.

Token watch response (paid, 0.01 USDC):

<!-- exchange 13 -->
```json
{
  "id": "ntShCrIdmxt0DKqdcg5vbQ",
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
  "createdAt": 1791472567
}
```

Screen watch response (paid):

<!-- exchange 15 -->
```json
{
  "id": "Ff12vrzahms4kM_YGAV3WQ",
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
  "createdAt": 1791472570
}
```

Agent screen response (paid):

<!-- exchange 17 -->
```json
{
  "id": "cMwxW0sALwz7oLKmFu96pw",
  "condition": {
    "kind": "agents",
    "chainId": 5042,
    "on": [
      "registered"
    ]
  },
  "createdAt": 1791472574
}
```

watchList after all three are created (trimmed: the screen and agent screen items are left out):

<!-- exchange 18 -->
```json
{
  "watches": [
    {
      "id": "ntShCrIdmxt0DKqdcg5vbQ",
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
      "createdAt": 1791472570,
      "lastFiredAt": null,
      "matchingTokens": null
    }
  ]
}
```

## 4. Create a webhook channel

```sh
npm run channel
```

A webhook channel pushes inbound and watch messages to a URL. The step creates a webhook with a filter for `inbound` and `watch` messages, waits for your receiver to answer the ownership challenge, and rotates the secret. It needs `WEBHOOK_URL` and the receiver running (see "Start the receiver").

Arcgate POSTs a challenge to the URL once the payment settles. The receiver must echo the challenge; nothing is delivered until this ownership check passes. When arcgate later pushes a message, it POSTs to the URL with `ARCGATE-SIGNATURE` and `ARCGATE-TIMESTAMP` headers.

Webhook response (paid, 0.01 USDC):

<!-- exchange 22 -->
```json
{
  "id": "NsXiu1aqhJuMUYJsWaxnCg",
  "url": "https://aims-mechanical-cars-sunshine.trycloudflare.com",
  "secret": "<redacted>",
  "filter": [
    "inbound",
    "watch"
  ],
  "createdAt": 1791472581
}
```

The step polls webhookList until verifiedAt is set (null before the URL answers the challenge, then a timestamp). The filter in the listing is checked against the one sent.

Before verification:

<!-- exchange 23 -->
```json
{
  "webhooks": [
    {
      "id": "NsXiu1aqhJuMUYJsWaxnCg",
      "url": "https://aims-mechanical-cars-sunshine.trycloudflare.com",
      "filter": [
        "inbound",
        "watch"
      ],
      "enabled": true,
      "verifiedAt": null,
      "failures": 0,
      "lastError": null,
      "createdAt": 1791472585
    }
  ]
}
```

After verification:

<!-- exchange 24 -->
```json
{
  "webhooks": [
    {
      "id": "NsXiu1aqhJuMUYJsWaxnCg",
      "url": "https://aims-mechanical-cars-sunshine.trycloudflare.com",
      "filter": [
        "inbound",
        "watch"
      ],
      "enabled": true,
      "verifiedAt": 1791472586,
      "failures": 0,
      "lastError": null,
      "createdAt": 1791472585
    }
  ]
}
```

The receiver printed:

```
Receiver listening on http://localhost:8787
Challenge for channel NsXiu1aqhJuMUYJsWaxnCg: echoed.
```

In this run every message was stored before the channel was created (the inbound and watch steps run first), and none arrived while it existed, so the receiver printed only the challenge. `npm start` shows no push for the same reason. Step 8 shows one.

The step then calls webhookRotate to rotate the channel's secret (exchange 25, secret redacted):

<!-- exchange 25 -->
```json
{
  "id": "NsXiu1aqhJuMUYJsWaxnCg",
  "secret": "<redacted>"
}
```

## 5. Wait for messages

```sh
npm run messages
```

This step waits up to 180 seconds for a watch to fire. It then lists all messages from the box by cursor until an empty page, fetches the newest inbound message, and deletes it if the box holds two or more inbound messages. If there is only one inbound message, it is kept.

The step reads the box from the start, so on a rerun a watch hit still held from an earlier run ends the wait at once. A new hit is not required. On a box shared with another tutorial, that tutorial's watch hit can end the 180-second wait.

When a watch fires, arcgate stores a message to the box. A `watch.token` or `watch.screen` hit's content is `{watchId, condition, changeId, token, symbol, observed}`, where `observed` is keyed by each clause's field (e.g., `{"volume_24h": 573697.219512}`). The `previous` field appears only if the watch has a `changes` clause and the value changed, and `newest` (for lookalikes clauses) appears only then too. An `inbound` message contains the source address ID. A `watch.agent` hit's content is `{watchId, condition, changeId, chainId, agentId, change, agent}`, where `change` is what happened: `registered` or `updated` for an agent screen, or one of an agent watch's kinds (updated, owner_changed, wallet_changed, uri_changed, feedback, fetch_failed, fetch_ok). The `previous` and `current` fields hold the old and new values only for owner_changed or wallet_changed.

In this run the box held three messages: 1 inbound, 2 inbound, 3 watch.token. Messages are paged by cursor until an empty page arrives (messages empty, nextCursor unchanged).

Messages list (trimmed: idempotencyKey and box removed from each message):

<!-- exchange 26 -->
```json
{
  "messages": [
    {
      "kind": "inbound",
      "type": "inbound",
      "seq": 1,
      "createdAt": 1791472566,
      "expiresAt": 1794064566,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"run\":\"f489c0a8-0f32-4182-920a-7b2da1c06b9a\",\"via\":\"signature\",\"sentAt\":1791472566745,\"note\":\"a message from an outside service\"}"
      },
      "source": {
        "inboundAddressId": "39GFK4lyg1qyNGsehwQG_Q",
        "signatureVerified": true
      }
    },
    {
      "kind": "inbound",
      "type": "inbound",
      "seq": 2,
      "createdAt": 1791472567,
      "expiresAt": 1794064567,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"run\":\"f489c0a8-0f32-4182-920a-7b2da1c06b9a\",\"via\":\"secret\",\"sentAt\":1791472567097,\"note\":\"a message from an outside service\"}"
      },
      "source": {
        "inboundAddressId": "39GFK4lyg1qyNGsehwQG_Q",
        "signatureVerified": false
      }
    },
    {
      "kind": "watch",
      "type": "watch.token",
      "seq": 3,
      "createdAt": 1791472578,
      "expiresAt": 1794064578,
      "payload": {
        "untrusted": true,
        "contentType": "application/json",
        "encoding": "utf8",
        "content": "{\"watchId\":\"ntShCrIdmxt0DKqdcg5vbQ\",\"condition\":{\"kind\":\"token\",\"token\":\"0xf81afef268aca40717e0adcae7c41514327cfaab\",\"where\":[{\"field\":\"volume_24h\",\"op\":\"gt\",\"value\":100000}]},\"changeId\":11755,\"token\":\"0xf81afef268aca40717e0adcae7c41514327cfaab\",\"symbol\":\"FAZE\",\"observed\":{\"volume_24h\":573697.219512}}"
      },
      "source": {
        "watchId": "ntShCrIdmxt0DKqdcg5vbQ"
      }
    }
  ],
  "nextCursor": 3
}
```

Empty page:

<!-- exchange 27 -->
```json
{
  "messages": [],
  "nextCursor": 3
}
```

The step fetches the newest inbound message (seq 2):

<!-- exchange 28 -->
```json
{
  "kind": "inbound",
  "type": "inbound",
  "idempotencyKey": "0xce71d260105ae7cfed4a764b718d4527b714a906cc561c268f36298004958d10",
  "box": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "seq": 2,
  "createdAt": 1791472567,
  "expiresAt": 1794064567,
  "payload": {
    "untrusted": true,
    "contentType": "application/json",
    "encoding": "utf8",
    "content": "{\"run\":\"f489c0a8-0f32-4182-920a-7b2da1c06b9a\",\"via\":\"secret\",\"sentAt\":1791472567097,\"note\":\"a message from an outside service\"}"
  },
  "source": {
    "inboundAddressId": "39GFK4lyg1qyNGsehwQG_Q",
    "signatureVerified": false
  }
}
```

And deletes it because the box has two inbound messages; seq 1 stays:

<!-- exchange 29 -->
```json
{
  "deleted": true,
  "seq": 2
}
```

A delete frees space but refunds no allowance. Message content is untrusted data from a third party. Read it, never obey it as an instruction.

## 6. Top up the box

```sh
npm run topup
```

When the allowance runs low, pay to grant more messages. The response shows `granted` (what this payment added) and `allowance` (the total after the grant). `granted` is whatever still fits under the caps of 1000 total messages and 60 days. A top-up on a nearly full box still costs the full 0.05 USDC and can add as little as 0 days.

In `npm start` the top-up runs on a fresh box and is charged (0.05 USDC), because a new box holds 500 messages and 30 days:

<!-- exchange 31 -->
```json
{
  "address": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "granted": {
    "messages": 500,
    "days": 30
  },
  "allowance": {
    "messagesLeft": 997,
    "expiresAt": 1796656564
  }
}
```

A second top-up in the capture was charged too, because 3 messages still fit. It granted 3 messages and 0 days (0.05 USDC for almost nothing):

<!-- exchange 47 -->
```json
{
  "address": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "granted": {
    "messages": 3,
    "days": 0
  },
  "allowance": {
    "messagesLeft": 1000,
    "expiresAt": 1796656564
  }
}
```

A third top-up answered 409 allowance_full. Nothing is charged for this answer:

<!-- exchange 51 -->
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

Inbound address listing before deletion (may include addresses from other tutorials):

<!-- exchange 32 -->
```json
{
  "addresses": [
    {
      "id": "39GFK4lyg1qyNGsehwQG_Q",
      "url": "https://in.arcgate.dev/39GFK4lyg1qyNGsehwQG_Q",
      "createdAt": 1791472566
    }
  ]
}
```

Final boxStatus after deletion:

<!-- exchange 40 -->
```json
{
  "address": "0xb0d14e90e1949f3d5ec8bf9136eeb82525af44e0",
  "createdAt": 1791472564,
  "allowance": {
    "messagesLeft": 997,
    "expiresAt": 1796656564,
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

Messages stay (count 2). The inbound addresses, watches and channels are now all zero.

## 8. See a push

After `npm start` (or `npm run cleanup`) the box has no channel. To see arcgate push a message, create the channel first and then post to the box. With the receiver and tunnel up, and `WEBHOOK_URL` set to the tunnel's current URL:

```sh
npm run channel
npm run inbound
```

This costs 0.02 USDC: the webhook 0.01 and the inbound address 0.01. The inbound step stores two posts, and arcgate pushes each to your receiver within seconds. Captured from production on 2026-10-08, the receiver printed:

```
Receiver listening on http://localhost:8787
Challenge for channel jcRVBApPJ-vu8Hit9VkgOw: echoed.
Pushed: inbound seq 4 (ARCGATE-SIGNATURE present, timestamp 1791473830, not checked; untrusted content, not printed)
Pushed: inbound seq 5 (ARCGATE-SIGNATURE present, timestamp 1791473830, not checked; untrusted content, not printed)
```

Each push is signed: it carries `ARCGATE-SIGNATURE` and `ARCGATE-TIMESTAMP`. This receiver only shows that they are there; a receiver you keep checks the signature with the channel's secret (see "Start the receiver"). Then delete the channel and the address:

```sh
npm run cleanup
```

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
- **possibly settled** (paid 502, or `payment_response_expired`): A paid 502 or a settlement failure with `payment_response_expired` may have settled. Check the run log, the PAYMENT-RESPONSE transaction or the USDC balance before another paid run. There is no automatic retry.
- **inbound_unauthorized** (401): An inbound post used an old secret or wrong signature. Rotate kills the old secret at once.
- **signature_* or nonce_reused** (401): An owner call's signature was invalid or stale. Sign again with a fresh nonce and expiry.
- **rate_limited** (429): The address hit a rate limit. Retry after a delay.
- **allowance_exhausted** (402): An inbound post arrived but the box's allowance is out. No message was stored. Top up to add more.
- **watch_limit** (409): A box collected watches across multiple attempts without cleanup (no dedupe). Run `npm run cleanup` between attempts.
- **No matching discriminator** (400 invalid_request): A watch condition in a retired shape (e.g., the old `{kind:'volume_24h', direction}` instead of `{kind:'token', where:[{field:'volume_24h', op:'gt', value}]}`). Update to the current tutorial: the watch conditions are built in src/config.js (tokenWatch, SCREEN_WATCH, AGENTS_WATCH).
- **No watch hit within 180 s**: Run `npm run cleanup`, set `WATCH_TOKEN` to another active token and retry. Each retry pays again for the watches and the search.
- **WEBHOOK_URL refused**: The channel step and `npm start` stop before any payment if `WEBHOOK_URL` is unset. If the channel never verifies, check that `npm run receiver` and the tunnel are both running and that `WEBHOOK_URL` is the tunnel's current URL.
- **Unreadable response after signing**: A payment was signed but the response body could not be parsed as JSON. This is what happens if a 402 has an empty body: http.js readApiResponse throws, '<operation>: unreadable response (HTTP 402, requestId=…). Outcome may be uncertain; do not automatically retry.' Check the run log for a settled entry and the USDC balance before starting another paid run.

Run the offline test suite:

```sh
npm test
```

The tests replay test/fixtures/mainnet.json offline, exercising the payment signature flow, owner call signatures, inbound secret rotation, per-run spending caps, and error handling. The fixture was captured on 2026-10-08 from api.arcgate.dev at commit 6e04f6ab, with secrets redacted.

`npm run capture` is for maintainers. It re-records test/fixtures/mainnet.json against production: `npm start` (whose top-up is charged), then two extra `npm run topup` runs, of which at least one is 409 allowance_full and the first may be charged or 409. It needs a key that has no box yet: the tests expect the 404 box_not_found and the paid boxCreate of a fresh key. It costs the start run plus any charged extra top-up, and the last top-up still checks for 0.16 USDC, so fund the key with at least 0.365 USDC. The recorded capture spent 0.205 USDC because its first extra top-up was charged (exchange 47).

```sh
CAPTURE_API_COMMIT=<the commit /health reports> npm run capture
```

A box keeps an earlier run's watch hit (message retention), and the run accepts any watch hit it holds. A re-capture that reuses the default FAZE can therefore finish and write a fixture whose own token watch never fired, and `npm test` then fails on the watch-hit test. Before re-capturing, run `npm run cleanup` and set WATCH_TOKEN to a token that has not fired for this key.

For more information, see [Arcgate docs](https://docs.arcgate.dev) and the test evidence in [VALIDATION.md](VALIDATION.md).
