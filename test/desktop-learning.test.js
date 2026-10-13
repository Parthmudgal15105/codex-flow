import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {learn,key} from '../src/optimizer.js';
const require=createRequire(import.meta.url),createLearning=require('../src/desktop-learning.cjs');
test('desktop learning attributes one turn, excludes refresh delay, persists and rejects overlap',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'flow-learning-'));let now=0,used=10;
 const snapshot=()=>({name:'a',email:'identity',plan:'plus',state:'ready',windows:[{bucket:'codex',usedPercent:used,resetsAt:999,windowDurationMins:300}]});
 const before=snapshot(),learning=createLearning({file:join(dir,'learning.json'),snapshot,clock:()=>now,refresh:async()=>{used=20;now+=600000},learn});
 try{
  assert.equal(await learning.begin('one','a'),true);
  now=600000;await learning.end('one');assert.equal(learning.read()[key(before,before.windows[0])].rate,1);
  await learning.end('one');assert.equal(learning.read()[key(before,before.windows[0])].samples,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('malformed durations and reset crossings cannot poison learned rates',()=>{
 const before={name:'a',email:'a',plan:'plus',windows:[{usedPercent:10,resetsAt:999,bucket:'codex',windowDurationMins:300}]};
 const after=structuredClone(before);after.windows[0].usedPercent=20;
 for(const duration of [0,-1,NaN,Infinity])assert.deepEqual(learn({},before,after,duration),{});
 after.windows[0].resetsAt++;assert.deepEqual(learn({},before,after,10),{});
});

test('overlapping work invalidates both measurements instead of learning the wrong cost',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'flow-overlap-'));let learned=0;
 const learning=createLearning({file:join(dir,'learning.json'),snapshot:()=>({name:'a',state:'ready'}),refresh:async()=>{},learn:()=>{learned++;return {}}});
 try{await learning.begin('one','a');assert.equal(await learning.begin('two','a'),false);await learning.end('one');await learning.end('two');assert.equal(learned,0)}finally{rmSync(dir,{recursive:true,force:true})}
});

test('switch overhead is measured only after successful acknowledgement and bounded',()=>{
 const dir=mkdtempSync(join(tmpdir(),'flow-switch-'));let now=0;
 const costs=require('../src/switch-learning.cjs')(join(dir,'cost.json'),()=>now);
 try{assert.equal(costs.minutes(),2);costs.begin('b','a');now=3000;costs.end('b');assert.equal(costs.minutes(),0.05);costs.begin('b','b');now=9000;costs.end('b');assert.equal(costs.minutes(),0.05);costs.begin('a','b');now=200000;costs.end('a');assert.equal(costs.minutes(),0.05)}finally{rmSync(dir,{recursive:true,force:true})}
});
