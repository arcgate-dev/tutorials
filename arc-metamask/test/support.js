import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wallet } from './fixtures.js';

// Free responses captured from the localnet and from production (see fixtures/*.json). Nothing here is hand-written.
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const localnet = load('localnet-free.json');
export const mainnet = load('mainnet-free.json');

// Serves one capture's /health and unpaid /trade/v1/search 402, and records every request it sees.
// Anything else (an RPC call, a paid retry, another path) is an error, so a stray request cannot pass silently.
export function freeFetch(capture, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers) });
    const { pathname } = new URL(url);
    if (pathname === '/health') return Response.json(capture.health);
    if (pathname === '/trade/v1/search') {
      const { paymentRequired, body, requestId } = capture.search402;
      return new Response(JSON.stringify(body), { status: 402, headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'payment-required': Buffer.from(JSON.stringify(paymentRequired)).toString('base64') } });
    }
    throw new Error(`Unexpected request to ${url}`);
  };
}

// A stand-in for the `mm` CLI. The default wallet is a server wallet in Beast Mode, the only mode the tutorial runs in.
// An override may be a function of the arguments. Every call is recorded as its joined arguments.
export function fakeMm(overrides = {}, calls = []) {
  return async args => {
    calls.push(args.join(' '));
    const command = args.slice(0, 2).join(' ');
    const values = { 'doctor': { cli: '7.0.0', authenticated: true, initialized: true },
      'init show': { walletMode: 'server-wallet', tradingMode: 'guard' }, 'wallet trading-mode': { mode: 'beast' }, 'wallet address': { address: wallet.address },
      'chains list': { chains: [{ key: 'arc', chainId: 5042, caip2: 'eip155:5042' }, { key: 'arc-testnet', chainId: 5042002, caip2: 'eip155:5042002' }] },
      ...overrides };
    if (!(command in values)) throw new Error(`Unexpected CLI command: ${command}`);
    return typeof values[command] === 'function' ? values[command](args) : values[command];
  };
}

// The refusal every wallet command gives in Guard Mode: it names the mode and the owner's one-time switch, never a flag.
export function guardRefusal(error) {
  assert(error instanceof Error, 'expected an Error');
  assert(/Guard Mode/.test(error.message), `message must name Guard Mode: ${error.message}`);
  assert(/mm wallet trading-mode set beast/.test(error.message), `message must name the owner's switch: ${error.message}`);
  assert(!/--beast/.test(error.message), `message must not offer a --beast flag: ${error.message}`);
  return true;
}
