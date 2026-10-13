import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const activate = require('../src/activation-probe.cjs');
function fixture({status = 'completed', silent = false, used = 0} = {}) {
  const calls = []; let home;
  function spawnImpl(binary, args, options) {
    home = options.cwd;
    assert.equal(options.env.CODEX_HOME, home); assert.equal(options.env.OPENAI_API_KEY, undefined);
    const child = new EventEmitter();
    Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), pid: 999999, exitCode: null, signalCode: null});
    child.kill = () => {child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit'));};
    let buffer = '', reads = 0;
    const emit = m => child.stdout.write(JSON.stringify(m)+'\n');
    child.stdin.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const cut = buffer.indexOf('\n'), m = JSON.parse(buffer.slice(0,cut)); buffer = buffer.slice(cut+1);
        calls.push(m);
        if (silent || !m.id) continue;
        let result = {};
        if (m.method === 'account/rateLimits/read') result = {usageWindows: {fiveHour: {usedPercent: reads++ ? 1 : used, resetAt: Date.now()+300*60_000}}};
        if (m.method === 'model/list') result = {data: [{id:'gpt-6-luna', model:'gpt-6-luna'}]};
        if (m.method === 'thread/start') result = {thread:{id:'test-thread'}};
        if (m.method === 'turn/start') {
          result = {turn:{id:'test-turn'}};
          // Completion can arrive before the turn/start response.
          emit({method:'turn/completed',params:{turn:{id:'test-turn',status}}});
        }
        emit({id:m.id,result});
      }
    });
    return child;
  }
  return {calls, home:()=>home, options:{binary:'fake',normalize:v=>v,spawnImpl,timeoutMs:50}};
}
test('isolated activation waits for completion, reads real limits, and removes its home', async () => {
  const f = fixture();
  const result = await activate({accessToken:'private-test-token',accountId:'identity',planType:'plus'},f.options);
  assert.equal(result.model,'gpt-6-luna'); assert.equal(result.usageWindows.fiveHour.usedPercent,1);
  const thread=f.calls.find(m=>m.method==='thread/start');
  assert.equal(thread.params.ephemeral,true); assert.equal(thread.params.approvalPolicy,'never');
  assert.equal(thread.params.sandbox,'read-only'); assert.equal(fs.existsSync(f.home()),false);
});
test('failed or stalled activation does not report a successful reset and cleans up', async () => {
  for (const options of [{status:'failed'},{silent:true}]) {
    const f=fixture(options);
    await assert.rejects(activate({accessToken:'private',accountId:'identity'},f.options));
    assert.equal(fs.existsSync(f.home()),false);
  }
});
test('rechecks live quota and skips an account that started since eligibility was checked', async () => {
  const f=fixture({used:1});
  const result=await activate({accessToken:'private',accountId:'identity'},f.options);
  assert.equal(result.model,null); assert.equal(f.calls.some(m=>m.method==='turn/start'),false);
});
