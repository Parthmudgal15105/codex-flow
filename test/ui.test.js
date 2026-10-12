import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { sharedPrompt } from '../src/ui.js';
const fake = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const name=process.env.CODEX_HOME.split('/').pop();
if(process.argv.includes('app-server')) {
 createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(!m.id) return;
  let result={};
  if(m.method==='account/read') result={account:{type:'chatgpt',email:name+'@test.local',planType:'plus'}};
  if(m.method==='account/rateLimits/read') result={rateLimits:{primary:{usedPercent:process.env.BLOCK_ALL ? 100 : 10, windowDurationMins:300,resetsAt:1999999999}}};
  console.log(JSON.stringify({id:m.id,result}));
 });
} else {
 let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
  appendFileSync(process.env.TRACE,JSON.stringify({name,prompt,args:process.argv})+'\\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:name+'-session'}));
  if(name==='a'&&!existsSync(process.env.MARKER)&&!process.env.NO_FAIL) {
   writeFileSync(process.env.MARKER,'yes');
   console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Remember: use blue buttons.'}}));
   console.log(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit'}}));process.exitCode=1;
  } else {
   console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read files',aggregated_output:'file content',exit_code:0}}));
   console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Here is the answer.'}}));
   console.log(JSON.stringify({type:'turn.completed'}));
  }
 });
}
`;
function run(payload, env) {
 return new Promise((resolveResult,reject)=>{
  const p=spawn(process.execPath,[resolve('src/cli.js'),'ui-run'],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
  p.on('close',code=>resolveResult({code,events:out.trim().split('\n').filter(Boolean).map(JSON.parse),err}));p.stdin.end(JSON.stringify(payload));
 });
}
async function fixture(fn) {
 const temp=await mkdtemp(join(tmpdir(),'flow-ui-'));
 try {
  const exe=join(temp,'codex.mjs'),project=join(temp,'project'),trace=join(temp,'trace');
  await mkdir(project);await writeFile(exe,fake,{mode:0o700});
  await fn({project,trace,env:{CODEX_FLOW_HOME:join(temp,'home'),CODEX_FLOW_CODEX:exe,TRACE:trace,MARKER:join(temp,'marker')}});
 } finally {await rm(temp,{recursive:true,force:true});}
}
test('UI Ask handoff preserves discussion and is read-only without project notes',()=>fixture(async ({project,trace,env})=>{
 const r=await run({project,chat:'chat-1',task:'How should we implement login?',mode:'ask'},env);
 assert.equal(r.code,0,r.err);assert.ok(r.events.some(e=>e.type==='handoff'));assert.ok(r.events.some(e=>e.type==='message'&&e.text==='Here is the answer.'));
 await assert.rejects(access(join(project,'implementation.md')));
 const rows=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.match(rows[1].prompt,/Remember: use blue buttons/);assert.match(rows[1].prompt,/How should we implement login/);
 for(const row of rows) assert.ok(row.args.includes('sandbox_mode="read-only"'));
 assert.ok(r.events.some(e=>e.type==='tool'&&e.detail==='file content'));
}));
test('separate chats do not leak context and modes resume separate account sessions',()=>fixture(async ({project,trace,env})=>{
 env.NO_FAIL='1';
 await run({project,chat:'chat-1',task:'My favorite color is blue',mode:'ask'},env);
 await run({project,chat:'chat-1',task:'Build the page',mode:'build'},env);
 await run({project,chat:'chat-1',task:'Explain that page',mode:'ask'},env);
 await run({project,chat:'chat-2',task:'New unrelated request',mode:'ask'},env);
 const rows=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(!rows[1].args.includes('resume'));assert.ok(rows[1].args.includes('sandbox_mode="workspace-write"'));
 assert.ok(rows[2].args.includes('resume'));assert.match(rows[2].prompt,/Build the page/);assert.doesNotMatch(rows[2].prompt,/My favorite color is blue/);
 assert.doesNotMatch(rows[3].prompt,/My favorite color is blue/);
}));
test('unavailable UI request stays saved and retry does not duplicate user turn',()=>fixture(async ({project,trace,env})=>{
 const payload={project,chat:'chat-1',task:'Explain the project',mode:'ask'};
 let r=await run(payload,{...env,BLOCK_ALL:'1'});assert.equal(r.code,2);assert.ok(r.events.some(e=>e.type==='unavailable'));
 r=await run({...payload,retry:true},{...env,NO_FAIL:'1'});assert.equal(r.code,0);
 const rows=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows[0].prompt.match(/USER: Explain the project/g).length,1);
}));
test('shared prompt bounds context and distinguishes Ask from Build',()=>{
 const messages=Array.from({length:20},(_,i)=>({role:'user',text:String(i)+'x'.repeat(20000)}));
 assert.ok(sharedPrompt(messages,'ask',false).length<63000);
 assert.match(sharedPrompt(messages,'ask',false),/Do not modify/);
 assert.match(sharedPrompt(messages,'build',true),/partially completed/);
});
