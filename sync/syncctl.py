#!/usr/bin/env python3
"""Small control tool for the per-user history sync service."""
import json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
LABEL='com.local.codex-flow.history-sync'
DOMAIN='gui/'+str(os.getuid())
PLIST=Path.home()/'Library/LaunchAgents'/ (LABEL+'.plist')
command=sys.argv[1] if len(sys.argv)>1 else 'status'
if command=='status':
 result=subprocess.run(['/bin/launchctl','print',DOMAIN+'/'+LABEL],capture_output=True,text=True)
 print('Automatic history sync: '+('enabled' if result.returncode==0 else 'paused'))
 path=ROOT/'status.json'
 if path.exists():
  report=json.loads(path.read_text());print('Last checked: '+report['checkedAt'])
  for direction,item in report['directions'].items():
   print(direction+': '+item['status'].replace('_',' '))
   if item.get('error'):print('  '+item['error'])
   if item.get('pendingChats'):print('  '+str(item['pendingChats'])+' conversations waiting for a reply to finish')
  if report.get('lastSuccessfulSync'):print('Last history update: '+report['lastSuccessfulSync']['at'])
 print('Backups: '+str(ROOT/'backups'))
elif command=='pause':
 subprocess.run(['/bin/launchctl','bootout',DOMAIN+'/'+LABEL],check=False)
 print('Automatic sync paused. Histories and backups retained.')
elif command=='resume':
 result=subprocess.run(['/bin/launchctl','print',DOMAIN+'/'+LABEL],capture_output=True)
 if result.returncode:subprocess.run(['/bin/launchctl','bootstrap',DOMAIN,str(PLIST)],check=True)
 print('Automatic sync enabled.')
else:
 raise SystemExit('Usage: syncctl [status|pause|resume]')
