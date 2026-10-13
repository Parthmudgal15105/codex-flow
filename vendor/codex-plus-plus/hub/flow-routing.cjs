const store=require('./store.cjs'),routing=require('./routing.cjs');
const {recommendAsync,learn}=require('./flow-optimizer.cjs');
function normalize(a,now=Date.now()){
 const u=routing.usageForAccount(a);
 const windows=[u.fiveHour,u.weekly,...u.other].filter(Boolean).map(w=>({usedPercent:w.usedPercent,resetsAt:w.resetAt===null?null:w.resetAt/1000,windowDurationMins:w.windowMins,bucket:w.bucket||w.source}));
 const known=!a.usageError&&Number.isFinite(a.usageAt)&&a.usageAt<=now&&now-a.usageAt<60000&&windows.length&&windows.every(w=>Number.isFinite(w.usedPercent));
 // Account identity, rather than email, separates individual workspaces.
 return {name:a.id,email:a.accountId||a.email,plan:a.planType,state:known?(u.exhausted||a.rateLimitReached?'blocked':'ready'):'unknown',windows};
}
const fs=require('node:fs'),path=require('node:path');
const clockFile=path.join(store.userDataDir(),'flow-work-session.json');
function started(){try{return JSON.parse(fs.readFileSync(clockFile,'utf8')).started}catch{return null}}
function startSession(){const now=Date.now(),start=started();if(!Number.isFinite(start)||now<start||now-start>=180*60000){const temp=clockFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({started:now}),{mode:0o600});fs.renameSync(temp,clockFile)}}
const learning=require('./desktop-learning.cjs')({file:require('node:path').join(store.userDataDir(),'flow-usage-learning.json'),snapshot:id=>{const a=store.findAccount(id);return a?normalize(a):null},refresh:()=>require('./usage.cjs').refreshAll({force:true}),learn});
async function choose(list,excluded,learned,now=Date.now()){
 const selectionStarted=Date.now();
 const denied=new Set(excluded instanceof Set?excluded:Array.isArray(excluded)?excluded:typeof excluded==='string'?[excluded]:excluded&&typeof excluded==='object'?Object.keys(excluded).filter(k=>excluded[k]):[]);
 const accounts=list.filter(a=>routing.isEligible(a,learned)&&!denied.has(a.id)&&!denied.has(a.accountId)).map(a=>normalize(a,now));
 let result;
 try {
  result=await recommendAsync(accounts,store.activeAccountId(),new Set(),learning.read(),now,{blocks:require('./session-clock.cjs').blocks(now,started()),switchMinutes:require('./switch-learning.cjs')(path.join(store.userDataDir(),'flow-switch-minutes.json')).minutes(),solverTimeLimitSeconds:1});
 } catch (error) { result={account:null,reason:error.message}; }
 const checkedNow=now+Math.max(0,Date.now()-selectionStarted);
 const latest=accounts.filter(a=>a.state==='ready').map(a=>normalize(list.find(raw=>raw.id===a.name),checkedNow));
 if(result.account&&!latest.some(a=>a.name===result.account.name&&a.state==='ready'))result={account:null,reason:'Quota observation expired during optimization.'};
 if(!result.account){
  // Optimization failure says nothing about account availability. Only fresh,
  // complete, eligible quota observations may take this independent path.
  const ready=new Set(latest.filter(a=>a.state==='ready'&&a.windows.every(w=>w.usedPercent>=0&&w.usedPercent<100&&Number.isFinite(w.windowDurationMins)&&w.windowDurationMins>0)).map(a=>a.name));
  const verified=list.filter(a=>ready.has(a.id));
  const current=verified.find(a=>a.id===store.activeAccountId());
  const selected=current??routing.chooseAccount(verified,null,learned,now)?.account;
  if(!selected)return null;
  const failure=result.reason??'Scheduler unavailable';
  result={account:{name:selected.id},reason:'Using a freshly verified account; schedule optimization is unavailable.',confidence:'verified-availability',certificate:{status:'VerifiedAvailable',optimal:false,schedulerFailure:failure},scores:[]};
 }

 const report=path.join(store.userDataDir(),'flow-last-decision.json'),temp=report+'.tmp';
 fs.writeFileSync(temp,JSON.stringify({checkedAt:now,accountId:result.account.name,confidence:result.confidence,certificate:result.certificate,scores:result.scores}),{mode:0o600});fs.renameSync(temp,report);
 return {accountId:result.account.name,account:((a)=>({id:a.id,label:a.label,planType:a.planType}))(list.find(a=>a.id===result.account.name)),reason:{explanation:result.reason,confidence:result.confidence},certificate:result.certificate,scores:result.scores};
}
async function prepare(excluded){
 await learning.wait();
 await require('./usage.cjs').refreshAll({force:true});
 await require('./desktop-activation.cjs').ensure(excluded).catch(()=>console.error('==> flow automatic window activation unavailable'));
}
async function schedule(excluded){
 await prepare(excluded);
 return choose(store.accounts(),excluded,routing.read().learnedIneligible);
}
module.exports={choose,normalize,learning,startSession,prepare,schedule};
