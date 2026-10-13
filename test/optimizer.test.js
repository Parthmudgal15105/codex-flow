import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend, learn, key } from '../src/optimizer.js';
const now = 1800000000000;
function account(name, left, reset = 290, period = 300) {
  return { name, email: `${name}@test.local`, plan: 'plus', state: 'ready', windows: [{ usedPercent: 100-left, windowDurationMins: period, resetsAt: now/1000+reset*60, bucket: 'codex' }] };
}
test('use allowance expiring soon when it improves the modeled work schedule', () => {
  const result = recommend([account('a',35,30),account('b',90)],null,new Set(),{},now);
  assert.equal(result.account.name,'a');
  assert.ok(result.scores[0].estimatedWeightedWorkMinutes > result.scores[1].estimatedWeightedWorkMinutes);
});
test('avoid starting a likely interrupted task on nearly exhausted preferred account', () => {
  assert.equal(recommend([account('a',5),account('b',90)],'a',new Set(),{},now).account.name,'b');
});
test('weekly bottleneck outweighs plentiful short-window usage', () => {
  const a=account('a',90,20); a.windows.push(account('a',1,9000,10080).windows[0]);
  assert.equal(recommend([a,account('b',60)],'a',new Set(),{},now).account.name,'b');
});
test('different plans use separate learned work capacity, not raw percentages', () => {
  const a=account('a',80), b={...account('b',30),plan:'go'};
  const history={ [key(a,a.windows[0])]:{rate:10,samples:4}, [key(b,b.windows[0])]:{rate:0.2,samples:4} };
  assert.equal(recommend([a,b],null,new Set(),history,now).account.name,'b');
});
test('learn usage only across matching account, plan and reset windows', () => {
  const before=account('a',80),after=account('a',70);
  const result=learn({},before,after,10);
  assert.equal(result[key(before,before.windows[0])].rate,1);
  const reset=account('a',100,300);
  assert.deepEqual(learn({},before,reset,10),{});
  assert.deepEqual(learn({},before,{...after,plan:'go'},10),{});
  assert.deepEqual(learn({},before,after,0.1),{});
});
test('blocked accounts never selected; invalid duration and usage fail closed', () => {
  const blocked={...account('a',100,1),state:'blocked'};
  assert.equal(recommend([blocked,account('b',10)],null,new Set(),{},now).account.name,'b');
  const invalid=account('a',80); invalid.windows[0].windowDurationMins=0;
  assert.equal(recommend([invalid],null,new Set(),{},now).account,null);
  assert.equal(recommend([account('a',90)],null,new Set(['a']),{},now).account,null);
});
test('deterministic decisions and no input mutation', () => {
  const input=[account('a',80),account('b',80)], copy=structuredClone(input);
  assert.equal(recommend(input,null,new Set(),{},now).account.name,'a');
  assert.deepEqual(input,copy);
});
test('screenshot regression: use A before its earlier reset without losing modeled work',()=>{
 const a=account('a',98,126.807),b=account('b',14,186.457);
 a.windows.push({...account('a',64,8316,10080).windows[0],bucket:'weekly'});
 b.windows.push({...account('b',67,8806,10080).windows[0],bucket:'weekly'});
 const history={
  [key(b,b.windows[0])]:{rate:0.7243189327160526,samples:10},
  [key(b,b.windows[1])]:{rate:0.12972397980197634,samples:3}
 };
 const r=recommend([a,b],'b',new Set(),history,now,{blocks:[[0,480,1]]});
 assert.equal(r.account.name,'a');
 assert.equal(r.certificate.model,'finite-horizon-v3');
 assert.ok(r.certificate.selectionGap<=1e-5);
 assert.ok(Math.abs(r.scores[0].estimatedProductiveMinutes-r.scores[1].estimatedProductiveMinutes)<1e-5);
 assert.ok(r.schedule.filter(s=>s.start<15&&s.account==='a').reduce((n,s)=>n+s.workMinutes,0)>=13-1e-5);
});
test('earlier reset breaks equal-capacity ties ahead of active-account preference',()=>{
 const r=recommend([account('a',80,30),account('b',80,60)],'b',new Set(),{},now,{blocks:[[0,90,1]],switchMinutes:0});
 assert.equal(r.account.name,'a');
 assert.ok(r.certificate.selectionGap<=1e-5);
});
test('earlier reset never overrides productive time lost to switching',()=>{
 const r=recommend([account('a',80,30),account('b',80,60)],'b',new Set(),{},now,{blocks:[[0,90,1]]});
 assert.equal(r.account.name,'b');
 assert.ok(r.scores[0].estimatedWeightedWorkMinutes>r.scores[1].estimatedWeightedWorkMinutes+1e-5);
});
test('reset priority does not override a real continuity or weekly bottleneck',()=>{
 const a=account('a',98,126);
 a.windows.push({...account('a',2,9000,10080).windows[0],bucket:'weekly'});
 const r=recommend([a,account('b',80,186)],'b',new Set(),{},now,{blocks:[[0,480,1]]});
 assert.equal(r.account.name,'b');
});
test('past, unknown and outside-horizon resets do not cause unnecessary switches',()=>{
 for(const reset of [-1,null,9000]){
  const a=account('a',80,reset);
  if(reset===null)a.windows[0].resetsAt=null;
  assert.equal(recommend([a,account('b',80,9000)],'b',new Set(),{},now,{blocks:[[0,20,1]]}).account.name,'b');
 }
});
