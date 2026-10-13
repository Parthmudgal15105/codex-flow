#!/usr/bin/env python3
"""Replace the app bundle on disk; never terminate the running app."""
from pathlib import Path
import datetime, hashlib, json, subprocess
base=Path(__file__).resolve().parents[1]
staged=base/'.testing/exact-scheduler/Codex++.app'
target=Path.home()/'Applications/Codex++.app'
if not staged.is_dir():raise SystemExit('Verified staged app is missing')
subprocess.run(['codesign','--verify','--strict',str(staged)],check=True)
# macOS keys privacy grants to the designated requirement, not the app name.
# Check both directions so a replacement cannot weaken the signing identity.
if target.is_dir():
 def requirement(app):
  result=subprocess.run(['codesign','-d','-r-',str(app)],capture_output=True,text=True,check=True)
  for line in (result.stdout+'\n'+result.stderr).splitlines():
   if line.startswith('designated => '):return line.removeprefix('designated => ')
  raise SystemExit(f'Cannot read signing identity: {app}')
 old_req,new_req=requirement(target),requirement(staged)
 for app,req in ((staged,old_req),(target,new_req)):
  result=subprocess.run(['codesign','--verify','--strict','-R','='+req,str(app)],capture_output=True,text=True)
  if result.returncode:
   raise SystemExit('Update changes the macOS signing identity and would require new permissions. Configure a persistent certificate and perform an explicit one-time identity migration before installing updates.')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path.home()/'Library/Application Support/CodexPP/backups'/('Codex++-before-exact-'+stamp+'.app-backup')
backup.parent.mkdir(parents=True,exist_ok=True)
(backup.parent/'.metadata_never_index').touch()
target.rename(backup)
try:staged.rename(target)
except BaseException:
 backup.rename(target)
 raise
subprocess.run(['codesign','--verify','--strict',str(target)],check=True)
report={'installedApp':str(target),'backup':str(backup),'activation':'next application restart; running process not terminated','optimizerSha256':hashlib.sha256((target/'Contents/Resources/hub/flow-optimizer.cjs').read_bytes()).hexdigest()}
(base/'docs/exact-installation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
