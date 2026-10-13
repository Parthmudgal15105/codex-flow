#!/usr/bin/env python3
"""One-way recovery of missing chats. Never overwrite a target conversation."""
from pathlib import Path
import sqlite3,json,datetime,uuid,shutil,os
source=Path.home()/'Library/Application Support/CodexPP/codex-home'
target=Path.home()/'.codex'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path.home()/'Library/Application Support/CodexPP/backups'/('history-recovery-'+stamp)
backup.mkdir(parents=True,mode=0o700)

def snapshot(home,name):
 src=sqlite3.connect((home/'state_5.sqlite').as_uri()+'?mode=ro',uri=True)
 dst=sqlite3.connect(backup/name);src.backup(dst);src.close();dst.close();os.chmod(backup/name,0o600)
 return backup/name
snapshot(target,'original-state.sqlite');frozen=snapshot(source,'codexpp-state.sqlite')
s=sqlite3.connect(frozen);s.row_factory=sqlite3.Row
t=sqlite3.connect(target/'state_5.sqlite',timeout=30);t.row_factory=sqlite3.Row
t.execute('PRAGMA foreign_keys=ON')

def rows(db,table):return [dict(r) for r in db.execute('SELECT * FROM '+table)]
def insert(table,row):
 cols=list(row);t.execute('INSERT INTO '+table+' ('+','.join('"'+c+'"' for c in cols)+') VALUES ('+','.join('?' for _ in cols)+')',[row[c] for c in cols])
def prefix(a,b):
 with a.open('rb') as x,b.open('rb') as y:
  while True:
   left=x.read(65536)
   if not left:return True
   if left!=y.read(len(left)):return False
existing={r['id']:r for r in rows(t,'threads')};mapping={};copied=[];counts={'missingChats':0,'conflictCopies':0,'projects':0,'projectRoots':0}
report={'backup':str(backup),'counts':counts,'imported':[]}
try:
 t.execute('BEGIN IMMEDIATE')
 for row in rows(s,'projects'):
  if not t.execute('SELECT 1 FROM projects WHERE id=?',(row['id'],)).fetchone():
   row['position']=t.execute('SELECT COALESCE(MAX(position),-1)+1 FROM projects').fetchone()[0];insert('projects',row);counts['projects']+=1
 for row in rows(s,'project_roots'):
  if not t.execute('SELECT 1 FROM project_roots WHERE project_id=? AND path=?',(row['project_id'],row['path'])).fetchone():
   row['position']=t.execute('SELECT COALESCE(MAX(position),-1)+1 FROM project_roots WHERE project_id=?',(row['project_id'],)).fetchone()[0];insert('project_roots',row);counts['projectRoots']+=1
 for row in rows(s,'thread_sections'):
  if not t.execute('SELECT 1 FROM thread_sections WHERE id=?',(row['id'],)).fetchone():insert('thread_sections',row)
 for row in rows(s,'threads'):
  old=row['id'];src=Path(row['rollout_path']);current=existing.get(old)
  if not src.is_file():raise RuntimeError('A source transcript is missing; refusing incomplete recovery')
  if current:
   native=Path(current['rollout_path'])
   if native.is_file() and prefix(src,native):continue
   new=str(uuid.uuid4());counts['conflictCopies']+=1
  else:new=old;counts['missingChats']+=1
  mapping[old]=new
  shutil.copy2(src,backup/(old+'.jsonl'))
  try:relative=src.relative_to(source)
  except ValueError:relative=Path('sessions/recovered')/src.name
  dest=target/relative.parent/relative.name.replace(old,new)
  if dest.exists():
   # A transcript not yet indexed may already be present; never replace it.
   if current is None and dest.read_bytes()==src.read_bytes():pass
   else:raise RuntimeError('Recovery destination exists with different content')
  else:
   dest.parent.mkdir(parents=True,exist_ok=True)
   data=src.read_bytes()
   if new!=old:data=data.replace(old.encode(),new.encode())
   with dest.open('xb') as out:out.write(data)
   os.chmod(dest,0o600);copied.append(dest)
  row['id']=new;row['rollout_path']=str(dest)
  if new!=old:
   row['title']=(row['title'] or 'Conversation')+' [Recovered from Codex++]'
   if row.get('name'):row['name']+=' [Recovered from Codex++]'
  insert('threads',row);report['imported'].append({'sourceId':old,'targetId':new,'copiedVersion':new!=old})
 for table in ['thread_dynamic_tools','thread_attachments']:
  for row in rows(s,table):
   if row['thread_id'] not in mapping:continue
   row['thread_id']=mapping[row['thread_id']]
   if table=='thread_attachments' and t.execute('SELECT 1 FROM thread_attachments WHERE id=?',(row['id'],)).fetchone():row['id']=str(uuid.uuid4())
   insert(table,row)
 for row in rows(s,'thread_spawn_edges'):
  if row['child_thread_id'] not in mapping:continue
  row['child_thread_id']=mapping[row['child_thread_id']];row['parent_thread_id']=mapping.get(row['parent_thread_id'],row['parent_thread_id'])
  if not t.execute('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?',(row['child_thread_id'],)).fetchone():insert('thread_spawn_edges',row)
 for item in report['imported']:
  row=t.execute('SELECT rollout_path FROM threads WHERE id=?',(item['targetId'],)).fetchone();assert Path(row['rollout_path']).is_file()
 if t.execute('PRAGMA foreign_key_check').fetchall():raise RuntimeError('Foreign-key verification failed')
 t.commit()
except BaseException:
 t.rollback()
 for p in copied:p.unlink()
 raise
finally:s.close();t.close()
(backup/'recovery-report.json').write_text(json.dumps(report,indent=2)+'\n');os.chmod(backup/'recovery-report.json',0o600)
print(json.dumps({'backup':str(backup),'recovered':counts},indent=2))
