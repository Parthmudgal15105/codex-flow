const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = path.resolve(__dirname, '../vendor/codex-plus-plus');
const {decodeClaims,authClaims} = require(base + '/hub/claims.cjs');
const probe = require(base + '/hub/probe.cjs');
process.env.CODEX_BIN='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
(async()=> {
 const entries=[];
 for(const name of ['a','b']) {
  const auth=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.codex-flow/accounts',name,'auth.json'),'utf8'));
  const t=auth.tokens, c=authClaims(t.access_token);
  entries.push({id:name,accessToken:t.access_token,accountId:c.chatgpt_account_id||t.account_id,planType:c.chatgpt_plan_type});
  console.log(JSON.stringify({account:name,tokenCurrent:(decodeClaims(t.access_token).exp||0)*1000>Date.now(),plan:c.chatgpt_plan_type}));
 }
 const usage=await probe.readUsage(entries);
 for(const [name,value] of usage) console.log(JSON.stringify({account:name,plan:value.planType,usage:value.usageWindows,usedPercent:value.usedPercent}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
