#!/usr/bin/env python3
"""Install an independent local watcher without changing either app bundle."""
import json,os,plistlib,shutil,subprocess,sys
from pathlib import Path
base=Path(__file__).resolve().parents[1]
root=Path.home()/'Library/Application Support/CodexFlowSync'
root.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(root,0o700)
label='com.local.codex-flow.history-sync';domain='gui/'+str(os.getuid())
plist=Path.home()/'Library/LaunchAgents'/(label+'.plist')
existing=subprocess.run(['/bin/launchctl','print',domain+'/'+label],capture_output=True)
if existing.returncode==0:subprocess.run(['/bin/launchctl','bootout',domain+'/'+label],check=True)
for name in ('history_sync.py','history_projection.py','syncctl.py'):
 shutil.copyfile(base/'sync'/name,root/name);os.chmod(root/name,0o700)
aliases={}
recovery=Path.home()/'Library/Application Support/CodexPP/backups/history-recovery-20261011T205602Z/recovery-report.json'
if recovery.exists():aliases={r['sourceId']:r['targetId'] for r in json.loads(recovery.read_text())['imported'] if r['copiedVersion']}
config={'engine':'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','stateDir':str(root),'homes':{'official':str(Path.home()/'.codex'),'codexpp':str(Path.home()/'Library/Application Support/CodexPP/codex-home')},'apps':{'official':'/Applications/ChatGPT.app','codexpp':str(Path.home()/'Applications/Codex++.app')},'conflictAliases':aliases}
(root/'config.json').write_text(json.dumps(config,indent=2)+'\n');os.chmod(root/'config.json',0o600)
for name in ('watcher.log','watcher-error.log'):
 (root/name).touch(exist_ok=True);os.chmod(root/name,0o600)
job={'Label':label,'ProgramArguments':[sys.executable,str(root/'history_sync.py'),'--config',str(root/'config.json'),'watch'],'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'ProcessType':'Background','StandardOutPath':str(root/'watcher.log'),'StandardErrorPath':str(root/'watcher-error.log')}
plist.parent.mkdir(parents=True,exist_ok=True)
plist.write_bytes(plistlib.dumps(job));os.chmod(plist,0o600)
# A double-clickable status shortcut; it only reads service status.
shortcut=Path.home()/'Applications/Codex Flow Sync Status.command'
import shlex
shortcut.write_text('#!/bin/zsh\n'+shlex.quote(sys.executable)+' '+shlex.quote(str(root/'syncctl.py'))+' status\n')
os.chmod(shortcut,0o700)
subprocess.run(['/bin/launchctl','bootstrap',domain,str(plist)],check=True)
print(json.dumps({'installed':str(root),'launchAgent':str(plist),'statusShortcut':str(shortcut),'trigger':'filesystem events with debounce; 20-second recovery heartbeat','receivingAppMustBeClosed':True},indent=2))
