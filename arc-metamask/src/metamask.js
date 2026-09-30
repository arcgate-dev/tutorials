import { spawn } from 'node:child_process';
import { getAddress, numberToHex, recoverTypedDataAddress } from 'viem';

export const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

// mm emits NDJSON notices followed by a possibly pretty-printed result envelope.
export function parseMmOutput(stdout) {
  const frames = [];
  let pending = '';
  for (const line of stdout.split(/\r?\n/)) {
    // Some 7.0.0 commands print "Tx submitted: ..." or progress text even with
    // --json. Ignore standalone prose, but require one complete result envelope.
    if (!pending.trim() && !line.trimStart().startsWith('{')) { pending = ''; continue; }
    pending += `${line}\n`;
    try {
      const frame = JSON.parse(pending);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
      frames.push(frame);
      pending = '';
    } catch { /* Wait for the rest of a pretty-printed envelope. */ }
  }
  if (pending.trim()) throw new Error('mm returned malformed JSON. Check wallet requests before retrying.');
  // Once a command emits a notice, 7.0.0 switches to _summary / _error
  // envelopes instead of the ordinary ok/data result (Command.runLifecycle).
  const results = frames.flatMap(frame => {
    if ('_notice' in frame) return [];
    if ('_summary' in frame) return [{ ok: true, data: frame._summary }];
    if ('_error' in frame) return [{ ok: false, error: frame._error }];
    return 'ok' in frame ? [frame] : [];
  });
  if (results.length !== 1) throw new Error('mm returned no unique result. Check wallet requests before retrying.');
  const result = results[0];
  if (result.ok !== true) {
    const error = new Error(`mm ${result.error?.code ?? 'FAILED'}: ${result.error?.message ?? 'command failed'}`.replace(/0x[\da-f]{130,}/gi, '[payload omitted]'));
    error.code = result.error?.code ?? 'FAILED';
    throw error;
  }
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('mm returned no data.');
  return result.data;
}

export function parseMmResult(stdout, stderr, code) {
  // 7.0.0 puts structured failures on stderr, even in --json mode. stdout may
  // contain only notices. Never print stderr verbatim or treat silence as success.
  const result = parseMmOutput(code === 0 ? stdout : `${stdout}\n${stderr}`);
  if (code !== 0) throw new Error(`mm exited ${code}. Check wallet requests before retrying.`);
  return result;
}

// Never interpolate payloads into shell text or print raw stdout/stderr: they may contain signatures.
export function runMm(args, notice = entry => console.error(json(entry))) {
  return new Promise((resolve, reject) => {
    const child = spawn('mm', [...args, '--json'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', partial = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2_000_000) { overflow = true; child.kill('SIGTERM'); return; }
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line)._notice;
          if (value?.kind === 'AWAITING_MFA') notice({ state: 'AWAITING_MFA', pollingId: value.pollingId, message: value.message ?? 'Approve the existing request in MetaMask; do not resubmit.' });
        } catch { /* Not a notice line. */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 2_000_000) { overflow = true; child.kill('SIGTERM'); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start mm. Install @metamask/agent-wallet@7.0.0.')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || overflow) { reject(new Error('mm was interrupted. Check wallet requests before retrying.')); return; }
      try {
        resolve(parseMmResult(stdout, stderr, code));
      } catch (error) { reject(error); }
    });
  });
}

// The server's trading mode, not the CLI's cached init answer: a switch approved by
// email after `--no-wait` reaches the server without updating the local session.
async function tradingMode(run) {
  const { walletMode } = await run(['init', 'show']);
  if (walletMode !== 'server-wallet') throw new Error('This tutorial assumes a server wallet. Review your wallet mode; do not silently switch it.');
  return (await run(['wallet', 'trading-mode', 'get'])).mode;
}

// Guard unless the owner opted into beast with --beast; the wallet must already be in that mode.
export async function loadWallet(run = runMm, expectedMode = 'guard') {
  const doctor = await run(['doctor']);
  if (doctor.cli !== '7.0.0') throw new Error('This tutorial requires @metamask/agent-wallet@7.0.0.');
  if (!doctor.authenticated || !doctor.initialized) throw new Error('Complete mm login and mm init, then recheck mm doctor.');
  const mode = await tradingMode(run);
  if (mode !== expectedMode) throw new Error(`The wallet is in ${mode} mode; this run expects ${expectedMode}. Pass --beast only for a wallet you switched to beast yourself; this tutorial never switches it.`);
  const { chains } = await run(['chains', 'list']);
  for (const [key, id] of [['arc', 5042], ['arc-testnet', 5042002]]) {
    if (!chains?.some(chain => chain.key === key && chain.chainId === id && chain.caip2 === `eip155:${id}`)) {
      throw new Error(`NetworkRegistry does not expose ${key} (${id}). Resolve MetaMask service support.`);
    }
  }
  const address = getAddress((await run(['wallet', 'address'])).address);
  return { address, walletMode: 'server-wallet', tradingMode: mode, chains: chains.filter(chain => ['arc', 'arc-testnet'].includes(chain.key)),
    policy: (await run(['wallet', 'policy', 'get'])).policy };
}

function complete(result, field) {
  const statuses = field === 'signature' ? ['SIGNED'] : ['BROADCASTED', 'CONFIRMED'];
  const pattern = field === 'signature' ? /^0x[\da-f]{130}$/i : /^0x[\da-f]{64}$/i;
  if (!statuses.includes(result.status) || !pattern.test(result[field] ?? '')) {
    throw new Error(`mm ${result.status}: ${result.failureReason ?? 'operation incomplete'}; pollingId=${result.pollingId ?? 'unknown'}. Do not resubmit.`);
  }
  return result[field];
}

export function createWallet(address, run = runMm, record = () => {}, expectedMode = 'guard') {
  const wallet = getAddress(address);
  async function sameWallet() {
    if (getAddress((await run(['wallet', 'address'])).address) !== wallet) throw new Error('The active mm wallet changed. Refusing to sign or send.');
    if (await tradingMode(run) !== expectedMode) throw new Error('The mm wallet mode changed.');
  }
  return {
    address: wallet,
    async signTypedData(data) {
      if (BigInt(data.domain.chainId) !== 5042n) throw new Error('Only Arc mainnet typed data is allowed.');
      await sameWallet();
      record({ state: 'signing', primaryType: data.primaryType, chainId: 5042, verifyingContract: data.domain.verifyingContract });
      const result = await run(['wallet', 'sign-typed-data', '--chain-id', '5042', '--payload', json(data), '--wait', '--wallet-timeout', '60']);
      record({ state: result.status, operation: 'sign-typed-data', pollingId: result.pollingId });
      const signature = complete(result, 'signature');
      if (getAddress(await recoverTypedDataAddress({ ...data, signature })) !== wallet) throw new Error('MetaMask signature did not recover to the selected wallet.');
      return signature;
    },
    async decode(txs, checked) {
      // checked is produced by the independent exact-ABI/order guard before ANY decode/send.
      for (const [index, tx] of txs.entries()) {
        const result = await run(['decode', '--payload', tx.data]);
        const expected = tx.purpose === 'approve' ? 'approve' : 'executeGraph';
        const recognized = result.functionName === expected && result.params?.length > 0;
        const fallback = !result.functionName && expected === 'executeGraph';
        if (!recognized && !fallback) throw new Error(`mm decode did not recognize ${expected}. Stop for ABI review.`);
        record({ state: 'decoded', mmFunction: recognized ? expected : 'unknown; verified with bundled executeGraph ABI', ...checked[index] });
      }
    },
    async send(tx) {
      await sameWallet();
      const payload = { to: getAddress(tx.to), data: tx.data, value: numberToHex(BigInt(tx.value)), gas: numberToHex(BigInt(tx.gas)) };
      record({ state: 'submitting', purpose: tx.purpose, to: payload.to, value: tx.value });
      const result = await run(['wallet', 'send-transaction', '--chain-id', '5042', '--payload', json(payload), '--wait', '--wallet-timeout', '60']);
      record({ state: result.status, purpose: tx.purpose, pollingId: result.pollingId, transaction: result.hash });
      return complete(result, 'hash');
    },
  };
}
