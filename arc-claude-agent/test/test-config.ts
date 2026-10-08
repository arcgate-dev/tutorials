import { generatePrivateKey } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { API_URL } from './support.ts';

/** A loadConfig result with one throwaway key made in memory: the payer, the box and the signer. */
export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({ API_URL, PRIVATE_KEY: generatePrivateKey(), ...env });
}
