// Runs the authorized automatic activation once, without changing saved auth or
// the app's selected account. Subsequent checks reuse the persistent ledger.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createHash} = require('node:crypto');
const base = path.resolve(__dirname, '../vendor/codex-plus-plus/hub');
const root = path.join(os.homedir(), 'Library/Application Support/CodexPP');
process.env.USER_DATA_DIR = root;
process.env.CODEX_HOME = path.join(root, 'codex-home');
process.env.CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const store = require(base + '/store.cjs'), probe = require(base + '/probe.cjs');
const routing = require(base + '/routing.cjs');
const protectedFiles = [path.join(root,'accounts.json'), path.join(process.env.CODEX_HOME,'auth.json'), path.join(os.homedir(),'.codex/auth.json')];
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const backup = path.join(root,'backups','window-activation-'+stamp);
fs.mkdirSync(backup,{recursive:true,mode:0o700});
const originals = protectedFiles.filter(p=>fs.existsSync(p)).map((p,i)=>{
  const bytes=fs.readFileSync(p); fs.writeFileSync(path.join(backup,i+'.json'),bytes,{mode:0o600});
  return {path:p,bytes};
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
(async()=>{
  const selectedBefore = store.activeAccountId();
  const initial = store.accounts();
  const credentials = initial.map(a=>({id:a.id,accountId:a.accountId,planType:a.planType,accessToken:a.accessToken}));
  const before = await probe.readUsage(credentials);
  const list = initial.map(a=>({...a,...before.get(a.id),usageError:before.has(a.id)?null:'unavailable'}));
  const activation = require('../src/window-activation.cjs')({
    file:path.join(root,'flow-window-activation.json'), accounts:()=>list,
    enabled:()=>true, allowed:a=>routing.isEligible(a,routing.read().learnedIneligible),
    busy:id=>id===store.activeAccountId(),
    activate: a => require('../src/activation-probe.cjs')(a,{
      binary:process.env.CODEX_BIN,normalize:require(base+'/rate-limits.cjs').normalizeAllRateLimits}),
    refresh:async()=>{}
  });
  const attempts = await activation.ensure();
  const after = await probe.readUsage(credentials);
  const report = {checkedAt:new Date().toISOString(),attempts,ledger:activation.read(),accounts:list.map(a=>({label:a.label,
    before:before.get(a.id)?.usageWindows?.fiveHour,after:after.get(a.id)?.usageWindows?.fiveHour})),
    selectedAccountUnchanged:store.activeAccountId()===selectedBefore};
  for(const saved of originals) if(hash(fs.readFileSync(saved.path))!==hash(saved.bytes)) throw Error('Saved account state changed during activation validation');
  report.credentialsUnchanged=true;
  fs.writeFileSync(path.resolve(__dirname,'../docs/window-activation-validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(attempts.some(a=>a.status==='failed')) throw Error('Activation request failed; automatic retry is suppressed');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
