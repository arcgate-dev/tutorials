import { generatePrivateKey } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { API_URL } from './support.ts';

/** A loadConfig result with two throwaway keys made in memory: a payer and an unfunded agent. */
export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({ API_URL, PRIVATE_KEY: generatePrivateKey(), AGENT_PRIVATE_KEY: generatePrivateKey(), ...env });
}
