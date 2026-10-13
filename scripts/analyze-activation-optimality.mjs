import fs from 'node:fs';
import {recommend, key} from '../src/optimizer.js';

// Synthetic counterexample, not a claim about this user's measured quotas.
// Both accounts have fresh five-hour limits. Weekly allowance is the binding
// constraint and will not replenish inside the eight-hour horizon.
const now = Date.UTC(2026, 9, 12, 10);
const account = (name, shortUsed, weeklyUsed) => ({name, email:name, plan:'test', state:'ready', windows:[
  {bucket:'short', usedPercent:shortUsed, resetsAt:now/1000+300*60, windowDurationMins:300},
  {bucket:'weekly', usedPercent:weeklyUsed, resetsAt:now/1000+7*24*3600, windowDurationMins:10080}
]});
const baseline=[account('a',40,40),account('b',0,80)];
const history=Object.fromEntries(baseline.flatMap(a=>a.windows.map(w=>[key(a,w),{rate:1,minutes:60,samples:3}])));
const epsilon=0.1; // Dummy request consumes 0.1 modeled work minutes of each B pool.
const activated=structuredClone(baseline);
for(const w of activated[1].windows) w.usedPercent+=epsilon;
// Grant the activation policy zero elapsed time, zero switches and the same
// first reset, so all other effects favor it or cancel out. Earlier short
// replenishment cannot overcome a weekly bottleneck.
const options={blocks:[[0,480,1]],switchMinutes:0,commitmentMinutes:0,continuityPenalty:0};
function solve(accounts){
 const r=recommend(accounts,'a',new Set(),history,now,options);
 if(r.certificate?.status!=='Optimal')throw Error('Expected optimal solver certificate');
 return {productiveMinutes:r.scores[0].estimatedWeightedWorkMinutes,certificate:r.certificate};
}
const without=solve(baseline),withActivation=solve(activated);
if(Math.abs(without.productiveMinutes-80)>1e-5 || Math.abs(withActivation.productiveMinutes-79.9)>1e-5)throw Error('Counterexample verification failed');
const result={synthetic:true,assumptions:{horizonMinutes:480,activationCostMinutes:epsilon,activationElapsedTime:0,switchMinutes:0,weeklyResetsWithinHorizon:false},
 weeklyCapacityMinutes:{a:60,b:20},withoutActivation:without,withActivation,
 lostProductiveMinutes:without.productiveMinutes-withActivation.productiveMinutes,
 conclusion:'Always activating an unused account is not globally optimal. In a weekly-limited scenario it spends scarce quota without increasing productive capacity.'};
fs.writeFileSync(new URL('../docs/activation-optimality-analysis.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
