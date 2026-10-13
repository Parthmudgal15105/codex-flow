#!/usr/bin/env python3
"""Exercise real database/transcript snapshots in private disposable homes only."""
import importlib.util,json,os,shutil,sqlite3,time,tempfile,subprocess
from pathlib import Path
base=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('history_sync',base/'sync/history_sync.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
start=time.monotonic()
reports=[]
with tempfile.TemporaryDirectory(prefix='flow-sync-real-') as temp:
 root=Path(temp);homes={}
 originals={'official':Path.home()/'.codex','codexpp':Path.home()/'Library/Application Support/CodexPP/codex-home'}
 for side,original in originals.items():
  home=root/side;home.mkdir(mode=0o700);homes[side]=home
  source=m.snapshot(original)
  with sqlite3.connect(home/'state_5.sqlite') as target:source.backup(target)
  source.close()
  history=original/'thread_history_1.sqlite'
  if history.exists() and history.stat().st_size:
   with m.snapshot_index(history) as native_index:
    with sqlite3.connect(home/'thread_history_1.sqlite') as target_index:native_index.backup(target_index)
  # Paginated transcripts can refer to unindexed earlier rollout segments.
  for directory in ('sessions','archived_sessions'):
   if (original/directory).exists():
    shutil.copytree(original/directory,home/directory,dirs_exist_ok=True)
  with m.connect(home/'state_5.sqlite') as target:
   for row in m.records(target,'threads'):
    old=Path(row['rollout_path']);new=home/old.relative_to(original)
    new.parent.mkdir(parents=True,exist_ok=True);os.chmod(new,0o600)
    target.execute('update threads set rollout_path=? where id=?',(str(new),row['id']))
 aliases={}
 recovery=Path.home()/'Library/Application Support/CodexPP/backups/history-recovery-20261011T205602Z/recovery-report.json'
 if recovery.exists():
  aliases={r['sourceId']:r['targetId'] for r in json.loads(recovery.read_text())['imported'] if r['copiedVersion']}
 sync=m.Sync(homes,root/'sync',lambda _:False,aliases,Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
 for attempt in range(3):
  t=time.monotonic();report=sync.run();report['durationSeconds']=round(time.monotonic()-t,3);reports.append(report)
  if any(r['status']=='error' for r in report['directions'].values()):raise RuntimeError(json.dumps(report))
 counts={}
 for side,home in homes.items():
  with m.connect(home/'state_5.sqlite') as db:
   assert db.execute('pragma quick_check').fetchone()[0]=='ok'
   assert not db.execute('pragma foreign_key_check').fetchall()
   ids={r['id'] for r in m.records(db,'threads')}
   for row in m.records(db,'threads'):
    p=Path(row['rollout_path']);assert p.exists()
    assert json.loads(p.read_bytes().splitlines()[0])['payload']['id']==row['id']
   counts[side]=len(ids)
   if side=='official':expected=ids
   else:assert ids==expected
 selected=list(aliases.values())
 with m.connect(homes['official']/'state_5.sqlite') as db:
  selected.append(db.execute('select id from threads order by created_at desc limit 1').fetchone()[0])
 engine=subprocess.run(['node',str(base/'scripts/verify-synced-history.cjs'),str(homes['official']),json.dumps(selected)],capture_output=True,text=True,timeout=60)
 if engine.returncode:raise RuntimeError('Official engine validation failed: '+engine.stderr)
 engine_result=json.loads(engine.stdout.strip())
 report={'officialEngine':engine_result,'result':'passed','homesWereDisposable':True,'counts':counts,'runs':reports,'durationSeconds':round(time.monotonic()-start,3)}
 (base/'docs/history-sync-real-validation.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
