#!/usr/bin/env python3
"""Local, conservative history replication. Never share authentication or live DBs."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import select
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

# Also support importlib-based tests and the installed standalone service.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from history_projection import build_projection, publish_projection, snapshot_index, projection_offsets

TABLES = ('threads', 'projects', 'project_roots', 'thread_sections',
          'thread_dynamic_tools', 'thread_attachments', 'thread_spawn_edges')
EDITABLE = ('title', 'name', 'archived', 'archived_at', 'is_pinned',
            'thread_section_id', 'section_position', 'section_entered_at_ms', 'project_id')
NAMESPACE = uuid.UUID('8cf30504-c88c-4e6f-a976-87e909469616')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def connect(path, readonly=False):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2) if readonly else sqlite3.connect(path, timeout=2)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def snapshot(home):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    with contextlib.closing(connect(home / 'state_5.sqlite', True)) as source:
        source.backup(db)
    return db


def records(db, table):
    return [dict(row) for row in db.execute('SELECT * FROM ' + table)]


def insert(db, table, row):
    cols = list(row)
    db.execute('INSERT INTO ' + table + ' (' + ','.join('"' + col + '"' for col in cols) +
               ') VALUES (' + ','.join('?' for _ in cols) + ')', [row[col] for col in cols])


def update(db, table, row, key='id'):
    cols = [col for col in row if col != key]
    db.execute('UPDATE ' + table + ' SET ' + ','.join('"' + col + '"=?' for col in cols) +
               ' WHERE "' + key + '"=?', [row[col] for col in cols] + [row[key]])


def schema(db):
    # Refuse changed schemas rather than guessing after an app upgrade.
    return {table: [tuple(r) for r in db.execute('PRAGMA table_info(' + table + ')')] for table in TABLES}


def flatten_history(home, path, data, aliases, visited=None, other_homes=()):
    """Materialize paginated lineage using the exact source byte cutoffs."""
    visited = set() if visited is None else visited
    if path in visited:
        raise ValueError('Circular paginated history lineage')
    visited.add(path)
    first_line, rest = data.split(b'\n', 1)
    first = json.loads(first_line)
    meta = first.get('payload', {})
    base = meta.get('history_base')
    if not base:
        return data
    base_id = base['thread_id']
    # The earlier recovery renamed the segment but retained its original base file.
    lookup_id = next((old for old, new in aliases.items() if new == base_id), base_id)
    candidates = []
    for candidate_home in (home, *other_homes):
        for root in ('sessions', 'archived_sessions'):
            candidates.extend((candidate_home / root).rglob('rollout-*' + lookup_id + '.jsonl'))
    candidates = [p for p in candidates if p != path and p not in visited]
    # Prefer native base files over immutable sync snapshots of the same chat.
    candidates.sort(key=lambda p: ('flow-sync' in p.parts, str(p)))
    if not candidates:
        raise ValueError('Missing paginated source history for ' + base_id)
    offset = base['end_byte_offset']
    base_path = None
    for candidate in candidates:
        with candidate.open('rb') as source:
            candidate_prefix = source.read(offset)
        candidate_meta = json.loads(candidate_prefix.split(b'\n', 1)[0]).get('payload', {}) if candidate_prefix else {}
        inherited_ordinal = candidate_meta.get('history_base', {}).get('end_ordinal_exclusive', 0)
        if (len(candidate_prefix) == offset and candidate_prefix.endswith(b'\n')
                and inherited_ordinal + candidate_prefix.count(b'\n') == base['end_ordinal_exclusive']):
            base_path, prefix = candidate, candidate_prefix
            break
    if base_path is None:
        raise ValueError('No complete matching paginated source history for ' + lookup_id)
    materialized = flatten_history(home, base_path, prefix, aliases, visited, other_homes)
    base_first, base_rest = materialized.split(b'\n', 1)
    base_meta = json.loads(base_first).get('payload', {})
    if aliases.get(base_meta.get('id')) == meta.get('id'):
        header = remap(base_first + b'\n', base_meta['id'], meta['id']).rstrip(b'\n')
    elif base_meta.get('id') == meta.get('id'):
        # Keep the original session header so a rotated segment remains a byte-prefix continuation.
        header = base_first
    else:
        meta.pop('history_base', None)
        header = json.dumps(first, separators=(',', ':'), ensure_ascii=False).encode()
    return header + b'\n' + base_rest + rest


def read_rollout(home, row, allow_interrupted=False, aliases=None, other_homes=()):
    path = Path(row['rollout_path'])
    resolved = path.resolve()
    if not any(resolved.is_relative_to((home / root).resolve()) for root in ('sessions', 'archived_sessions')):
        raise ValueError('Transcript outside allowed history directories')
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        return None
    if not data or not data.endswith(b'\n'):
        return None
    data = flatten_history(home, path, data, aliases or {}, other_homes=other_homes)
    active = False
    first = None
    for line in data.splitlines():
        item = json.loads(line)
        if first is None:
            first = item
        if item.get('type') == 'event_msg':
            kind = item.get('payload', {}).get('type')
            if kind == 'task_started':
                active = True
            elif kind in ('task_complete', 'turn_aborted', 'task_aborted'):
                active = False
    if first.get('type') != 'session_meta' or first.get('payload', {}).get('id') != row['id']:
        raise ValueError('Transcript identity does not match index')
    return None if active and not allow_interrupted else data


def signature(row):
    st = Path(row['rollout_path']).stat()
    return digest(json.dumps(row, sort_keys=True).encode()) + ':' + str(st.st_size) + ':' + str(st.st_mtime_ns)


def remap(data, old, new):
    if old == new:
        return data
    def walk(value):
        if isinstance(value, dict):
            return {k: new if k in ('id', 'thread_id', 'threadId', 'parent_thread_id', 'child_thread_id', 'session_id', 'sessionId') and v == old else walk(v)
                    for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        return value
    return b''.join(json.dumps(walk(json.loads(line)), separators=(',', ':'), ensure_ascii=False).encode() + b'\n'
                    for line in data.splitlines())


class ProcessGuard:
    """Main apps, bundled engines, and open history files all count as busy."""
    def __init__(self, homes, apps):
        self.homes, self.apps = homes, apps

    def busy(self, side):
        output = subprocess.check_output(['/bin/ps', '-axo', 'command='], text=True)
        # Both apps can launch the same bundled engine. Its executable path
        # does not identify its history home; lsof below checks that directly.
        prefix = str(self.apps[side]) + '/Contents/MacOS/'
        for command in output.splitlines():
            if command.startswith(prefix):
                return True
        # Also catch a separately launched CLI using this home. lsof failure fails closed.
        paths = [self.homes[side] / name for name in ('state_5.sqlite', 'state_5.sqlite-wal', 'thread_history_1.sqlite', 'thread_history_1.sqlite-wal')]
        existing = [str(p) for p in paths if p.exists()]
        if existing:
            result = subprocess.run(['/usr/sbin/lsof', '-t', '--', *existing], capture_output=True, text=True)
            if result.returncode not in (0, 1):
                raise RuntimeError('Cannot determine history file ownership')
            if any(int(pid) != os.getpid() for pid in result.stdout.split()):
                return True
        return False


class Sync:
    def __init__(self, homes, state_dir, busy, aliases=None, engine=None):
        self.homes = {k: Path(v).resolve() for k, v in homes.items()}
        if self.homes['official'] == self.homes['codexpp']:
            raise ValueError('History homes must be different')
        self.root = Path(state_dir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.busy = busy
        self.state_path = self.root / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {'version': 1, 'baseline': {}, 'seen': {}}
        self.state.setdefault('routes', {})
        self.aliases = aliases or {}
        self.engine = Path(engine) if engine else None
        self.report = {}

    def read_history(self, home, row, **kwargs):
        data = read_rollout(home, row, aliases=self.aliases, other_homes=tuple(h for h in self.homes.values() if h != home), **kwargs)
        # Compatibility with our earlier recovery script, which remapped UUIDs in
        # every string (including context paths). Undo that only for known imports,
        # then remap structured identity fields without altering prompt text.
        for original, recovered in self.aliases.items():
            if data is not None and row['id'] == recovered:
                data = remap(data.replace(recovered.encode(), original.encode()), original, recovered)
                break
        if data is not None:
            header, body = data.split(b'\n', 1)
            first = json.loads(header)
            if 'session_id' in first['payload']:
                first['payload']['session_id'] = first['payload']['id']
            data = json.dumps(first, separators=(',', ':'), ensure_ascii=False).encode() + b'\n' + body
        return data

    def baseline_merge(self, table, source, target, fields, preferred, counts):
        key = table + ':' + source['id']
        base = self.state['baseline'].setdefault(key, {})
        merged = dict(target)
        for field in fields:
            a, b = source[field], target[field]
            if a == b:
                base[field] = a
                continue
            if field in base:
                if a == base[field]:
                    continue
                choose = b == base[field] or preferred
                if b != base[field]:
                    # Preserve conflicting metadata in the private audit journal.
                    with (self.root / 'metadata-conflicts.jsonl').open('a') as out:
                        out.write(json.dumps({'at': now(), 'table': table, 'id': source['id'], 'field': field,
                                              'incoming': a, 'existing': b, 'incomingChosen': choose}) + '\n')
                    os.chmod(self.root / 'metadata-conflicts.jsonl', 0o600)
                    counts['metadataConflicts'] += 1
            else:
                ta = source.get('updated_at_ms') or source.get('updated_at', 0) * 1000
                tb = target.get('updated_at_ms') or target.get('updated_at', 0) * 1000
                choose = ta > tb or (ta == tb and preferred)
            if choose:
                merged[field] = a
                base[field] = a
        return merged

    def run(self):
        report = {'checkedAt': now(), 'directions': {}}
        for source, target in (('codexpp', 'official'), ('official', 'codexpp')):
            try:
                report['directions'][source + '→' + target] = self.direction(source, target)
            except Exception as error:
                report['directions'][source + '→' + target] = {'status': 'error', 'error': type(error).__name__ + ': ' + str(error)}
        successful = {k: v for k, v in report['directions'].items() if v['status'] == 'synced'}
        if successful:
            self.state['lastSuccessfulSync'] = {'at': report['checkedAt'], 'directions': successful}
        report['lastSuccessfulSync'] = self.state.get('lastSuccessfulSync')
        self.report = report
        atomic_json(self.root / 'status.json', report)
        atomic_json(self.state_path, self.state)
        return report


    def sync_sidebar(self, origin, destination, planned_db):
        """Import missing legacy sidebar projects, without copying app preferences."""
        source = self.homes[origin] / '.codex-global-state.json'
        target = self.homes[destination] / '.codex-global-state.json'
        if not source.exists() or not target.exists():
            return 0
        incoming = json.loads(source.read_text())
        original = target.read_bytes()
        current = json.loads(original)
        projects = current.setdefault('local-projects', {})
        added = {}
        source_host = 'local:' + str(self.homes[origin])
        target_host = 'local:' + str(self.homes[destination])
        source_ids = incoming.get('app-server-project-id-by-legacy-project-id-by-host', {}).get(source_host, {})
        for identity, project in incoming.get('local-projects', {}).items():
            if identity in projects:
                continue
            server_id = source_ids.get(identity)
            if not server_id or not planned_db.execute('SELECT 1 FROM projects WHERE id=?', (server_id,)).fetchone():
                continue
            projects[identity] = project
            added[identity] = server_id
        if not added:
            return 0
        mapping = current.setdefault('app-server-project-id-by-legacy-project-id-by-host', {}).setdefault(target_host, {})
        mapping.update(added)
        order = current.setdefault('project-order', [])
        for identity in [*incoming.get('project-order', []), *added]:
            if identity in added and identity not in order:
                order.append(identity)
        assignments = current.setdefault('thread-project-assignments', {})
        for thread, assignment in incoming.get('thread-project-assignments', {}).items():
            if assignment.get('projectKind') != 'local' or assignment.get('projectId') not in added:
                continue
            if planned_db.execute('SELECT 1 FROM threads WHERE id=?', (thread,)).fetchone():
                assignments[thread] = assignment
                current.setdefault('thread-project-membership-host-ids', {})[thread] = 'local'
        if self.busy(destination):
            raise RuntimeError('Receiving app opened before sidebar update; retrying later')
        if target.read_bytes() != original:
            raise RuntimeError('Sidebar changed while planning; retrying later')
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup = self.root / 'backups' / (stamp + '-' + destination + '-sidebar')
        backup.mkdir(parents=True, mode=0o700)
        saved = backup / target.name
        saved.write_bytes(original)
        os.chmod(saved, 0o600)
        atomic_json(target, current)
        return len(added)

    def direction(self, origin, destination):
        if self.busy(destination):
            return {'status': 'waiting_for_receiving_app_to_close'}
        src_home, dst_home = self.homes[origin], self.homes[destination]
        if not (src_home / 'state_5.sqlite').exists() or not (dst_home / 'state_5.sqlite').exists():
            return {'status': 'waiting_for_history_database'}
        source_busy = self.busy(origin)
        src, dst = snapshot(src_home), snapshot(dst_home)
        counts = dict(newChats=0, updatedChats=0, conflictCopies=0, projects=0, pendingChats=0, metadataConflicts=0)
        staged = []
        changes = []
        backup = None
        state_before = json.loads(json.dumps(self.state))
        try:
            if schema(src) != schema(dst):
                raise RuntimeError('App history schemas differ; sync paused for compatibility')
            source_rows = {table: records(src, table) for table in TABLES}
            original_tables = {table: records(dst, table) for table in TABLES}
            observations = {}
            index_offsets = {}
            history_path = dst_home / 'thread_history_1.sqlite'
            if history_path.exists() and history_path.stat().st_size:
                index_offsets = projection_offsets(history_path)
            old_threads = {r['id']: r for r in records(dst, 'threads')}
            # Work out every DB change on the private in-memory snapshot first.
            for table, fields in (('thread_sections', ('name', 'appearance')), ('projects', ('name', 'metadata'))):
                for row in source_rows[table]:
                    existing = dst.execute('SELECT * FROM ' + table + ' WHERE id=?', (row['id'],)).fetchone()
                    if not existing:
                        copy = dict(row)
                        if table == 'projects':
                            copy['position'] = dst.execute('SELECT COALESCE(MAX(position),-1)+1 FROM projects').fetchone()[0]
                            counts['projects'] += 1
                        insert(dst, table, copy)
                        changes.append(('insert', table, copy))
                    else:
                        merged = self.baseline_merge(table, row, dict(existing), fields, origin == 'official', counts)
                        if merged != dict(existing):
                            update(dst, table, merged)
                            changes.append(('update', table, merged))
            for row in source_rows['project_roots']:
                if not dst.execute('SELECT 1 FROM project_roots WHERE project_id=? AND path=?', (row['project_id'], row['path'])).fetchone():
                    copy = dict(row)
                    copy['position'] = dst.execute('SELECT COALESCE(MAX(position),-1)+1 FROM project_roots WHERE project_id=?', (row['project_id'],)).fetchone()[0]
                    insert(dst, 'project_roots', copy)
                    changes.append(('insert', 'project_roots', copy))

            def store(row, data, existing, conflict=False):
                copy = dict(row)
                # Immutable new filename: never replace a transcript another process might have open.
                stamp = dt.datetime.fromtimestamp(copy['created_at'], dt.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')
                content_hash = digest(data)
                suffix = copy['id']
                if copy.get('history_mode') == 'paginated':
                    session_id = str(uuid.uuid5(NAMESPACE, copy['id'] + ':' + content_hash))
                    header, body = data.split(b'\n', 1)
                    first = json.loads(header)
                    first['payload']['session_id'] = session_id
                    data = json.dumps(first, separators=(',', ':'), ensure_ascii=False).encode() + b'\n' + body
                    suffix += '_' + session_id
                path = dst_home / 'sessions' / 'flow-sync' / content_hash[:20] / ('rollout-' + stamp + '-' + suffix + '.jsonl')
                copy['rollout_path'] = str(path)
                if existing:
                    merged = self.baseline_merge('threads', copy, existing, EDITABLE, origin == 'official', counts)
                    for field in EDITABLE:
                        copy[field] = merged[field]
                    update(dst, 'threads', copy)
                    changes.append(('update', 'threads', copy))
                    counts['updatedChats'] += 1
                else:
                    insert(dst, 'threads', copy)
                    changes.append(('insert', 'threads', copy))
                    counts['conflictCopies' if conflict else 'newChats'] += 1
                staged.append((path, data))
                return copy['id']

            def target_data(row):
                for path, data in reversed(staged):
                    if str(path) == row['rollout_path']:
                        header, body = data.split(b'\n', 1)
                        first = json.loads(header)
                        if 'session_id' in first['payload']:
                            first['payload']['session_id'] = first['payload']['id']
                        return json.dumps(first, separators=(',', ':'), ensure_ascii=False).encode() + b'\n' + body
                return self.read_history(dst_home, row, allow_interrupted=True)

            def target_signature(row):
                if any(str(path) == row['rollout_path'] for path, _ in staged):
                    return 'planned:' + digest(target_data(row))
                return signature(row)

            imported = {}
            for row in source_rows['threads']:
                planned = dst.execute('SELECT * FROM threads WHERE id=?', (row['id'],)).fetchone()
                existing = dict(planned) if planned else None
                # Comparing stat + indexed state makes repeated file events cheap.
                pair_key = origin + ':' + row['id']
                pair_sig = [signature(row), target_signature(existing) if existing else None]
                if self.state['seen'].get(pair_key) == pair_sig:
                    imported[row['id']] = self.state['routes'].get(pair_key, [row['id']])
                    continue
                incoming = self.read_history(src_home, row, allow_interrupted=not source_busy)
                if incoming is None:
                    counts['pendingChats'] += 1
                    continue
                current = target_data(existing) if existing else None
                if existing and current is None:
                    counts['pendingChats'] += 1
                    continue
                if not existing:
                    imported[row['id']] = [store(row, incoming, None)]
                elif incoming == current or current.startswith(incoming):
                    imported[row['id']] = [row['id']]
                    merged = self.baseline_merge('threads', row, existing, EDITABLE, origin == 'official', counts)
                    if any(str(path) == existing['rollout_path'] for path, _ in staged):
                        has_lineage = False
                    else:
                        with Path(existing['rollout_path']).open('rb') as original_file:
                            has_lineage = bool(json.loads(original_file.readline()).get('payload', {}).get('history_base'))
                    if not any(str(path) == existing['rollout_path'] for path, _ in staged) and existing.get('history_mode') == 'paginated' and index_offsets.get(Path(existing['rollout_path']).stem[-36:]) != Path(existing['rollout_path']).stat().st_size:
                        imported[row['id']] = [store(merged, current, existing)]
                    elif merged != existing:
                        update(dst, 'threads', merged)
                        changes.append(('update', 'threads', merged))
                        counts['updatedChats'] += 1
                elif incoming.startswith(current):
                    imported[row['id']] = [store(row, incoming, existing)]
                else:
                    # Official keeps the common ID; preserve the Codex++ branch under a stable new ID.
                    branch_id = self.aliases.get(row['id']) or str(uuid.uuid5(NAMESPACE, row['id'] + ':codexpp'))
                    branch_row = dict(row if origin == 'codexpp' else existing)
                    branch_data = incoming if origin == 'codexpp' else current
                    branch_data = remap(branch_data, row['id'], branch_id)
                    branch_row['id'] = branch_id
                    branch_row['title'] += ' [Sync conflict — Codex++]'
                    if branch_row.get('name'):
                        branch_row['name'] += ' [Sync conflict — Codex++]'
                    branch_existing = dst.execute('SELECT * FROM threads WHERE id=?', (branch_id,)).fetchone()
                    branch_existing = dict(branch_existing) if branch_existing else None
                    if branch_existing:
                        prior = target_data(branch_existing)
                        if prior is None:
                            counts['pendingChats'] += 1
                            continue
                        # Earlier one-time recovery preserved JSON whitespace; compare canonical records.
                        prior = b''.join(json.dumps(json.loads(line), separators=(',', ':'), ensure_ascii=False).encode() + b'\n' for line in prior.splitlines())
                        if prior == branch_data or prior.startswith(branch_data):
                            pass
                        elif branch_data.startswith(prior):
                            store(branch_row, branch_data, branch_existing)
                        else:
                            # A branch independently edited again is retained as another immutable chat.
                            secondary_id = str(uuid.uuid5(NAMESPACE, branch_id + ':' + digest(branch_data)))
                            secondary = dict(branch_row, id=secondary_id)
                            if not dst.execute('SELECT 1 FROM threads WHERE id=?', (secondary_id,)).fetchone():
                                store(secondary, remap(branch_data, branch_id, secondary_id), None, True)
                    else:
                        store(branch_row, branch_data, None, True)
                    if origin == 'official':
                        imported[row['id']] = [store(row, incoming, existing)]
                        # Existing Codex++ tools/attachments belong to its preserved branch too.
                        for table in ('thread_dynamic_tools', 'thread_attachments'):
                            for child in records(dst, table):
                                if child['thread_id'] == row['id']:
                                    child['thread_id'] = branch_id
                                    if table == 'thread_attachments':
                                        child['id'] = str(uuid.uuid5(NAMESPACE, child['id'] + ':' + branch_id))
                                    clause = 'thread_id=? AND position=?' if table == 'thread_dynamic_tools' else 'thread_id=? AND attachment_type=? AND identity_key=?'
                                    args = (branch_id, child['position']) if table == 'thread_dynamic_tools' else (branch_id, child['attachment_type'], child['identity_key'])
                                    if not dst.execute('SELECT 1 FROM ' + table + ' WHERE ' + clause, args).fetchone():
                                        insert(dst, table, child); changes.append(('insert', table, child))
                    else:
                        imported[row['id']] = [branch_id]
                # Filled after installation with the actual destination signature.
                observations[pair_key] = (pair_sig[0], row['id'])
                self.state['routes'][pair_key] = imported.get(row['id'], [row['id']])

            for table in ('thread_dynamic_tools', 'thread_attachments'):
                for child in source_rows[table]:
                    for thread_id in imported.get(child['thread_id'], []):
                        copy = dict(child, thread_id=thread_id)
                        if table == 'thread_dynamic_tools':
                            where, args = 'thread_id=? AND position=?', (thread_id, copy['position'])
                        else:
                            where, args = 'thread_id=? AND attachment_type=? AND identity_key=?', (thread_id, copy['attachment_type'], copy['identity_key'])
                            copy['id'] = str(uuid.uuid5(NAMESPACE, child['id'] + ':' + thread_id))
                        if not dst.execute('SELECT 1 FROM ' + table + ' WHERE ' + where, args).fetchone():
                            insert(dst, table, copy); changes.append(('insert', table, copy))
            for edge in source_rows['thread_spawn_edges']:
                for child_id in imported.get(edge['child_thread_id'], []):
                    copy = dict(edge, child_thread_id=child_id)
                    if not dst.execute('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?', (child_id,)).fetchone():
                        insert(dst, 'thread_spawn_edges', copy); changes.append(('insert', 'thread_spawn_edges', copy))
            def remember():
                for pair_key, (incoming_signature, thread_id) in observations.items():
                    final = dict(dst.execute('SELECT * FROM threads WHERE id=?', (thread_id,)).fetchone())
                    self.state['seen'][pair_key] = [incoming_signature, signature(final)]

            if not changes:
                remember()
                sidebar_projects = self.sync_sidebar(origin, destination, dst)
                return dict(status='synced' if sidebar_projects else 'up_to_date', sidebarProjects=sidebar_projects, **counts)
            projection = None
            if self.engine and staged:
                dst.commit()  # Only the disposable planning database is committed here.
                projection = build_projection(dst, staged, self.root, self.engine)
            if self.busy(destination):
                self.state = state_before
                return {'status': 'waiting_for_receiving_app_to_close'}
            stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
            backup = self.root / 'backups' / (stamp + '-' + destination)
            backup.mkdir(parents=True, mode=0o700)
            actual = connect(dst_home / 'state_5.sqlite')
            created = []
            try:
                # Lock the target before checking its snapshot; don't clobber an intervening DB change.
                actual.execute('BEGIN IMMEDIATE')
                for table in TABLES:
                    if records(actual, table) != original_tables[table]:
                        raise RuntimeError('Target changed while planning; retrying later')
                if self.busy(destination):
                    raise RuntimeError('Receiving app opened while planning; retrying later')
                # SQLite backup from a separate read connection avoids backing up an active write transaction.
                with contextlib.closing(connect(dst_home / 'state_5.sqlite', True)) as original:
                    with contextlib.closing(sqlite3.connect(backup / 'state.sqlite')) as saved:
                        original.backup(saved)
                os.chmod(backup / 'state.sqlite', 0o600)
                for thread_id in {row['id'] for op, table, row in changes if table == 'threads' and op == 'update'}:
                    if thread_id not in old_threads:
                        continue
                    previous = Path(old_threads[thread_id]['rollout_path'])
                    shutil.copyfile(previous, backup / (thread_id + '.jsonl'))
                    os.chmod(backup / (thread_id + '.jsonl'), 0o600)
                for path, data in staged:
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if path.exists():
                        if path.read_bytes() != data:
                            raise RuntimeError('Immutable transcript path collision')
                        continue
                    with path.open('xb') as out:
                        os.chmod(path, 0o600); out.write(data); out.flush(); os.fsync(out.fileno())
                    created.append(path)
                # Publish only immutable new rollout IDs before changing the main index.
                # A crash here can leave unused rows, never an index pointing at missing history.
                publish_projection(dst_home, backup, projection)
                for operation, table, row in changes:
                    (insert if operation == 'insert' else update)(actual, table, row)
                if actual.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('Foreign-key verification failed')
                if self.busy(destination):
                    raise RuntimeError('Receiving app opened before commit; retrying later')
                actual.commit()
            except BaseException:
                actual.rollback()
                for path in created:
                    path.unlink()
                self.state = state_before
                raise
            finally:
                actual.close()
            atomic_json(backup / 'manifest.json', {'at': now(), 'source': origin, 'target': destination, 'counts': counts,
                                                 'transcriptsAdded': [str(p) for p in created]})
            remember()
            # Original transcript files remain in place. No destructive deletion propagation.
            sidebar_projects = self.sync_sidebar(origin, destination, dst)
            return dict(status='synced', backup=str(backup), sidebarProjects=sidebar_projects, **counts)
        except BaseException:
            self.state = state_before
            raise
        finally:
            src.close(); dst.close()


class Watcher:
    """macOS vnode events; a light heartbeat also detects app exits and missed events."""
    def __init__(self, homes):
        self.homes = homes
        self.queue = select.kqueue()
        self.fds = {}
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        resource.setrlimit(resource.RLIMIT_NOFILE, (min(max(soft, 2048), hard), hard))

    def refresh(self):
        wanted = set()
        for home in self.homes.values():
            wanted.add(home)
            for name in ('state_5.sqlite', 'state_5.sqlite-wal', 'sessions', 'archived_sessions'):
                path = home / name
                if path.exists():
                    wanted.add(path)
            database = home / 'state_5.sqlite'
            if database.exists():
                try:
                    with contextlib.closing(connect(database, True)) as index:
                        paths = [Path(r[0]) for r in index.execute('SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT 256')]
                    for path in paths:
                        if not path.resolve().is_relative_to(home.resolve()) or not path.exists():
                            continue
                        wanted.add(path)
                        for parent in path.parents:
                            if parent.resolve() == home.resolve():
                                break
                            wanted.add(parent)
                except sqlite3.OperationalError:
                    pass  # Database events and the heartbeat retry a transient lock.
        for path in set(self.fds) - wanted:
            os.close(self.fds.pop(path)[0])
        for path in wanted:
            try:
                inode = path.stat().st_ino
                if path in self.fds and self.fds[path][1] == inode:
                    continue
                if path in self.fds:
                    os.close(self.fds.pop(path)[0])
                fd = os.open(path, getattr(os, 'O_EVTONLY', os.O_RDONLY))
                flags = select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND | select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME
                event = select.kevent(fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=flags)
                self.queue.control([event], 0, 0)
                self.fds[path] = (fd, inode)
            except FileNotFoundError:
                pass

    def wait(self, timeout):
        return bool(self.queue.control(None, 256, timeout))

    def close(self):
        for fd, _ in self.fds.values():
            os.close(fd)
        self.queue.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('command', choices=('once', 'watch', 'status'))
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    root = Path(config['stateDir'])
    if args.command == 'status':
        print((root / 'status.json').read_text() if (root / 'status.json').exists() else 'Not started')
        return
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (root / 'sync.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Sync is already running')
    homes = {k: Path(v) for k, v in config['homes'].items()}
    apps = {k: Path(v) for k, v in config['apps'].items()}
    guard = ProcessGuard(homes, apps)
    sync = Sync(homes, root, guard.busy, config.get('conflictAliases'), config.get('engine'))
    if args.command == 'once':
        print(json.dumps(sync.run(), indent=2))
        return
    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    watcher = Watcher(homes)
    next_run = 0
    try:
        while running:
            watcher.refresh()
            if time.monotonic() >= next_run:
                sync.run()
                next_run = time.monotonic() + 20
            event = watcher.wait(min(1, max(0, next_run - time.monotonic())))
            if event:
                until = time.monotonic() + 3
                while running and time.monotonic() < until and watcher.wait(0.5):
                    pass
                if running:
                    sync.run()
                    next_run = time.monotonic() + 20
    finally:
        watcher.close()


if __name__ == '__main__':
    main()
