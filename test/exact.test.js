import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {recommend,recommendAsync} from '../src/optimizer.js';
const require=createRequire(import.meta.url);
const {solve}=require('../src/exact-worker.cjs');
// Independent exhaustive integer-work oracle, with no LP builder or solver helpers.
function oracle(accounts,first,preferred,slots,commitment=0,penalty=0,cost=0){
 let best=-Infinity,bestSwitches=Infinity;
 function visit(t,last,used,score,early,switches){
  if(t===slots.length){const objective=score-penalty*Math.max(0,commitment-early);if(objective>best){best=objective;bestSwitches=switches}else if(objective===best){bestSwitches=Math.min(bestSwitches,switches)}return}
  const [start,end,weight]=slots[t],duration=end-start;
  for(let a=0;a<accounts.length;a++){
   if((t===0||start<commitment)&&a!==first)continue;
   const capacity=Math.min(...accounts[a].pools.map((p,j)=>(start>=p.reset?p.full:p.left)-used[a][j][start>=p.reset?1:0]));
   const switched=last!==null&&last!==a;
   const overhead=t>0&&start>slots[t-1][1]?0:switched?Math.min(cost,duration):0;
   for(let work=0;work<=Math.min(duration-overhead,capacity);work++){
    const next=structuredClone(used);
    accounts[a].pools.forEach((p,j)=>next[a][j][start>=p.reset?1:0]+=work);
    visit(t+1,a,next,score+work*weight,early+(start<commitment?work:0),switches+Number(switched));
   }
  }
 }
 visit(0,accounts.findIndex(a=>a.name===preferred)>=0?accounts.findIndex(a=>a.name===preferred):null,accounts.map(a=>a.pools.map(()=>[0,0])),0,0,0);return {best,switches:bestSwitches};
}
test('exact solver matches independent exhaustive oracle across 80 seeded schedules',async()=>{
 let seed=923;const rand=n=>{seed=(1664525*seed+1013904223)>>>0;return seed%n};
 for(let trial=0;trial<80;trial++){
  const accounts=['a','b'].map(name=>({name,state:'ready',pools:[{left:rand(5)+1,full:rand(5)+1,reset:rand(2)?2:999},{left:rand(5)+1,full:6,reset:999}]}));
  const cost=rand(2),commitment=rand(2),penalty=1.5;
  const input={accounts,preferred:rand(2)?'a':'b',options:{blocks:[[0,2,1],[3,5,0.5]],stepMinutes:1,commitmentMinutes:commitment,continuityPenalty:penalty,switchMinutes:cost}};
  const results=await solve(input);
  for(let first=0;first<2;first++){const expected=oracle(accounts,first,input.preferred,[[0,1,1],[1,2,1],[3,4,0.5],[4,5,0.5]],commitment,penalty,cost);assert.ok(Math.abs(results[first].estimatedWeightedWorkMinutes-expected.best)<1e-5,`trial ${trial}, first ${first}`);assert.equal(results[first].switches,expected.switches,`switch tie-break trial ${trial}`)}
 }
});
const now=1800000000000;
function a(name,used=0,reset=60){return {name,email:name,plan:'plus',state:'ready',windows:[{bucket:'codex',usedPercent:used,windowDurationMins:300,resetsAt:now/1000+reset*60}]}}
test('exact reset boundaries are preserved without five-minute rounding',()=>{
 const r=recommend([a('a',50,2.25)],null,new Set(),{},now,{blocks:[[0,10,1]],commitmentMinutes:0});
 assert.equal(r.certificate.status,'Optimal');assert.ok(r.schedule.some(s=>s.end===2.25));assert.ok(Math.abs(r.scores[0].estimatedWeightedWorkMinutes-10)<1e-5);
});
test('past reset does not fabricate allowance and all exhausted accounts fail closed',()=>{
 assert.equal(recommend([{...a('a',100,-1),state:'blocked'}],null,new Set(),{},now).account,null);
 const r=recommend([a('a',90,-1)],null,new Set(),{},now,{blocks:[[0,30,1]],commitmentMinutes:0});assert.ok(r.scores[0].estimatedWeightedWorkMinutes<=9+1e-5);
});
test('invalid and duplicate input, exclusions, empty data and invalid options fail closed',()=>{
 for(const accounts of [[],[a('a',NaN)],[a('a',-1)],[a('a',101)],[a('a'),a('a')]])assert.equal(recommend(accounts,null,new Set(),{},now).account,null);
 assert.equal(recommend([a('a')],null,new Set(['a']),{},now).account,null);
 assert.equal(recommend([a('a')],null,new Set(),{},now,{stepMinutes:0}).account,null);
});
test('blocked account can contribute after its reported reset, never be selected now',()=>{
 const r=recommend([a('a',99,99),{...a('b',100,2),state:'blocked'}],null,new Set(),{},now,{blocks:[[0,10,1]],commitmentMinutes:0});
 assert.equal(r.account.name,'a');assert.ok(r.schedule.some(s=>s.account==='b'&&s.workMinutes>0));assert.ok(r.schedule.filter(s=>s.account==='b'&&s.start<2).every(s=>s.workMinutes<1e-5));
});

test('async routing returns the same certified decision without blocking the event loop',async()=>{
 let tick=false;const timer=setTimeout(()=>tick=true,0);
 const input=[a('a',20),a('b',30)];const options={blocks:[[0,10,1]],commitmentMinutes:0};
 const r=await recommendAsync(input,'a',new Set(),{},now,options);clearTimeout(timer);assert.equal(tick,true);assert.equal(r.certificate.status,'Optimal');
 assert.equal(r.account.name,recommend(input,'a',new Set(),{},now,options).account.name);
});
test('continuous replanning has no assumed break regardless of session age',()=>{
 const {blocks}=require('../src/session-clock.cjs');
 assert.deepEqual(blocks(now,now-60*60000),[[0,480,1]]);
 assert.deepEqual(blocks(now,now-180*60000),[[0,480,1]]);
 assert.deepEqual(blocks(now,null),[[0,480,1]]);
});
test('switching time spans a reset-created short slot',async()=>{
 const input={accounts:[{name:'a',state:'ready',pools:[{left:10,full:10,reset:0.5}]}],preferred:'other',options:{blocks:[[0,4,1]],stepMinutes:1,commitmentMinutes:0,switchMinutes:2,continuityPenalty:0}};
 const r=(await solve(input))[0];assert.ok(Math.abs(r.estimatedWeightedWorkMinutes-2)<1e-5);assert.ok(r.schedule.filter(s=>s.end<=2).every(s=>s.workMinutes<1e-5));
});
