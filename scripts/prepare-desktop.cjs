const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const data=path.join(os.homedir(),'Library/Application Support/CodexPP');
process.env.USER_DATA_DIR=data;process.env.CODEX_HOME=path.join(data,'codex-home');
const base=path.resolve(__dirname,'../vendor/codex-plus-plus/hub');
const store=require(base+'/store.cjs'),native=require(base+'/native.cjs');
const {decodeClaims,authClaims}=require(base+'/claims.cjs');
const backup=path.join(data,'backups','before-flow-'+Date.now());fs.mkdirSync(backup,{recursive:true,mode:0o700});
for(const [label,file] of [['native',native.authPath()],['accounts',store.storePath()],...['a','b'].map(n=>[n,path.join(os.homedir(),'.codex-flow/accounts',n,'auth.json')])]) if(fs.existsSync(file)) {fs.copyFileSync(file,path.join(backup,label+'.json'));fs.chmodSync(path.join(backup,label+'.json'),0o600);}
for(const name of ['a','b']) {
 const auth=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.codex-flow/accounts',name,'auth.json'),'utf8'));
 const t=auth.tokens,c=authClaims(t.access_token),identity=decodeClaims(t.id_token);
 store.upsertAccount({id:'flow-'+name,label:'Account '+name.toUpperCase(),email:identity.email,accountId:c.chatgpt_account_id||t.account_id,planType:c.chatgpt_plan_type,accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:(decodeClaims(t.access_token).exp||0)*1000});
}
const b=store.read().accounts.find(a=>a.id==='flow-b');
const target=store.accounts().find(a=>a.accountId===b.accountId);
store.setPreferred(target.id);store.setActive(target.id);
const routing=require(base+'/routing.cjs');
routing.write({...routing.read(),autoRoute:true});
fs.chmodSync(data,0o700);
console.log(JSON.stringify({accounts:store.accounts().map(a=>({label:a.label,plan:a.planType})),automaticRouting:true,defaultAccount:'B',backupCreated:true}));
