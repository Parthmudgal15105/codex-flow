const os=require('node:os'),path=require('node:path');
const data=path.join(os.homedir(),'Library/Application Support/CodexPP');
process.env.USER_DATA_DIR=data;process.env.CODEX_HOME=path.join(data,'codex-home');process.env.CODEX_BIN='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const hub=process.env.FLOW_ROUTER_HUB||path.resolve(__dirname,'../vendor/codex-plus-plus/hub');
if(process.env.FLOW_ROUTER_RESOURCES)process.resourcesPath=process.env.FLOW_ROUTER_RESOURCES;
(async()=>{const view=await require(hub+'/usage.cjs').refreshAll({force:true});const store=require(hub+'/store.cjs');const selection=await require(hub+'/flow-routing.cjs').choose(store.accounts(),null,{});console.log(JSON.stringify({accounts:view.accounts.map(a=>({label:a.label,plan:a.planType,usage:a.usageWindows,error:a.usageError})),selected:selection?.account?.label,reason:selection?.reason,certificate:selection?.certificate,scores:selection?.scores},null,2));if(!selection)throw Error('No verified account is available');})().catch(e=>{console.error(e.message);process.exitCode=1});
