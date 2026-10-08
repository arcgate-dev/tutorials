import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { noNetwork } from './support.ts';

globalThis.fetch = noNetwork;

test('mcp.json declares arcgate over http at <API origin>/mcp', () => {
  const snippet = JSON.parse(readFileSync(new URL('../mcp.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(snippet.mcpServers), ['arcgate']);
  const server = snippet.mcpServers.arcgate;
  assert.equal(server.type, 'http', 'a Streamable HTTP server, not stdio or sse');
  assert.equal(typeof server.url, 'string');
  assert.ok(server.url.endsWith('/mcp'), 'the MCP endpoint is POST /mcp');

  const origin = server.url.slice(0, -'/mcp'.length);
  const config = loadConfig({ API_URL: origin, PRIVATE_KEY: generatePrivateKey(), AGENT_PRIVATE_KEY: generatePrivateKey() });
  assert.equal(config.mcpUrl, server.url, 'the snippet is exactly what the tutorial connects to');
});
