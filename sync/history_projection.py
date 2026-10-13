"""Build the native paginated item index through the official engine, in a temp home."""
import contextlib,json,os,selectors,sqlite3,subprocess,tempfile,time,shutil
from pathlib import Path

TABLES=('thread_turns','thread_items','thread_history_projection_state','thread_realtime_items')


def snapshot_index(path):
    """Some checkpointed WAL files cannot open read-only without their sidecars."""
    memory=sqlite3.connect(':memory:');memory.row_factory=sqlite3.Row
    try:
        with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as source:
            source.backup(memory)
    except sqlite3.OperationalError:
        if Path(str(path)+'-wal').exists():
            memory.close();raise
        with tempfile.TemporaryDirectory(prefix='flow-index-copy-') as temp:
            before=path.stat();copy=Path(temp)/'index.sqlite'
            shutil.copyfile(path,copy);os.chmod(copy,0o600)
            after=path.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
                memory.close();raise RuntimeError('History index changed while copying')
            with contextlib.closing(sqlite3.connect(copy)) as source:source.backup(memory)
    return memory


def projection_offsets(path):
    before=path.stat()
    try:
        with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as index:
            return dict(index.execute('SELECT thread_id,next_rollout_byte_offset FROM thread_history_projection_state'))
    except sqlite3.OperationalError:
        if Path(str(path)+'-wal').exists():raise
        with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)) as index:
            result=dict(index.execute('SELECT thread_id,next_rollout_byte_offset FROM thread_history_projection_state'))
        after=path.stat()
        if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or Path(str(path)+'-wal').exists():
            raise RuntimeError('Receiving message index changed during inspection')
        return result


def build_projection(planned_db, files, work_root, engine):
    final={r['id']:dict(r) for r in planned_db.execute('select * from threads')}
    contents={str(path):data for path,data in files}
    selected={identity:r for identity,r in final.items() if r['history_mode']=='paginated' and r['rollout_path'] in contents}
    if not selected:
        return None
    with tempfile.TemporaryDirectory(prefix='projection-',dir=work_root) as name:
        home=Path(name);db=sqlite3.connect(home/'state_5.sqlite');planned_db.backup(db)
        for identity,row in selected.items():
            relative=Path(row['rollout_path']).parts[-4:]
            path=home/'sessions'/Path(*relative)
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(contents[row['rollout_path']]);os.chmod(path,0o600)
            db.execute('update threads set rollout_path=? where id=?',(str(path),identity))
        db.commit();db.close()
        env={k:v for k,v in os.environ.items() if not k.startswith(('CODEX_','OPENAI_'))}
        env['CODEX_HOME']=str(home)
        child=subprocess.Popen([str(engine),'-c','features.plugins=false','-c','features.apps=false','-c','features.goals=false','app-server'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        sequence=0
        buffer=b''
        def rpc(method,params):
            nonlocal sequence,buffer
            sequence+=1;identity=sequence
            child.stdin.write((json.dumps({'id':identity,'method':method,'params':params})+'\n').encode());child.stdin.flush()
            # The engine writes newline JSON responses; this loop also drains notifications.
            selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
            deadline=time.monotonic()+30
            try:
                while time.monotonic()<deadline:
                    if b'\n' not in buffer:
                        if not selector.select(max(0,deadline-time.monotonic())):break
                        chunk=os.read(child.stdout.fileno(),65536)
                        if not chunk:raise RuntimeError('History index engine exited')
                        buffer+=chunk
                        continue
                    line,buffer=buffer.split(b'\n',1)
                    message=json.loads(line)
                    if message.get('id')!=identity:continue
                    if 'error' in message:raise RuntimeError('History indexing failed: '+message['error']['message'])
                    return message['result']
            finally:selector.close()
            raise TimeoutError('History index engine timed out')
        try:
            rpc('initialize',{'clientInfo':{'name':'codex_flow_sync_indexer','version':'1'},'capabilities':{'experimentalApi':True}})
            child.stdin.write(b'{"method":"initialized"}\n');child.stdin.flush()
            for identity in selected:
                # An ephemeral fork prepares the native index without adding a saved chat,
                # sending a prompt, or invoking model inference.
                rpc('thread/fork',{'threadId':identity,'ephemeral':True,'excludeTurns':True})
        finally:
            child.terminate()
            try:child.wait(timeout=4)
            except subprocess.TimeoutExpired:child.kill();child.wait()
            child.stdin.close();child.stdout.close()
        with contextlib.closing(sqlite3.connect(home/'thread_history_1.sqlite')) as index:
            index.row_factory=sqlite3.Row
            schemas=[r[0] for r in index.execute("select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 when 'index' then 1 when 'trigger' then 2 else 3 end")]
            migrations=[dict(r) for r in index.execute('select * from _sqlx_migrations')]
            rows={table:[dict(r) for r in index.execute('select * from '+table)] for table in TABLES}
            for identity,row in selected.items():
                session=json.loads(contents[row['rollout_path']].splitlines()[0])['payload']['session_id']
                if not any(r['thread_id']==session for r in rows['thread_history_projection_state']):
                    raise RuntimeError('Native engine did not build a history index')
            return {'schemas':schemas,'migrations':migrations,'rows':rows}


def publish_projection(home, backup, projection):
    if projection is None:return
    path=home/'thread_history_1.sqlite'
    # Existing projections are immutable and never replaced or deleted. Publishing
    # only new rollout IDs makes restoring the main DB sufficient for rollback.
    with contextlib.closing(sqlite3.connect(path)) as db:
        db.row_factory=sqlite3.Row
        if not db.execute("select 1 from sqlite_master where name='thread_items'").fetchone():
            for sql in projection['schemas']:db.execute(sql)
            for row in projection['migrations']:_insert(db,'_sqlx_migrations',row)
            db.commit()
        db.execute('BEGIN IMMEDIATE')
        try:
            for table,rows in projection['rows'].items():
                if rows:
                    columns=[r['name'] for r in db.execute('pragma table_info('+table+')')]
                    if columns!=list(rows[0]):raise RuntimeError('Native history index schema changed')
                ids={r['thread_id'] for r in rows}
                for identity in ids:
                    existing=[dict(r) for r in db.execute('select * from '+table+' where thread_id=?',(identity,))]
                    incoming=[r for r in rows if r['thread_id']==identity]
                    if existing:
                        if sorted(existing,key=lambda r:json.dumps(r,sort_keys=True))!=sorted(incoming,key=lambda r:json.dumps(r,sort_keys=True)):
                            raise RuntimeError('Immutable native history index conflict')
                    else:
                        for row in incoming:_insert(db,table,row)
            db.commit()
        except BaseException:db.rollback();raise
    os.chmod(path,0o600)


def _insert(db,table,row):
    columns=list(row)
    db.execute('insert into '+table+' ('+','.join(columns)+') values ('+','.join('?' for _ in columns)+')',[row[k] for k in columns])
