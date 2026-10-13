#!/usr/bin/env python3
import os,subprocess,time,tempfile,json,signal
from pathlib import Path
app=Path('/Users/parthmudgal/Applications/Codex++.app')
exe=app/'Contents/MacOS/Codex++'
reports=[]
for attempt in range(1,6):
 fd,name=tempfile.mkstemp(prefix='codex-flow-startup-',suffix='.log');os.chmod(name,0o600)
 with os.fdopen(fd,'w') as out:
  process=subprocess.Popen([str(exe)],stdout=out,stderr=subprocess.STDOUT)
  time.sleep(10)
  status=process.poll();content=Path(name).read_text(errors='replace')
  ready='window ready-to-show appearance=primary' in content
  connected='Codex CLI initialized' in content
  fatal='FATAL:' in content
  result={'attempt':attempt,'alive':status is None,'exitCode':status,'primaryWindowReady':ready,'engineConnected':connected,'fatal':fatal,'log':name}
  reports.append(result);print(json.dumps(result),flush=True)
  if status is None:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:raise RuntimeError('Test instance did not exit normally; stopping tests')
  if not ready or not connected or fatal or status is not None:break
  time.sleep(2)
Path(__file__).resolve().parents[1].joinpath('docs/startup-test-results.json').write_text(json.dumps(reports,indent=2)+'\n')
if len(reports)!=5 or any(not r['primaryWindowReady'] or not r['engineConnected'] or r['fatal'] or not r['alive'] for r in reports):raise SystemExit(1)
