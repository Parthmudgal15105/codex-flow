// Patch 093: the open thread id is published; a pinned chat's turns run on its account through a
// transient engine switch; the engine returns to the default account after the turn or when the chat
// changes, never while a turn is running; pinning records the owner without touching the default.
import assert from "node:assert/strict";
import vm from "node:vm";
import patch, {publicationPatch} from "../patch/patches/093-thread-account.mjs";

const fixture =
  "function Layout(e){let t=[],{activeThreadId:n}=e;return n}" +
  "class Manager{constructor(){this.callbacks=[];const c=new Client;if(c.hostId==='bad')throw Error('does not match AppServerManager hostId');this.requestClient=c;let r=this.settings.restricted;}get settings(){return{restricted:false}}addNotificationCallback(methods,notify){this.callbacks.push({methods,notify});return()=>{}}}" +
  "class Client{async sendRequest(method,params){calls.push({method,threadId:params?.threadId,model:params?.model,input:params?.input});if(params?.fail)throw Error('boom');return{ok:true}}}" +
  "globalThis.Layout=Layout;globalThis.Manager=Manager;globalThis.Client=Client;";
const patched = publicationPatch.apply(patch.apply(fixture));
assert.match(patched, /globalThis\.__cxpPublishThread\?\.\(n\);/);
assert.match(patched, /__cxpInstallThreadAccounts\?\.\(this.requestClient,this\)/);
assert.throws(() => patch.apply(fixture + fixture.replaceAll("Layout", "Layout2").replaceAll("class Manager", "class Manager2").replaceAll("class Client", "class Client2")), /expected 1, found 2/);

const calls = [], activations = [], learned = [], notified = [];
let view = { activeAccountId: "a", defaultAccountId: "a", accounts: [{ id: "a", usedPercent: 10 }, { id: "b", usedPercent: 20 }, { id: "c", usedPercent: 100 }, { id: "d", usedPercent: 5 }] };
const routing = { threadOwner: { "t-b": "b", "t-a": "a", "t-c": "c", "t-d": "d", "t-gone": "zzz" }, learnedIneligible: { d: "workspace" } };
const context = { calls, activations, learned, notified, __cxpClients: {}, __cxpConfirmedAccountId: 'a' };
context.globalThis = context;
context.__codexpp = {
  accountsSync: () => view,
  routingView: () => routing,
  learnThreadOwner: async (threadId, accountId) => { learned.push([threadId, accountId]); routing.threadOwner[threadId] = accountId; return routing; }
};
context.__cxpActivate = async (id, opts) => { activations.push([id, opts?.transient === true]); context.__cxpConfirmedAccountId=id; view = { ...view, activeAccountId: id, ...(opts?.transient ? {} : { defaultAccountId: id }) }; return view; };
vm.runInNewContext(patched, context);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const reset = () => { activations.length = 0; calls.length = 0; view = { ...view, activeAccountId: "a", defaultAccountId: "a" }; context.__cxpConfirmedAccountId='a'; context.__cxpRunningTurns.clear(); };

// Publishing: real ids, null for drafts; selecting a pinned chat does not switch the engine.
assert.equal(context.Layout({ activeThreadId: "t-b" }), "t-b"); await settle();
assert.equal(context.__cxpActiveThreadId, "t-b"); assert.deepEqual(activations, [], "selecting a chat never switches by itself");
context.Layout({ activeThreadId: "new-conversation" }); assert.equal(context.__cxpActiveThreadId, null);
context.Layout({ activeThreadId: "panel-new-conversation" }); assert.equal(context.__cxpActiveThreadId, null);
context.Layout({ activeThreadId: undefined }); assert.equal(context.__cxpActiveThreadId, null);

const manager = new context.Manager(); context.__cxpClients.local = manager; const client = manager.requestClient;
assert.equal(client.__cxpThreadAccountsInstalled, true); assert.equal(manager.__cxpThreadAccountsInstalled, true);
const run = (method, params) => client.sendRequest(method, params);
assert.deepEqual(JSON.parse(JSON.stringify(manager.callbacks.map(c => c.methods))), [["turn/completed", "turn/failed"]], "one callback registered for turn end");
const notify = (method, threadId) => { for (const c of manager.callbacks) if (c.methods.includes(method)) c.notify({ method, params: { threadId } }); notified.push(method); };

// A turn on a chat pinned to b: switch transiently, run, then come back to the default after completion.
await run("turn/start", { threadId: "t-b" }); await settle();
assert.deepEqual(activations, [["b", true]], "turn on a chat pinned to b switches the engine to b, transiently");
assert.equal(calls.at(-1).method, "turn/start"); assert.equal(view.defaultAccountId, "a", "the default account is untouched");
assert.equal(context.__cxpRunningTurns.has("t-b"), true);
notify("turn/completed", "t-b"); await settle();
assert.deepEqual(activations, [["b", true], ["a", true]], "completion restores the default account");
assert.equal(context.__cxpRunningTurns.size, 0); assert.deepEqual(notified.slice(-1), ["turn/completed"], "the original handler still runs");

// While b runs, a chat targeting a must not silently consume b's quota.
reset();
await run("turn/start", { threadId: "t-b" }); await settle();
await assert.rejects(run("turn/start", { threadId: "t-new" }), /Another account has a running chat/); await settle();
assert.equal(calls.length, 1, "the other account's turn never reaches the engine");
assert.deepEqual(activations, [["b", true]], "no switch while another turn is running");
context.Layout({ activeThreadId: "t-new" }); await settle();
assert.deepEqual(activations, [["b", true]], "changing chats does not restore the default mid-turn");
notify("turn/failed", "t-b"); await settle();
assert.deepEqual(activations, [["b", true], ["a", true]], "last turn done: back to the default");

// Selecting a chat while the engine is transiently elsewhere and idle restores the default.
reset(); view = { ...view, activeAccountId: "b" };
context.Layout({ activeThreadId: "t-a" }); await settle();
assert.deepEqual(activations, [["a", true]]);

// Unusable pins stop instead of silently billing the default; unpinned chats use the default.
reset();
for (const threadId of ["t-c", "t-d", "t-gone"]) { await assert.rejects(run("turn/start", { threadId }), /account.*(?:quota|unavailable)/); }
await run("turn/start", { threadId: "t-new" }); await settle(); notify("turn/completed", "t-new"); await settle();
assert.deepEqual(activations, [], "default already active: no switches");
await run("thread/resume", { threadId: "t-b" }); await run("thread/start", { model: "gpt-5" }); await run("turn/start", { threadId: "t-b", model: "cxp/openrouter/x" }); await settle();
assert.deepEqual(activations, [], "resume, start and external-provider turns never switch");
const foreign = new context.Client(); context.__cxpInstallThreadAccounts(foreign);
await foreign.sendRequest("turn/start", { threadId: "t-b" }); await settle();
assert.deepEqual(activations, [], "a non-local request client never switches");

// A failing turn/start request clears the running mark and restores the default.
reset();
await assert.rejects(run("turn/start", { threadId: "t-b", fail: true }), /boom/); await settle();
assert.deepEqual(activations, [["b", true], ["a", true]]); assert.equal(context.__cxpRunningTurns.size, 0);

// Fork model override is consumed once.
reset(); context.__cxpForkModel = "gpt-native";
await run("thread/fork", { threadId: "t-b", model: "cxp/opencode/x" }); await run("thread/fork", { threadId: "t-b", model: "cxp/opencode/x" });
assert.deepEqual(calls.filter(c => c.method === "thread/fork").map(f => f.model), ["gpt-native", "cxp/opencode/x"]);
assert.equal(context.__cxpForkModel, null);

// Pinning records the owner only.
reset(); learned.length = 0;
const pinned = await context.__cxpPinThread("t-new", "b"); await settle();
assert.equal(pinned.activeAccountId, "a"); assert.deepEqual(learned, [["t-new", "b"]]); assert.deepEqual(activations, [], "pinning does not switch");
assert.equal(context.__cxpThreadOwner("t-new"), "b");
assert.equal(await context.__cxpPinThread("t-new", "nope"), null); assert.equal(learned.length, 1, "unknown accounts are rejected");
assert.equal(await context.__cxpPinThread(null, "a"), null);
console.log("Thread account: publication, transient switch, default restoration, cross-account and unusable-pin rejection, pin-only passed");

// Flow: automatic account choice applies to every unpinned message.
reset(); routing.autoRoute=true;
let choice='b',suggestions=0;
context.__codexpp.routingSuggest=async()=>{suggestions++;return choice?{accountId:choice}:null};
await run('turn/start',{threadId:'flow-auto'});
assert.equal(view.activeAccountId,'b');assert.equal(suggestions,1);
notify('turn/completed','flow-auto');await settle();
assert.equal(view.activeAccountId,'b','automatic routing keeps the last account rather than switching twice between messages');
assert.deepEqual(activations,[['b',true]],'one necessary switch, no default restoration');
choice='a';await run('turn/start',{threadId:'flow-auto'});
assert.equal(view.activeAccountId,'a');assert.equal(suggestions,2);
notify('turn/completed','flow-auto');await settle();
choice=null;const before=calls.length;
await assert.rejects(run('turn/start',{threadId:'flow-auto'}),/verified available/);
assert.equal(calls.length,before,'unknown quota never submits');
choice='b';view.accounts.find(a=>a.id==='b').usageWindows={fiveHour:{usedPercent:100}};
await assert.rejects(run('turn/start',{threadId:'flow-auto'}),/quota/);
assert.equal(calls.length,before,'five-hour exhaustion blocks before submission');
delete view.accounts.find(a=>a.id==='b').usageWindows;
console.log('Flow automatic routing: every-message selection, fail-closed unknown quota and short-window exhaustion passed');

// Stop while automatic routing is waiting must cancel that submission, not the next one.
reset(); routing.autoRoute=true;
let releaseRoute, enteredRoute;
const routeEntered=new Promise(resolve=>{enteredRoute=resolve});
context.__codexpp.routingSuggest=()=>{enteredRoute();return new Promise(resolve=>{releaseRoute=resolve})};
const stopped=run('turn/start',{threadId:'flow-paused',input:[{type:'text',text:'OLD REQUEST'}]});
const stoppedResult=stopped.then(()=>null,error=>error);
await routeEntered;
await run('turn/interrupt',{threadId:'flow-paused'});
releaseRoute({accountId:'b'});
assert.match(String(await stoppedResult),/cancel|interrupt/i);
assert.equal(calls.filter(c=>c.method==='turn/start').length,0,'stopped prompt never reaches engine after routing');
assert.equal(context.__cxpRunningTurns.size,0);
context.__codexpp.routingSuggest=async()=>({accountId:'a'});
await run('turn/start',{threadId:'flow-paused',input:[{type:'text',text:'NEW REQUEST'}]});
assert.equal(calls.filter(c=>c.method==='turn/start').length,1,'next prompt is submitted exactly once');
assert.equal(calls.find(c=>c.method==='turn/start').input[0].text,'NEW REQUEST');
notify('turn/completed','flow-paused');await settle();
console.log('Stop during routing: cancelled old submission and accepted next message passed');

// The same cancellation must hold while credentials are switching, and must
// neither cancel another thread nor consume the following request's identity.
reset();routing.autoRoute=true;
const activate=context.__cxpActivate;
let releaseSwitch,enteredSwitch;
const switchEntered=new Promise(resolve=>{enteredSwitch=resolve});
context.__codexpp.routingSuggest=async()=>({accountId:'b'});
context.__cxpActivate=async(id,opts)=>{enteredSwitch();await new Promise(resolve=>{releaseSwitch=resolve});return activate(id,opts)};
const switching=run('turn/start',{threadId:'flow-switch-stop'});
const switchingResult=switching.then(()=>null,error=>error);
await switchEntered;
await run('turn/interrupt',{threadId:'unrelated-thread'});
await run('turn/interrupt',{threadId:'flow-switch-stop'});
releaseSwitch();
assert.match(String(await switchingResult),/interrupt/i);
assert.equal(calls.filter(c=>c.method==='turn/start').length,0);
assert.equal(context.__cxpRunningTurns.size,0);
context.__cxpActivate=activate;
await run('turn/start',{threadId:'flow-switch-stop'});
assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
await assert.rejects(run('turn/start',{threadId:'flow-switch-stop'}),/already has a running message/);
assert.equal(context.__cxpRunningTurns.has('flow-switch-stop'),true,'rejected duplicate must not clear the real running turn');
notify('turn/completed','flow-switch-stop');await settle();
console.log('Stop during login: no stale send; next submission and running-turn ownership preserved');
