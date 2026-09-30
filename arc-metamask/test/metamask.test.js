import test from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, loadWallet, parseMmOutput, parseMmResult } from '../src/metamask.js';
import { account, authorization, config, hash, other, wallet } from './fixtures.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

function fakeMm(overrides = {}) {
  return async args => {
    const command = args.slice(0, 2).join(' ');
    const values = { 'doctor': { cli: '7.0.0', authenticated: true, initialized: true },
      'init show': { walletMode: 'server-wallet', tradingMode: 'guard' }, 'wallet trading-mode': { mode: 'guard' }, 'wallet address': { address: wallet.address },
      'chains list': { chains: [{ key: 'arc', chainId: 5042, caip2: 'eip155:5042' }, { key: 'arc-testnet', chainId: 5042002, caip2: 'eip155:5042002' }] },
      'wallet policy': { policy: 'example' }, ...overrides };
    if (!(command in values)) throw new Error(`Unexpected CLI command: ${command}`);
    return values[command];
  };
}

test('parse mm notices and a unique pretty-printed result; reject errors and ambiguity', () => {
  const text = `${JSON.stringify({ _notice: { kind: 'AWAITING_MFA', pollingId: 'job' } })}\n${JSON.stringify({ ok: true, data: { status: 'SIGNED' } }, null, 2)}\n`;
  assert.equal(parseMmOutput(text).status, 'SIGNED');
  assert.throws(() => parseMmOutput(text + '{bad}'), /malformed/);
  assert.throws(() => parseMmOutput(text + '{"ok":true,"data":{}}'), /unique/);
  assert.throws(() => parseMmOutput('{"ok":false,"error":{"code":"DENIED","message":"policy"}}'), /DENIED: policy/);
});

test('stderr error envelopes remain actionable without exposing signed payloads', () => {
  const notice = JSON.stringify({ _notice: { kind: 'AWAITING_MFA', pollingId: 'job' } });
  const error = JSON.stringify({ ok: false, error: { code: 'WALLET_ERROR', message: `Rejected 0x${'ab'.repeat(200)}` } });
  assert.throws(() => parseMmResult(notice, error, 1), value => {
    assert.equal(value.code, 'WALLET_ERROR'); assert.match(value.message, /Rejected/);
    assert(!value.message.includes('abab')); return true;
  });
  assert.equal(parseMmResult('{"ok":true,"data":{"status":"SIGNED"}}', 'ignored diagnostics', 0).status, 'SIGNED');
});

test('plain-text progress before JSON cannot hide a result or a stderr failure', () => {
  assert.equal(parseMmResult('Tx submitted: https://explorer.example/tx/example\n{"ok":true,"data":{"status":"CONFIRMED"}}', '', 0).status, 'CONFIRMED');
  assert.throws(() => parseMmResult('Waiting for approval...\n', '{"ok":false,"error":{"code":"DENIED","message":"Policy refused"}}', 1), /DENIED: Policy refused/);
});

test('MFA notices switch 7.0.0 to streaming summary/error envelopes', () => {
  const notice = '{"_notice":{"kind":"AWAITING_MFA","pollingId":"request"}}\n';
  assert.equal(parseMmResult(notice + '{"_summary":{"status":"pending_approval","requestId":"request"}}', '', 0).requestId, 'request');
  assert.equal(parseMmResult(notice + '{"_summary":{"status":"BROADCASTED","hash":"example"}}', '', 0).status, 'BROADCASTED');
  assert.throws(() => parseMmResult(notice, '{"_error":{"code":"DENIED","message":"Approval rejected"}}', 1), /DENIED: Approval rejected/);
});

test('preflight requires 7.0.0, authenticated server wallet, guard mode and both Arc entries', async () => {
  assert.equal((await loadWallet(fakeMm())).address, wallet.address);
  for (const override of [
    { doctor: { cli: '7.1.0' } }, { doctor: { cli: '7.0.0', authenticated: false } },
    { 'init show': { walletMode: 'byok' } }, { 'wallet trading-mode': { mode: 'beast' } },
    { 'chains list': { chains: [] } },
  ]) await assert.rejects(loadWallet(fakeMm(override)));
});

test('beast runs only when opted in and the server already reports beast', async () => {
  const beast = fakeMm({ 'wallet trading-mode': { mode: 'beast' } });
  assert.equal((await loadWallet(beast, 'beast')).tradingMode, 'beast');
  await assert.rejects(loadWallet(fakeMm(), 'beast'), /guard mode; this run expects beast/);
  // A stale local 'guard' session does not override the server's answer.
  assert.equal((await loadWallet(fakeMm({ 'wallet trading-mode': { mode: 'beast' }, 'init show': { walletMode: 'server-wallet', tradingMode: 'guard' } }), 'beast')).tradingMode, 'beast');
  const mm = createWallet(wallet.address, fakeMm(), () => {}, 'beast');
  await assert.rejects(mm.send({ to: config.router, data: '0x12', value: '0', gas: '1', purpose: 'swap' }), /mode changed/);
});

test('mm signs on chain 5042, preserves typed data and verifies signature recovery', async () => {
  const records = [], data = authorization();
  const mm = createWallet(wallet.address, async args => {
    if (args[1] !== 'sign-typed-data') return fakeMm()(args);
    assert.equal(args[args.indexOf('--chain-id') + 1], '5042');
    const payload = JSON.parse(args[args.indexOf('--payload') + 1]);
    assert.equal(payload.message.value, '5000');
    return { status: 'SIGNED', signature: await account.signTypedData(payload), pollingId: 'signed-job' };
  }, entry => records.push(entry));
  assert.match(await mm.signTypedData(data), /^0x[\da-f]{130}$/i);
  assert(!JSON.stringify(records).includes('signature'));
  await assert.rejects(mm.signTypedData({ ...data, domain: { ...data.domain, chainId: 5042002 } }), /mainnet/);
  const changed = createWallet(other, fakeMm());
  await assert.rejects(changed.signTypedData(data), /wallet changed/);
});

test('mm transaction uses hex value/gas; incomplete wallet jobs are never success', async () => {
  const tx = { to: config.router, data: '0x12345678', value: '0', gas: '100000', purpose: 'swap' };
  let status = 'BROADCASTED';
  const mm = createWallet(wallet.address, async args => {
    if (args[1] !== 'send-transaction') return fakeMm()(args);
    const payload = JSON.parse(args[args.indexOf('--payload') + 1]);
    assert.deepEqual(payload, { to: config.router, data: tx.data, value: '0x0', gas: '0x186a0' });
    return { status, hash, pollingId: 'send-job' };
  });
  assert.equal(await mm.send(tx), hash);
  status = 'AWAITING_MFA';
  await assert.rejects(mm.send(tx), /send-job.*Do not resubmit/);
});

test('decode requires known approval; unknown executeGraph uses the independently checked ABI', async () => {
  const records = [];
  const mm = createWallet(wallet.address, async () => ({ params: [], intent: 'Call unknown function' }), entry => records.push(entry));
  await mm.decode([{ purpose: 'swap', data: '0xfdbcb692' }], [{ purpose: 'swap', minOut: '594' }]);
  assert.match(records[0].mmFunction, /bundled executeGraph ABI/);
  await assert.rejects(mm.decode([{ purpose: 'approve', data: '0x095ea7b3' }], []), /recognize approve/);
});
