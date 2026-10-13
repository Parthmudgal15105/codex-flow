import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const hub=path.resolve('vendor/codex-plus-plus/hub');
const now=Date.now();
const account=(id,usedPercent=10)=>({id,accountId:id,label:id,planType:'plus',usageAt:now,usageWindows:{fiveHour:{usedPercent,resetAt:now+3600000,windowMins:300},weekly:{usedPercent:20,resetAt:now+604800000,windowMins:10080},other:[]}});

test('optimizer timeout does not turn verified quota into a submission failure',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-available-'));
 const originals=new Map();
 function mock(name,exports){const id=require.resolve(path.join(hub,name));originals.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};}
 mock('store.cjs',{userDataDir:()=>dir,activeAccountId:()=> 'a'});
 mock('desktop-learning.cjs',()=>({read:()=>({})}));
 mock('flow-optimizer.cjs',{learn:()=>{},recommendAsync:async()=>({account:null,reason:'Scheduler could not prove optimality: Time limit reached'})});
 const id=require.resolve(path.join(hub,'flow-routing.cjs'));originals.set(id,require.cache[id]);delete require.cache[id];
 t.after(()=>{for(const [id,entry] of originals)entry?require.cache[id]=entry:delete require.cache[id];fs.rmSync(dir,{recursive:true,force:true});});
 const {choose}=require(id);
 const result=await choose([account('a'),account('b')],null,{},now);
 assert.equal(result.accountId,'a');assert.equal(result.certificate.status,'VerifiedAvailable');assert.equal(result.certificate.optimal,false);assert.match(result.certificate.schedulerFailure,/Time limit/);
 const switched=await choose([account('a'),account('b')],['a'],{},now);assert.equal(switched.accountId,'b');
 for(const change of [{usageAt:now-60000},{usageAt:now+1},{usageError:'offline'},{rateLimitReached:true},{usageWindows:{}},{usageWindows:{fiveHour:{usedPercent:NaN,windowMins:300},other:[]}}])assert.equal(await choose([{...account('a'),...change}],null,{},now),null);
 assert.equal(await choose([account('a',100)],null,{},now),null);
 assert.equal(await choose([account('a')],['a'],{},now),null);
 assert.equal(await choose([account('a')],null,{a:'ineligible'},now),null);
 assert.equal(await choose([{...account('a'),planType:'free'}],null,{},now),null);
});
