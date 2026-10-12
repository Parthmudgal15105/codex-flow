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
