// Read local synced chats through the official engine. No login, prompts, or inference.
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const [home,idsJSON]=process.argv.slice(2);
const child=spawn('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',['-c','features.code_mode_host=true','app-server'],{env:{...process.env,CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_ACCESS_TOKEN:''},stdio:['pipe','pipe','ignore']});
let next=0;const pending=new Map();
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{let msg;try{msg=JSON.parse(line)}catch{return}const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result)});
function rpc(method,params){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
(async()=>{
 await rpc('initialize',{clientInfo:{name:'codex_flow_sync_validation',version:'1'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const listed=await rpc('thread/list',{limit:100,useStateDbOnly:false});
 const result=[];
 for(const id of JSON.parse(idsJSON)){
  const {thread}=await rpc('thread/read',{threadId:id,includeTurns:true});
  if(thread.id!==id)throw Error('History identity mismatch');
  const page=await rpc('thread/turns/list',{threadId:id,limit:5,sortDirection:'desc',itemsView:'full'});
  if(!page.data?.length)throw Error('No readable turns for '+id+'; response fields '+JSON.stringify(Object.fromEntries(Object.entries(page).map(([k,v])=>[k,Array.isArray(v)?v.length:typeof v]))));
  const turns=thread.turns||[];
  const items=turns.flatMap(t=>t.items||[]);
  if(!items.some(i=>i.type==='userMessage')||!items.some(i=>i.type==='agentMessage'))throw Error('Conversation text not restored for '+id+'; '+JSON.stringify({turns:turns.length,itemTypes:items.map(i=>i.type),pageFirstKeys:Object.keys(page.data[0]||{}),pageItemTypes:page.data.flatMap(t=>(t.items||t.turn?.items||[]).map(i=>i.type)),turnItemsView:turns[0]?.itemsView}));
  result.push({id,readable:true,turns:turns.length,userMessages:items.filter(i=>i.type==='userMessage').length,assistantMessages:items.filter(i=>i.type==='agentMessage').length});
 }
 console.log(JSON.stringify({officialEngineReadPassed:true,chats:result}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>{lines.close();child.kill();for(const p of pending.values())clearTimeout(p.timer)});
