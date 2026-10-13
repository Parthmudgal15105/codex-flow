import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const create = require('../src/window-activation.cjs');
const epoch = 1_800_000_000_000;
const account = (id, usedPercent = 0) => ({id, accountId: id + '-identity', usageAt: epoch,
  usageWindows: {fiveHour: {usedPercent, resetAt: epoch + 300*60_000}, weekly: {usedPercent: 20}, other: []}});
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let time = epoch, list = [account('a', 10), account('b')], calls = [], refreshes = 0;
  const options = {file: path.join(dir, 'ledger.json'), accounts: () => list, clock: () => time,
    enabled: () => true, allowed: () => true, busy: () => false,
    activate: async a => {calls.push(a.id); return {usageWindows: {fiveHour: {usedPercent: 1, resetAt: time + 300*60_000}}};},
    refresh: async () => {refreshes++;}, ...overrides};
  return {options, instance: create(options), calls, setTime: v => time = v, setAccounts: v => list = v, refreshes: () => refreshes};
}
test('starts only the unused account and persists before sending, including after restart', async t => {
  const f = fixture(t);
  const activate = f.options.activate;
  f.options.activate = async a => {
    assert.equal(JSON.parse(fs.readFileSync(f.options.file)).attempts[a.accountId].status, 'attempting');
    return activate(a);
  };
  const instance = create(f.options);
  const results = await instance.ensure();
  assert.deepEqual(f.calls, ['b']); assert.equal(results[0].status, 'reset_observed');
  assert.equal(f.refreshes(), 1);
  await create(f.options).ensure(); assert.deepEqual(f.calls, ['b']);
  f.setTime(epoch + 300*60_000); f.setAccounts([account('a', 10), {...account('b'), usageAt: epoch + 300*60_000}]);
  await instance.ensure(); assert.deepEqual(f.calls, ['b', 'b']);
});
test('concurrent messages share one activation and failures cannot cause repeated requests', async t => {
  let calls = 0;
  const f = fixture(t, {activate: async () => {calls++; await new Promise(r => setTimeout(r, 10)); throw Error('offline');}});
  const [a,b] = await Promise.all([f.instance.ensure(), f.instance.ensure()]);
  assert.equal(calls, 1); assert.equal(a[0].status, 'failed'); assert.deepEqual(a,b);
  await create(f.options).ensure(); assert.equal(calls, 1);
});
test('skips stale, unknown, exhausted, busy, excluded, disabled and single-account configurations', async t => {
  for (const change of [
    a => ({...a, usageAt: epoch-60_000}), a => ({...a, usageError: 'offline'}),
    a => ({...a, rateLimitReached: true}), a => ({...a, usageWindows: {fiveHour: null}}),
    a => ({...a, usageWindows: {...a.usageWindows, weekly: {usedPercent: 100}}}),
    a => ({...a, usageWindows: {...a.usageWindows, other: [{usedPercent: null}]}})
  ]) {
    const f = fixture(t); f.setAccounts([account('a', 10), change(account('b'))]);
    assert.deepEqual(await f.instance.ensure(), []); assert.deepEqual(f.calls, []);
  }
  for (const overrides of [{enabled: () => false}, {busy: () => true}, {allowed: () => false}]) {
    const f = fixture(t, overrides); assert.deepEqual(await f.instance.ensure(), []);
  }
  const f = fixture(t); assert.deepEqual(await f.instance.ensure(['b']), []);
  assert.deepEqual(await f.instance.ensure(new Set(['b-identity'])), []);
  f.setAccounts([account('b')]); assert.deepEqual(await f.instance.ensure(), []);
});
test('rounded zero after success does not cause repeated activation or invent a reset', async t => {
  const f = fixture(t, {activate: async () => ({usageWindows: account('b').usageWindows})});
  assert.equal((await f.instance.ensure())[0].status, 'request_completed_reset_unconfirmed');
  assert.deepEqual(await f.instance.ensure(), []);
});
test('corrupt ledger fails closed without spending quota', async t => {
  const f = fixture(t); fs.writeFileSync(f.options.file, 'broken');
  await assert.rejects(f.instance.ensure(), /ledger/); assert.deepEqual(f.calls, []);
});
