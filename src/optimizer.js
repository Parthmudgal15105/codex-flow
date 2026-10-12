// Receding-horizon scheduling. All capacities are estimated WORK MINUTES, not
// interchangeable percentages. Real availability is always re-read before work.
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const solverPath=fileURLToPath(new URL('./exact-worker.cjs',import.meta.url));
export function key(account, window) {
  return `${account.email || account.name}|${account.plan || ''}|${window.bucket}|${window.windowDurationMins}`;
}
export function learn(history, before, after, minutes) {
  if(!before||!Array.isArray(before.windows)||!Array.isArray(after?.windows))return history;
  if (!Number.isFinite(minutes) || minutes < 0.25 || !after || before.email !== after.email || before.plan !== after.plan) return history;
  const next = { ...history };
  for (const w of before.windows) {
    const end = after.windows.find(v => key(after, v) === key(before, w));
    if (!end || end.resetsAt !== w.resetsAt) continue;
    const delta = end.usedPercent - w.usedPercent;
    if (!(delta > 0) || delta > 100) continue;
    const id = key(before, w), stored = next[id], previous = Number.isFinite(stored?.rate)&&stored.rate>0&&Number.isFinite(stored?.minutes)&&stored.minutes>=0?stored:null;
    // Keep recent workloads influential without treating one rounding tick as truth.
    const weight = Math.min(minutes, 60);
    const oldWeight = Math.min(previous?.minutes || 0, 180);
    next[id] = { rate: ((previous?.rate || 0) * oldWeight + delta / minutes * weight) / (oldWeight + weight), minutes: oldWeight + weight, samples: (Number.isInteger(previous?.samples)&&previous.samples>=0?previous.samples:0) + 1 };
  }
  return next;
}
function poolModel(account, history, now) {
 return account.windows.map(w=>{
  const observation=history[key(account,w)];
  const rate=observation?.rate>0&&Number.isFinite(observation.rate)?observation.rate:100/90;
  const delta=Number.isFinite(w.resetsAt)?(w.resetsAt*1000-now)/60000:Infinity;
  return {left:(100-w.usedPercent)/rate,full:100/rate,reset:Number.isFinite(delta)&&delta>0?delta:1e9};
 });
}
function prepareRecommendation(accounts, preferred, excluded, history, now, options) {
 if(!Array.isArray(accounts))return {account:null,reason:'Invalid scheduling data.',confidence:'unavailable'};
 const denied=excluded instanceof Set?excluded:new Set(Array.isArray(excluded)?excluded:typeof excluded==='string'?[excluded]:excluded&&typeof excluded==='object'?Object.keys(excluded).filter(k=>excluded[k]):[]);
 const valid=a=>a&&typeof a.name==='string'&&['ready','blocked'].includes(a.state)&&!denied.has(a.name)&&Array.isArray(a.windows)&&a.windows.length&&a.windows.every(w=>Number.isFinite(w.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100&&Number.isFinite(w.windowDurationMins)&&w.windowDurationMins>0);
 const modeled=accounts.filter(valid).map(a=>({...a,state:a.windows.some(w=>w.usedPercent>=100)?'blocked':a.state,pools:poolModel(a,history,now)})).sort((a,b)=>a.name.localeCompare(b.name));
 if(!Number.isFinite(now)||new Set(modeled.map(a=>a.name)).size!==modeled.length)return {account:null,reason:'Invalid scheduling data.',confidence:'unavailable'};
 if(!modeled.some(a=>a.state==='ready'))return {account:null,reason:'No account has verified available allowance.',confidence:'unavailable'};
 return {modeled};
}
function finishRecommendation(result, accounts, preferred, history) {
 if(!result?.results?.length)return {account:null,reason:result?.error||'Exact scheduler unavailable; no unverified route selected.',confidence:'unavailable'};
 const ranked=result.results.sort((a,b)=>Math.abs(b.estimatedWeightedWorkMinutes-a.estimatedWeightedWorkMinutes)>1e-5?b.estimatedWeightedWorkMinutes-a.estimatedWeightedWorkMinutes:a.switches-b.switches||Number(b.account===preferred)-Number(a.account===preferred)||a.account.localeCompare(b.account));
 const best=ranked[0],selected=accounts.find(a=>a.name===best.account);
 const learned=accounts.filter(a=>['ready','blocked'].includes(a.state)).every(a=>a.windows.every(w=>history[key(a,w)]?.samples>=3));
 return {account:selected,reason:`${selected.name===preferred?'Keeping':'Choosing'} Account ${selected.name.toUpperCase()}. Proven best modeled schedule for your work blocks, quota resets and switching time. ${learned?'Uses measured usage costs.':'Usage costs are starter estimates.'}`,confidence:learned?'learning-based':'starter-estimate',certificate:best.certificate,schedule:best.schedule,scores:ranked.map(({schedule,certificate,...s})=>s)};
}

export function recommend(accounts, preferred, excluded = new Set(), history = {}, now = Date.now(), options = {}) {
 history=history&&typeof history==='object'?history:{};options=options&&typeof options==='object'?options:{};
 const prep=prepareRecommendation(accounts,preferred,excluded,history,now,options);if(!prep.modeled)return prep;
 const response=spawnSync(process.execPath,[solverPath],{input:JSON.stringify({accounts:prep.modeled,preferred,now,options}),encoding:'utf8',timeout:25000,maxBuffer:8*1024*1024});
 let result;try{result=JSON.parse(response.stdout)}catch{}
 if(response.error||response.status!==0)return finishRecommendation({error:result?.error},accounts,preferred,history);
 return finishRecommendation(result,accounts,preferred,history);
}
export async function recommendAsync(accounts, preferred, excluded = new Set(), history = {}, now = Date.now(), options = {}) {
 history=history&&typeof history==='object'?history:{};options=options&&typeof options==='object'?options:{};
 const prep=prepareRecommendation(accounts,preferred,excluded,history,now,options);if(!prep.modeled)return prep;
 const result=await new Promise(resolve=>{
  const child=spawn(process.execPath,[solverPath],{stdio:['pipe','pipe','pipe']});let output='',done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result)};
  const timer=setTimeout(()=>{child.kill();finish({error:'Exact scheduler timed out; no optimality claim made.'})},25000);
  child.stderr.resume();child.on('error',()=>finish({error:'Could not start exact scheduler.'}));child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>8*1024*1024){child.kill();finish({error:'Scheduler response exceeded size limit.'})}});
  child.on('close',()=>{try{finish(JSON.parse(output))}catch{finish({error:'Invalid scheduler response.'})}});
  child.stdin.end(JSON.stringify({accounts:prep.modeled,preferred,now,options}));
 });
 return finishRecommendation(result,accounts,preferred,history);
}
