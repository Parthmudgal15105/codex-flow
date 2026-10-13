const {buildModel,lp}=require('./exact-model.cjs');
async function solve(input){
 const highs=await require('highs')();
 const model=buildModel(input),results=[];
 for(let first=0;first<input.accounts.length;first++){
  if(input.accounts[first].state!=='ready')continue;
  const options={output_flag:false,mip_rel_gap:0,mip_abs_gap:0,time_limit:input.options?.solverTimeLimitSeconds??8,random_seed:0};
  const primary=highs.solve(lp(model,first),options);
  if(primary.Status!=='Optimal')throw Error(`Scheduler could not prove optimality: ${primary.Status}`);
  const secondary=highs.solve(lp(model,first,true,primary.ObjectiveValue),options);
  if(secondary.Status!=='Optimal')throw Error(`Scheduler tie-break could not prove optimality: ${secondary.Status}`);
  const schedule=model.slots.map((s,t)=>({...s,account:input.accounts.find((a,i)=>secondary.Columns[`y${i}_${t}`].Primal>0.5)?.name,workMinutes:input.accounts.reduce((n,a,i)=>n+secondary.Columns[`w${i}_${t}`].Primal,0)}));
  for(const a of input.accounts)for(const p of a.pools)for(const after of [false,true]){
   const consumed=schedule.filter(s=>s.account===a.name&&(after?s.start>=p.reset:s.start<p.reset)).reduce((n,s)=>n+s.workMinutes,0);
   if(consumed>(after?p.full:p.left)+1e-5)throw Error('Solver returned an invalid quota allocation');
  }
  if(schedule.some(s=>s.workMinutes< -1e-5||s.workMinutes>s.end-s.start+1e-5))throw Error('Solver returned invalid slot work');
  if(Math.abs(schedule.reduce((n,s)=>n+s.weight*s.workMinutes,0)-(input.options?.continuityPenalty??1.5)*secondary.Columns.shortfall.Primal-primary.ObjectiveValue)>1e-5)throw Error('Solver objective validation failed');
  const account=input.accounts[first],horizon=model.slots.at(-1).end;
  const nextResetMinutes=Math.min(...account.pools.filter(p=>p.left>1e-5&&p.full>0&&p.reset>0&&p.reset<horizon).map(p=>p.reset));
  results.push({account:account.name,estimatedWeightedWorkMinutes:primary.ObjectiveValue,estimatedProductiveMinutes:schedule.reduce((n,s)=>n+s.workMinutes,0),quotaShortfallMinutes:secondary.Columns.shortfall.Primal,nextResetMinutes:Number.isFinite(nextResetMinutes)?nextResetMinutes:null,switches:Math.round(secondary.ObjectiveValue),schedule,certificate:{status:'Optimal',method:'HiGHS mixed-integer branch-and-cut',relativeGap:0,absoluteTolerance:1e-5,model:'finite-horizon-v3',objectiveValue:primary.ObjectiveValue,objective:'weighted productive minutes minus quota-related initial continuity shortfall; startup switch time charged once',tieBreak:['earliest reported reset with remaining allowance within horizon','fewest switches','active account','account identifier'],blocks:input.options?.blocks??[[0,180,1],[300,480,1]],switchMinutes:input.options?.switchMinutes??2,continuityPenalty:input.options?.continuityPenalty??1.5,stepMinutes:input.options?.stepMinutes??1,commitmentMinutes:model.commitment}});
 }
 return results;
}
module.exports={solve};
if(require.main===module){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{process.stdout.write(JSON.stringify({results:await solve(JSON.parse(input))}))}catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1}})}
