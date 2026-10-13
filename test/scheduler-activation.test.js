import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
test('scheduler activates before optimizing and uses the new quota snapshot and exclusions', async t => {
  const hub = path.resolve('vendor/codex-plus-plus/hub');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'flow-schedule-test-'));
  const replaced = new Map(), order = [], denied = ['excluded'];
  const now = Date.now();
  let list = [{id:'b',accountId:'identity',label:'B',usageAt:now,usageWindows:{fiveHour:{usedPercent:0,resetAt:null,windowMins:300},other:[]}}];
  function mock(name, exports) {
    const id=require.resolve(path.join(hub,name)); replaced.set(id,require.cache[id]);
    require.cache[id]={id,filename:id,loaded:true,exports};
  }
  t.after(()=>{for(const [id,original] of replaced) original?require.cache[id]=original:delete require.cache[id];fs.rmSync(dir,{recursive:true,force:true});});
  mock('store.cjs',{userDataDir:()=>dir,accounts:()=>list,activeAccountId:()=> 'b'});
  mock('routing.cjs',{usageForAccount:a=>({...a.usageWindows,other:[],exhausted:false}),isEligible:()=>true,read:()=>({learnedIneligible:{}})});
  mock('desktop-learning.cjs',()=>({wait:async()=>order.push('learning'),read:()=>({})}));
  mock('usage.cjs',{refreshAll:async()=>order.push('refresh')});
  mock('desktop-activation.cjs',{ensure:async excluded=>{
    order.push('activation');assert.deepEqual(excluded,denied);
    list=[{...list[0],usageAt:Date.now(),usageWindows:{fiveHour:{usedPercent:1,resetAt:now+300*60_000,windowMins:300},other:[]}}];
  }});
  mock('flow-optimizer.cjs',{learn:()=>{},recommendAsync:async accounts=>{
    order.push('optimize');assert.equal(accounts[0].windows[0].usedPercent,1);
    assert.equal(accounts[0].windows[0].resetsAt,(now+300*60_000)/1000);
    return {account:{name:'b'},confidence:'test',certificate:{status:'Optimal'},scores:[]};
  }});
  const flowId=require.resolve(path.join(hub,'flow-routing.cjs'));
  replaced.set(flowId,require.cache[flowId]);delete require.cache[flowId];
  const result=await require(flowId).schedule(denied);
  assert.equal(result.accountId,'b');assert.deepEqual(order,['learning','refresh','activation','optimize']);
});
