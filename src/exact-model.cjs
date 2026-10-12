function buildModel({accounts, preferred, options={}}) {
 const step=options.stepMinutes??1, blocks=options.blocks??[[0,180,1],[300,480,1]], commitment=options.commitmentMinutes??15;
 if(!Number.isFinite(step)||step<=0||!Number.isFinite(commitment)||commitment<0||!Array.isArray(blocks)||!blocks.length||blocks.some((b,i)=>b.length!==3||b.some(v=>!Number.isFinite(v))||b[0]<0||b[1]<=b[0]||b[2]<=0||(i&&b[0]<blocks[i-1][1])))throw Error('Invalid scheduling options');
 if(blocks[0][0]!==0||!Number.isFinite(options.switchMinutes??2)||(options.switchMinutes??2)<0||!Number.isFinite(options.continuityPenalty??1.5)||(options.continuityPenalty??1.5)<0)throw Error('Invalid scheduling options');
 const horizon=blocks.at(-1)[1]; if(horizon>1440||horizon/step>1000||accounts.length>8)throw Error('Scheduling problem exceeds supported size');
 const boundaries=new Set(blocks.flatMap(b=>b.slice(0,2)));
 for(const [start,end] of blocks)for(let t=start;t<end;t+=step)boundaries.add(t);
 if(commitment>0&&commitment<blocks[0][1])boundaries.add(commitment);
 for(const a of accounts)for(const p of a.pools)if(p.reset>0&&p.reset<horizon)boundaries.add(p.reset);
 const points=[...boundaries].sort((a,b)=>a-b), slots=[];
 for(let k=0;k<points.length-1;k++){const start=points[k],end=points[k+1],block=blocks.find(b=>start>=b[0]&&end<=b[1]);if(block)slots.push({start,end,weight:block[2]});}
 const rows=[],bounds=[`0 <= shortfall <= ${commitment}`],binary=[],objective=[`-${options.continuityPenalty??1.5} shortfall`],switches=[];
 const add=(terms,op,value)=>rows.push(`${terms.join(' + ')} ${op} ${value}`);
 for(let t=0;t<slots.length;t++){
  const slot=slots[t],d=slot.end-slot.start;
  add(accounts.map((_,a)=>`y${a}_${t}`),'=',1);
  for(let a=0;a<accounts.length;a++){
   const y=`y${a}_${t}`,z=`z${a}_${t}`,w=`w${a}_${t}`;
   binary.push(y,z);bounds.push(`0 <= ${w} <= ${d}`);
   add([w,`-${d} ${y}`],'<=',0);
   if(t===0)add([z,`-1 ${y}`],'>=',accounts[a].name===preferred?-1:preferred?0:-1);
   else add([z,`-1 ${y}`,`y${a}_${t-1}`],'>=',0);
   objective.push(`${slot.weight} ${w}`);switches.push(z);
  }
 }
 // Switch overhead spans short slots and exact reset boundaries. Charge only
 // overlap with work slots; switches prepared during a break cost no work.
 for(let t=0;t<slots.length;t++){
  const terms=accounts.map((_,a)=>`w${a}_${t}`);
  for(let k=0;k<=t;k++)for(let a=0;a<accounts.length;a++){
   const free=(k===0&&!preferred)||(k>0&&slots[k].start>slots[k-1].end);
   const cost=free?0:(options.switchMinutes??2);
   const overlap=Math.max(0,Math.min(slots[t].end,slots[k].start+cost)-slots[t].start);
   if(overlap>0)terms.push(`${overlap} z${a}_${k}`);
  }
  add(terms,'<=',slots[t].end-slots[t].start);
 }
 for(let a=0;a<accounts.length;a++)for(const p of accounts[a].pools)for(const after of [false,true]){
  const indexes=slots.map((s,t)=>({s,t})).filter(({s})=>after?s.start>=p.reset:s.start<p.reset);
  if(indexes.length)add(indexes.map(({t})=>`w${a}_${t}`),'<=',Math.min(horizon,after?p.full:p.left));
 }
 if(commitment>0)add(['shortfall',...slots.flatMap((s,t)=>s.start<commitment?accounts.map((_,a)=>`w${a}_${t}`):[])],'>=',Math.min(commitment,blocks[0][1]-blocks[0][0]));
 return {accounts,slots,rows,bounds,binary,objective,switches,commitment,options};
}
function lp(m,first,secondary=false,optimal=null){
 const rows=[...m.rows];
 for(let t=0;t<m.slots.length&&m.slots[t].start<m.commitment;t++)rows.push(`y${first}_${t} = 1`);
 rows.push(`y${first}_0 = 1`);
 if(optimal!==null)rows.push(`${m.objective.join(' + ')} >= ${optimal-1e-7}`);
 return `${secondary?'Minimize':'Maximize'}\n obj: ${(secondary?m.switches:m.objective).join(' + ').replaceAll('+ -','- ')}\nSubject To\n${rows.map((r,i)=>` c${i}: ${r.replaceAll('+ -','- ')}`).join('\n')}\nBounds\n${m.bounds.join('\n')}\nBinary\n${m.binary.join(' ')}\nEnd`;
}
module.exports={buildModel,lp};
