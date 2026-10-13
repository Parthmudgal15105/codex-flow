import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import patch, { recovery } from '../vendor/codex-plus-plus/patch/patches/071-auth-lifecycle.mjs';

const fixture = `globalThis.__cxpRestore=async(_client)=>{const _view=globalThis.view;const _want=_view.defaultAccountId;if(!_want)return;await globalThis.activate(_want)};
class Login {async browser(){return this.requestClient.sendRequest(\`account/login/start\`,{type:\`chatgpt\`})}async device(){return this.requestClient.sendRequest(\`account/login/start\`,{type:\`chatgptDeviceCode\`})}async key(){return this.requestClient.sendRequest(\`account/login/start\`,{type:\`apiKey\`})}}`;

test('startup retains a loaded native account without re-injecting tokens',async()=>{
 const calls=[];const context=vm.createContext({view:{defaultAccountId:'native',accounts:[{id:'native',native:true,email:'a@example.com'}]},activate:async()=>calls.push('activate')});
 vm.runInContext(patch.apply(fixture),context);
 await context.__cxpRestore({sendRequest:async(method)=>{calls.push(method);return {account:{type:'chatgpt',email:'a@example.com'}}}});
 assert.deepEqual(calls,['account/read']);assert.equal(context.__cxpConfirmedAccountId,'native');
});
test('a different saved account still restores',async()=>{
 const calls=[];const context=vm.createContext({view:{defaultAccountId:'other',accounts:[{id:'other',native:false}]},activate:async(id)=>calls.push(id)});
 vm.runInContext(patch.apply(fixture),context);await context.__cxpRestore({});assert.deepEqual(calls,['other']);
});
test('managed login clears external auth on the same client and retries once',async()=>{
 const context=vm.createContext({});vm.runInContext(recovery,context);const calls=[];
 const client={sendRequest:async(method,params)=>{calls.push([method,params]);if(calls.length===1)throw Error('External auth is active. Use account/logout to clear it.');return {type:'chatgpt'}}};
 const params={type:'chatgpt'};await context.__cxpManagedLogin(client,params);
 assert.deepEqual(calls.map(c=>c[0]),['account/login/start','account/logout','account/login/start']);assert.equal(calls[2][1],params);
});
test('unrelated login failures do not sign out the user',async()=>{
 const context=vm.createContext({});vm.runInContext(recovery,context);const calls=[];
 await assert.rejects(context.__cxpManagedLogin({sendRequest:async(method)=>{calls.push(method);throw Error('Network unavailable')}},{type:'chatgpt'}),/Network unavailable/);
 assert.deepEqual(calls,['account/login/start']);
});
