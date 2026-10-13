const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
const base=path.resolve(__dirname,'../vendor/codex-plus-plus/hub');
const {authClaims}=require(base+'/claims.cjs');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'flow-live-test-'));
const child=spawn('/Users/parthmudgal/Applications/Codex++.app/Contents/Resources/codex-cli/bin/codex',['app-server','--stdio'],{env:{...process.env,CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_ACCESS_TOKEN:''},stdio:['pipe','pipe','ignore']});
let next=0;const pending=new Map(),waiters=[];let events=[];
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}else if(m.method){events.push(m);for(const w of [...waiters])if(w.match(m)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m)}}});
function rpc(method,params={}){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(method+' timed out')),45000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
function event(match){const seen=events.find(match);if(seen)return Promise.resolve(seen);return new Promise((resolve,reject)=>{const w={match,resolve,timer:setTimeout(()=>reject(new Error('turn timed out')),120000)};waiters.push(w)})}
async function login(name){const a=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.codex-flow/accounts',name,'auth.json'),'utf8'));const t=a.tokens,c=authClaims(t.access_token);await rpc('account/login/start',{type:'chatgptAuthTokens',accessToken:t.access_token,chatgptAccountId:c.chatgpt_account_id||t.account_id,chatgptPlanType:c.chatgpt_plan_type});const result=await rpc('account/read',{refreshToken:false});if(result.account?.planType!=='plus')throw Error('Account confirmation failed');console.log('Account '+name.toUpperCase()+' selected and confirmed');}
async function turn(threadId,text,extra=[],options={}){events=[];const r=await rpc('turn/start',{threadId,input:[{type:'text',text},...extra],...options});const complete=await event(m=>m.method==='turn/completed'&&m.params.turn.id===r.turn.id);const messages=events.filter(m=>m.method==='item/completed'&&m.params.item.type==='agentMessage').map(m=>m.params.item.text).join('\n');return {status:complete.params.turn.status,error:complete.params.turn.error?.codexErrorInfo||complete.params.turn.error?.message,text:messages};}
(async()=>{
 await rpc('initialize',{clientInfo:{name:'codex_flow_test',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
 await login('b');const models=await rpc('model/list');const model=models.data.find(m=>m.isDefault)?.id||models.data[0]?.id;
 const {thread}=await rpc('thread/start',{cwd:home,approvalPolicy:'never',sandbox:'read-only',model});
 const first=await turn(thread.id,'Continuity test only. Remember the invented phrase COBALT OTTER 428. Reply exactly READY. Do not use tools.');
 console.log(JSON.stringify({step:'B initial message',...first}));if(first.status!=='completed')throw Error('Initial turn failed');
 await login('a');const blocked=await turn(thread.id,'Reply exactly ACCOUNT_A_OK. Do not use tools.');console.log(JSON.stringify({step:'A quota test',...blocked}));
 await login('b');await rpc('thread/resume',{threadId:thread.id});
 const final=await turn(thread.id,'What invented phrase did I ask you to remember? Reply with that phrase only. Do not use tools.');
 const pass=final.status==='completed'&&final.text.includes('COBALT OTTER 428');console.log(JSON.stringify({step:'B resumes same conversation',...final,continuityPassed:pass}));if(!pass)throw Error('Continuity failed');
 await rpc('thread/resume',{threadId:thread.id,approvalPolicy:'never',sandbox:'workspace-write'});
 const coding=await turn(thread.id,'This is an isolated test folder. Inspect the attached app icon briefly, then use a terminal tool to create flow-proof.txt in the current working directory containing exactly CODEX_FLOW_BUILD_OK. Do not modify any other files. Reply with a brief description of the image and confirm the file.',[{type:'localImage',path:path.resolve(__dirname,'../assets/codex-flow-icon.png')}],{approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[home],networkAccess:false}});
 const fileOK=fs.existsSync(path.join(home,'flow-proof.txt'))&&fs.readFileSync(path.join(home,'flow-proof.txt'),'utf8').trim()==='CODEX_FLOW_BUILD_OK';
 console.log(JSON.stringify({step:'image attachment and real coding',...coding,fileVerified:fileOK}));if(coding.status!=='completed'||!fileOK)throw Error('Coding/image test failed');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>{lines.close();child.kill();for(const p of pending.values())clearTimeout(p.timer);for(const w of waiters)clearTimeout(w.timer);setTimeout(()=>fs.rmSync(home,{recursive:true,force:true}),1000)});
