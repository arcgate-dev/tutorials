import test from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, loadWallet, parseMmOutput, parseMmResult } from '../src/metamask.js';
import { account, authorization, config, hash, other, permit, pinTime, testnetConfig, wallet } from './fixtures.js';
import { fakeMm, guardRefusal } from './support.js';

globalThis.fetch = () => { throw new Error('Network access is forbidden in tests.'); };

const signsOrSends = call => /^wallet (sign-typed-data|send-transaction)/.test(call);
// Answers wallet sign-typed-data with a real signature over the payload it was sent.
const signing = (seen = []) => async args => {
  seen.push({ chainId: args[args.indexOf('--chain-id') + 1] });
  return { status: 'SIGNED', signature: await account.signTypedData(JSON.parse(args[args.indexOf('--payload') + 1])), pollingId: 'signed-job' };
};

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

test('preflight requires 7.0.0, authenticated server wallet and both Arc entries', async () => {
  assert.equal((await loadWallet(fakeMm())).address, wallet.address);
  for (const override of [
    { doctor: { cli: '7.1.0' } }, { doctor: { cli: '7.0.0', authenticated: false } },
    { 'init show': { walletMode: 'byok' } }, { 'chains list': { chains: [] } },
  ]) await assert.rejects(loadWallet(fakeMm(override)));
});

test('loadWallet resolves only when the server reports Beast Mode, whatever the local session says', async () => {
  const calls = [];
  const beast = await loadWallet(fakeMm({}, calls));
  assert.equal(beast.tradingMode, 'beast');
  assert(calls.includes('wallet trading-mode get'));
  // No policy is read: Beast Mode does not enforce it and the tutorial no longer proposes one.
  assert(!('policy' in beast)); assert(!calls.some(call => call.startsWith('wallet policy')));
  await assert.rejects(loadWallet(fakeMm({ 'wallet trading-mode': { mode: 'guard' } })), guardRefusal);
  // A stale local session that says beast does not override the server's answer.
  await assert.rejects(loadWallet(fakeMm({ 'wallet trading-mode': { mode: 'guard' }, 'init show': { walletMode: 'server-wallet', tradingMode: 'beast' } })), guardRefusal);
  // And a stale local guard does not hide a server that already says beast.
  assert.equal((await loadWallet(fakeMm({ 'init show': { walletMode: 'server-wallet', tradingMode: 'guard' } }))).tradingMode, 'beast');
  await assert.rejects(loadWallet(fakeMm({ 'wallet trading-mode': { mode: 'unknown' } })), /beast/i);
});

test('the wallet refuses to sign or send once the server reports Guard Mode mid-run', async () => {
  let mode = 'beast';
  const calls = [], tx = { to: config.router, data: '0x12345678', value: '0', gas: '100000', purpose: 'swap' };
  const mm = createWallet(wallet.address, fakeMm({ 'wallet trading-mode': () => ({ mode }), 'wallet sign-typed-data': signing(),
    'wallet send-transaction': () => ({ status: 'BROADCASTED', hash, pollingId: 'send-job' }) }, calls), () => {}, config);
  // While the server says beast, both go through.
  assert.match(await mm.signTypedData(authorization()), /^0x[\da-f]{130}$/i);
  assert.equal(await mm.send(tx), hash);
  mode = 'guard'; // The owner switched the wallet back (or the server did) after the run started.
  const before = calls.filter(signsOrSends).length;
  await assert.rejects(mm.signTypedData(authorization()), guardRefusal);
  await assert.rejects(mm.send(tx), guardRefusal);
  assert.equal(calls.filter(signsOrSends).length, before, 'no sign-typed-data or send-transaction after the switch');
});

test('mm signs on chain 5042, preserves typed data and verifies signature recovery', async () => {
  const records = [], data = authorization();
  const mm = createWallet(wallet.address, async args => {
    if (args[1] !== 'sign-typed-data') return fakeMm()(args);
    assert.equal(args[args.indexOf('--chain-id') + 1], '5042');
    const payload = JSON.parse(args[args.indexOf('--payload') + 1]);
    assert.equal(payload.message.value, '5000');
    return { status: 'SIGNED', signature: await account.signTypedData(payload), pollingId: 'signed-job' };
  }, entry => records.push(entry), config);
  assert.match(await mm.signTypedData(data), /^0x[\da-f]{130}$/i);
  assert(!JSON.stringify(records).includes('signature'));
  const changed = createWallet(other, fakeMm(), () => {}, config);
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
  }, () => {}, config);
  assert.equal(await mm.send(tx), hash);
  status = 'AWAITING_MFA';
  await assert.rejects(mm.send(tx), /send-job.*Do not resubmit/);
});

test('decode requires known approval; unknown executeGraph uses the independently checked ABI', async () => {
  const records = [];
  const mm = createWallet(wallet.address, async () => ({ params: [], intent: 'Call unknown function' }), entry => records.push(entry), config);
  await mm.decode([{ purpose: 'swap', data: '0xfdbcb692' }], [{ purpose: 'swap', minOut: '594' }]);
  assert.match(records[0].mmFunction, /bundled executeGraph ABI/);
  await assert.rejects(mm.decode([{ purpose: 'approve', data: '0x095ea7b3' }], []), /recognize approve/);
});

test('typed data is signed only on the row\'s payment or trade chain, and that domain chainId goes to --chain-id', async t => {
  pinTime(t); // the captured Permit2 deadline is only valid at the moment of the capture
  // Production row: x402 and Permit2 are both on Arc mainnet.
  // Testnet row: x402 is on Arc testnet (5042002), Permit2 is on Arc mainnet (5042).
  for (const [row, signed, refused] of [[config, [[authorization(config), '5042'], [permit(config), '5042']], [5042002, 1, 11155111, 0]],
    [testnetConfig, [[authorization(testnetConfig), '5042002'], [permit(testnetConfig), '5042']], [1, 11155111, 0, 5043]]]) {
    const seen = [], calls = [];
    const mm = createWallet(wallet.address, fakeMm({ 'wallet sign-typed-data': signing(seen) }, calls), () => {}, row);
    for (const [data, chainId] of signed) {
      assert.match(await mm.signTypedData(data), /^0x[\da-f]{130}$/i, row.network);
      assert.equal(seen.at(-1).chainId, chainId, `${row.network} ${data.primaryType}`);
      assert.equal(String(data.domain.chainId), chainId);
    }
    assert.equal(seen.length, 2);
    // Any other chain is refused before mm is asked to sign.
    for (const chainId of refused) {
      for (const data of [authorization(row), permit(row)]) {
        await assert.rejects(mm.signTypedData({ ...data, domain: { ...data.domain, chainId } }), undefined, `${row.network} chainId ${chainId}`);
      }
    }
    assert.equal(calls.filter(call => call.startsWith('wallet sign-typed-data')).length, 2, row.network);
  }
});
