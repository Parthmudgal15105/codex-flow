const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'flow-installed-audit-'));
process.env.USER_DATA_DIR=temp;process.env.CODEX_HOME=path.join(temp,'home');
const hub=process.env.FLOW_AUDIT_HUB||path.join(os.homedir(),'Applications/Codex++.app/Contents/Resources/hub');
const {choose}=require(path.join(hub,'flow-routing.cjs'));
const now=Date.now(),checks=[];
const account=(id,left=80)=>({id,accountId:id+'-identity',planType:'plus',usageAt:now,usageWindows:{fiveHour:{source:'primary',usedPercent:100-left,resetAt:now+280*60000,windowMins:300},weekly:{source:'secondary',usedPercent:10,resetAt:now+9000*60000,windowMins:10080},other:[]}});
async function check(name,fn){try{await fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:e.message})}}
(async()=>{
 await check('reject exhausted short window',async()=>assert.equal((await choose([account('a',0),account('b')],null,{},now)).accountId,'b'));
 await check('reject exhausted weekly window',async()=>{const a=account('a');a.usageWindows.weekly.usedPercent=100;assert.equal((await choose([a,account('b')],null,{},now)).accountId,'b')});
 await check('reject stale snapshot',async()=>{const a=account('a');a.usageAt=now-60000;assert.equal(await choose([a],null,{},now),null)});
 await check('reject failed usage read',async()=>{const a=account('a');a.usageError='offline';assert.equal(await choose([a],null,{},now),null)});
 for(const excluded of [['a'],new Set(['a']),{a:true},'a',['a-identity']])await check('honor '+Object.prototype.toString.call(excluded)+' exclusion',async()=>assert.equal(await choose([account('a')],excluded,{},now),null));
 await check('honor persistent auth failure',async()=>assert.equal(await choose([account('a')],null,{a:'auth_ineligible'},now),null));
 await check('temporary quota failure is not permanent ban',async()=>assert.equal((await choose([account('a')],null,{a:'usageLimitExceeded'},now)).accountId,'a'));
 await check('reject unknown quota',async()=>{const a=account('a');a.usageWindows.fiveHour.usedPercent=null;assert.equal(await choose([a],null,{},now),null)});
 await check('decision is certified and excludes credentials',async()=>{const a=account('a');a.accessToken='private-test-value';const result=await choose([a],null,{},now);assert.equal(result.certificate.status,'Optimal');assert.equal(JSON.stringify(result).includes(a.accessToken),false)});
 console.log(JSON.stringify({testedAt:new Date().toISOString(),hub,checks},null,2));fs.rmSync(temp,{recursive:true,force:true});process.exitCode=checks.some(c=>!c.passed)?1:0;
})().catch(e=>{console.error(e.message);process.exitCode=1});
