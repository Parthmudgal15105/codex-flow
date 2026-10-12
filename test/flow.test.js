import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { evaluate, choose } from '../src/accounts.js';
import { quotaError } from '../src/worker.js';
const bucket = (usedPercent, secondary = null) => ({ rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: 1 }, secondary } });
test('weekly exhaustion blocks even when five-hour allowance remains', () => {
  assert.equal(evaluate(bucket(20, { usedPercent: 100 })).state, 'blocked');
});
test('missing usage is never considered ready; expired snapshot is not assumed reset', () => {
  assert.equal(evaluate({}).state, 'unknown');
  assert.equal(evaluate(bucket(100)).state, 'blocked');
});
test('keep current usable account, exclude exhausted workers', () => {
  const accounts = ['a', 'b'].map(name => ({ name, ...evaluate(bucket(name === 'a' ? 40 : 35)) }));
  assert.equal(choose(accounts, 'a').name, 'a');
  assert.equal(choose(accounts, 'a', new Set(['a'])).name, 'b');
});
test('do not switch on generic network or 429 errors or agent prose', () => {
  assert.equal(quotaError({ type: 'error', message: '429 rate limit retry later' }), false);
  assert.equal(quotaError({ type: 'item.completed', item: { text: 'usage limit' } }), false);
  assert.equal(quotaError({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }), true);
});
const fake = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const name = process.env.CODEX_HOME.split('/').pop();
if (process.argv.includes('app-server')) {
 const lines = createInterface({input:process.stdin});
 lines.on('line', line => {
  const m=JSON.parse(line); if (!m.id) return;
  let result={};
  if(m.method==='account/read') result={account:{type:'chatgpt', email:name+'@test.local'}};
  if(m.method==='account/rateLimits/read') result={rateLimits:{primary:{usedPercent:process.env.FAKE_BLOCKED ? 100 : 10,windowDurationMins:300,resetsAt:1999999999}}};
  console.log(JSON.stringify({id:m.id,result}));
 });
} else {
 let prompt=''; process.stdin.on('data',d=>prompt+=d); process.stdin.on('end',()=>{
  appendFileSync(process.env.FAKE_TRACE, JSON.stringify({name,prompt,args:process.argv})+'\\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:'session-'+name}));
  if(name==='a' && !existsSync(join(process.cwd(),'partial.txt'))) {
   writeFileSync(join(process.cwd(),'partial.txt'),'already done');
   console.log(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit'}}));
   process.exitCode=1;
  } else {
   writeFileSync(join(process.cwd(),'result.txt'),'completed by '+name);
   console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));
   console.log(JSON.stringify({type:'turn.completed'}));
  }
 });
}
`;
function run(args, env) {
 return new Promise((resolveResult,reject)=>{
  const c=spawn(process.execPath,[resolve('src/cli.js'),...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let out=''; c.stdout.on('data',d=>out+=d); c.stderr.on('data',d=>out+=d);
  c.on('error',reject); c.on('close',code=>resolveResult({code,out}));
 });
}
test('end-to-end: partial work survives quota handoff, B resumes next task', async () => {
 const temp=await mkdtemp(join(tmpdir(),'codex-flow-test-'));
 try {
  const exe=join(temp,'fake.mjs'), project=join(temp,'project'), trace=join(temp,'trace');
  await mkdir(project); await writeFile(exe,fake,{mode:0o700});
  const env={CODEX_FLOW_HOME:join(temp,'home'),CODEX_FLOW_CODEX:exe,FAKE_TRACE:trace};
  let r=await run(['start',project,'Build the feature'],env);
  assert.equal(r.code,0,r.out); assert.match(r.out,/Checking the other account/);
  assert.equal(await readFile(join(project,'partial.txt'),'utf8'),'already done');
  assert.equal(await readFile(join(project,'result.txt'),'utf8'),'completed by b');
  const rows=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r=>r.name),['a','b']);
  assert.match(rows[1].prompt,/Some operations may already have completed/);
  r=await run(['start',project,'Next feature'],env); assert.equal(r.code,0,r.out);
  const last=JSON.parse((await readFile(trace,'utf8')).trim().split('\n').at(-1));
  assert.ok(last.args.includes('resume')); assert.ok(last.args.includes('session-b'));
  r=await run(['start',project,'Unavailable task'],{...env,FAKE_BLOCKED:'1'});
  assert.equal(r.code,2); assert.match(r.out,/No verified available account/);
  r=await run(['continue',project],env); assert.equal(r.code,0,r.out);
  assert.match((await readFile(trace,'utf8')),/Unavailable task/);
 } finally { await rm(temp,{recursive:true,force:true}); }
});
test('preserve existing project notes and prevent concurrent workers', async () => {
 const { setupProject, lockProject } = await import('../src/project.js');
 const temp=await mkdtemp(join(tmpdir(),'codex-flow-lock-'));
 let project;
 try {
  await writeFile(join(temp,'implementation.md'),'User decisions must survive');
  project=await setupProject(temp);
  assert.equal(await readFile(project.notes,'utf8'),'User decisions must survive');
  const release=await lockProject(project);
  try { await assert.rejects(lockProject(project),/already using this project/); }
  finally { await release(); }
  const releaseAgain=await lockProject(project); await releaseAgain();
 } finally {
  await rm(temp,{recursive:true,force:true});
  if(project) await rm(project.dir,{recursive:true,force:true});
 }
});
