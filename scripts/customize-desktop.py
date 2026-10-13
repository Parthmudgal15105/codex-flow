from pathlib import Path
base=Path(__file__).resolve().parents[1]
repo=base/'vendor/codex-plus-plus'
optimizer=(base/'src/optimizer.js').read_text().replace('export function ','function ').replace('export async function ','async function ')
optimizer=optimizer.replace("import { spawnSync, spawn } from 'node:child_process';", "const {spawnSync,spawn}=require('node:child_process');")
optimizer=optimizer.replace("import { fileURLToPath } from 'node:url';", "const path=require('node:path');")
optimizer=optimizer.replace("const solverPath=fileURLToPath(new URL('./exact-worker.cjs',import.meta.url));", "const solverPath=path.join(__dirname,'exact-worker.cjs');")
optimizer=optimizer.replace("process.execPath,[solverPath]", "process.resourcesPath?path.join(process.resourcesPath,'cua_node/bin/node'):process.execPath,[solverPath]")
(repo/'hub/flow-optimizer.cjs').write_text(optimizer+'\nmodule.exports={recommend,recommendAsync,learn,key};\n')
for name in ['exact-model.cjs','exact-worker.cjs','desktop-learning.cjs','session-clock.cjs','switch-learning.cjs','window-activation.cjs','activation-probe.cjs','desktop-activation.cjs']:
 (repo/'hub'/name).write_text((base/'src'/name).read_text())
(repo/'hub/flow-routing.cjs').write_text((base/'src/desktop-routing.cjs').read_text())
p=repo/'hub/main.cjs';s=p.read_text();s=s.replace('const list = store.accounts();\n    const learned = routing.read().learnedIneligible;\n    return routing.chooseAccount(list, excluded, learned);','await usage.refreshAll();\n    const list = store.accounts();\n    const learned = routing.read().learnedIneligible;\n    return require("./flow-routing.cjs").choose(list, excluded, learned);');p.write_text(s)
p=repo/'patch/patches/090-auto-routing-core.mjs';s=p.read_text();s=s.replace('  `      if (_api.routingView?.()?.autoRoute) return;`,\n','');s=s.replace('`      if (_api.routingView?.()?.threadOwner?.[_threadId]) return;`,','`      if (_api.routingView?.()?.autoRoute) return;`,\n  `      if (_api.routingView?.()?.threadOwner?.[_threadId]) return;`,');p.write_text(s)
p=repo/'patch/patches/093-thread-account.mjs';s=p.read_text();s=s.replace('const _target=globalThis.__cxpThreadTarget(_threadId),_api=globalThis.__codexpp,_account=', 'const _api=globalThis.__codexpp;let _target=globalThis.__cxpThreadTarget(_threadId);if(_api?.routingView?.()?.autoRoute&&!globalThis.__cxpThreadOwner(_threadId)){const _choice=await _api.routingSuggest?.();if(!_choice?.accountId)throw Error(`No account has verified available Codex quota. Refresh usage or sign in again.`);_target=_choice.accountId;}const _account=');s=s.replace('if(_account.usedPercent>=100||_api?.routingView?.()?.learnedIneligible?.[_target])','if(_account.usedPercent>=100||_account.usageWindows?.fiveHour?.usedPercent>=100||_api?.routingView?.()?.learnedIneligible?.[_target])');p.write_text(s)

# Central scheduler preparation starts unused windows before optimization.
p=repo/'hub/main.cjs';s=p.read_text()
start=s.index('ipcMain.handle("codexpp:routing-suggest"')
a=s.index('  try {',start)+len('  try {')
b=s.index('  } catch (err)',a)
s=s[:a]+'\n    return await require("./flow-routing.cjs").schedule(excluded);\n'+s[b:]
start=s.index('ipcMain.handle("codexpp:flow-begin"')
end=s.index('\n',start)
s=s[:start]+'ipcMain.handle("codexpp:flow-begin", async (_e, threadId, accountId) => {const flow=require("./flow-routing.cjs");await flow.prepare();flow.startSession();return flow.learning.begin(threadId, accountId)});'+s[end:]
p.write_text(s)
