const fs=require('node:fs'),path=require('node:path');
module.exports=function createLearning({file,snapshot,refresh,learn,clock=Date.now}){
 const running=new Map();let pending=Promise.resolve();
 function read(){try{const value=JSON.parse(fs.readFileSync(file,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}}
 function save(history){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(history),{mode:0o600});fs.renameSync(temp,file)}
 return {
  read,wait:()=>pending,activeAccounts:()=>[...running.values()].map(r=>r.accountId||r.before?.name).filter(Boolean),
  async begin(threadId,accountId){await pending;if(running.size){for(const r of running.values())r.invalid=true;running.set(threadId,{invalid:true,accountId});return false;}const before=snapshot(accountId);if(!before||before.state!=='ready')return false;running.set(threadId,{before,started:clock()});return true},
  end(threadId){const run=running.get(threadId);if(!run)return pending;running.delete(threadId);if(run.invalid)return pending;const minutes=(clock()-run.started)/60000;pending=pending.then(async()=>{await refresh();const after=snapshot(run.before.name);if(after&&after.state!=='unknown')save(learn(read(),run.before,after,minutes))}).catch(()=>{});return pending}
 };
};
