import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'flow-adapter-'));
process.env.USER_DATA_DIR=dir;process.env.CODEX_HOME=join(dir,'home');
const require=createRequire(import.meta.url);
const {choose,normalize}=require('../vendor/codex-plus-plus/hub/flow-routing.cjs');
const {normalizeAllRateLimits}=require('../vendor/codex-plus-plus/hub/rate-limits.cjs');
const now=Date.now();
const account=()=>({id:'a',accountId:'identity',label:'Account A',planType:'plus',usageAt:now,usageWindows:{fiveHour:{usedPercent:10,resetAt:now+300*60000,windowMins:300},weekly:{usedPercent:20,resetAt:now+10080*60000,windowMins:10080},other:[]}});
test('adapter honors every exclusion representation and identity exclusions',async()=>{
 for(const excluded of [new Set(['a']),['a'],'a',{a:true},['identity']])assert.equal(await choose([account()],excluded,{},now),null);
});
test('adapter rejects stale, future, failed, missing and exhausted quota snapshots',async()=>{
 for(const change of [{usageAt:now-60000},{usageAt:now+1},{usageError:'offline'},{usageWindows:{}},{rateLimitReached:true}])assert.equal(await choose([{...account(),...change}],null,{},now),null);
 const a=account();a.usageWindows.other=[{usedPercent:100,resetAt:now+60000,windowMins:60}];assert.equal(await choose([a],null,{},now),null);
});
test('adapter preserves unknown reset and uses workspace identity for learning',()=>{
 const a=account();a.usageWindows.fiveHour.resetAt=null;const result=normalize(a,now);assert.equal(result.windows[0].resetsAt,null);assert.equal(result.email,'identity');
});
test('all quota buckets retain separate resources and server-blocked status',()=>{
 const r=normalizeAllRateLimits({rateLimitsByLimitId:{codex:{primary:{usedPercent:10,resetsAt:123,windowDurationMins:300}},other:{primary:{usedPercent:100,resetsAt:456,windowDurationMins:60},rateLimitReachedType:'quota'}}});
 assert.equal(r.rateLimitReached,true);assert.equal(r.usageWindows.fiveHour.bucket,'codex:primary');assert.equal(r.usageWindows.other[0].bucket,'other:primary');
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));
