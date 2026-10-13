import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import sys
import time
import signal
import unittest
from unittest.mock import patch
import uuid

MODULE = Path(__file__).resolve().parents[1] / 'sync/history_sync.py'
spec = importlib.util.spec_from_file_location('history_sync', MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SCHEMA = Path(__file__).with_name('history-schema.sql').read_text()


class HistorySyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.homes = {s: self.root / s for s in ('official', 'codexpp')}
        for h in self.homes.values():
            h.mkdir(); (h / 'sessions').mkdir()
            with sqlite3.connect(h / 'state_5.sqlite') as db:
                db.executescript(SCHEMA)
            (h / 'auth.json').write_text('private-' + h.name)
            (h / 'config.toml').write_text('separate-' + h.name)
        self.busy_sides = set()
        self.sync = m.Sync(self.homes, self.root / 'sync', lambda side: side in self.busy_sides)
        self.id = str(uuid.uuid4())

    def tearDown(self):
        self.temp.cleanup()

    def db(self, side):
        return m.connect(self.homes[side] / 'state_5.sqlite')

    def seed(self, side, identity=None, extra=None, title='Test chat'):
        identity = identity or self.id
        data = [{'type': 'session_meta', 'payload': {'id': identity}},
                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'hello'}}]
        if extra:
            data.extend(extra)
        path = self.homes[side] / 'sessions' / (identity + '.jsonl')
        path.write_bytes(b''.join(json.dumps(r).encode() + b'\n' for r in data))
        with self.db(side) as db:
            db.execute("INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode) VALUES(?,?,1,1,'cli','openai',? ,?,'read-only','never')", (identity, str(path), str(self.root), title))
        return path

    def thread(self, side, identity=None):
        with self.db(side) as db:
            row = db.execute('select * from threads where id=?', (identity or self.id,)).fetchone()
            return dict(row) if row else None

    def append(self, side, message='next', kind='user_message'):
        row = self.thread(side)
        with Path(row['rollout_path']).open('ab') as f:
            f.write(json.dumps({'type': 'event_msg', 'payload': {'type': kind, 'message': message}}).encode() + b'\n')
        with self.db(side) as db:
            db.execute('update threads set updated_at=updated_at+1 where id=?', (self.id,))

    def count(self, side):
        with self.db(side) as db:
            return db.execute('select count(*) from threads').fetchone()[0]

    def assert_ok(self, report):
        for entry in report['directions'].values():
            self.assertNotEqual(entry['status'], 'error', entry)

    def test_shared_engine_does_not_block_other_app_home(self):
        apps = {'official': '/Applications/ChatGPT.app', 'codexpp': '/Applications/Codex++.app'}
        guard = m.ProcessGuard(self.homes, apps)
        processes = ('/Applications/Codex++.app/Contents/MacOS/Codex++\n'
                     '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server\n')
        with patch.object(m.subprocess, 'check_output', return_value=processes), patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')):
            self.assertFalse(guard.busy('official'))
            self.assertTrue(guard.busy('codexpp'))
        with patch.object(m.subprocess, 'check_output', return_value=processes), patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '999999\n', '')):
            self.assertTrue(guard.busy('official'))

    def test_missing_sidebar_project_repaired_when_database_already_synced(self):
        self.seed('codexpp')
        self.sync.run()
        for side in self.homes:
            with self.db(side) as db:
                db.execute("INSERT INTO projects VALUES('server-project','CodexFlow','{}',0,1,1)")
        source_state = {
            'local-projects': {'legacy-project': {'id': 'legacy-project', 'name': 'CodexFlow', 'rootPaths': ['/code/flow']}},
            'app-server-project-id-by-legacy-project-id-by-host': {
                'local:' + str(self.homes['codexpp'].resolve()): {'legacy-project': 'server-project'}},
            'thread-project-assignments': {self.id: {'projectKind': 'local', 'projectId': 'legacy-project'}},
            'project-order': ['legacy-project'], 'private-preference': 'source'}
        target_state = {'local-projects': {}, 'private-preference': 'target',
                        'thread-project-assignments': {self.id: {'projectKind': 'local', 'projectId': 'old'}}}
        m.atomic_json(self.homes['codexpp'] / '.codex-global-state.json', source_state)
        target = self.homes['official'] / '.codex-global-state.json'
        m.atomic_json(target, target_state)
        self.busy_sides.add('official')
        self.sync.run()
        self.assertEqual(json.loads(target.read_text()), target_state)
        self.busy_sides.clear()
        report = self.sync.run()['directions']['codexpp→official']
        self.assertEqual(report['sidebarProjects'], 1)
        repaired = json.loads(target.read_text())
        self.assertEqual(repaired['private-preference'], 'target')
        self.assertEqual(repaired['thread-project-assignments'][self.id]['projectId'], 'legacy-project')
        self.assertEqual(repaired['app-server-project-id-by-legacy-project-id-by-host']['local:' + str(self.homes['official'].resolve())]['legacy-project'], 'server-project')
        self.assertTrue(list((self.root / 'sync/backups').glob('*-sidebar/.codex-global-state.json')))
        before = target.read_bytes()
        self.sync.run()
        self.assertEqual(target.read_bytes(), before)

    def test_new_chat_bidirectional_and_noop(self):
        self.seed('codexpp')
        self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 1)
        self.assertEqual(self.count('codexpp'), 1)
        backups = list((self.root / 'sync/backups').iterdir())
        self.assert_ok(self.sync.run())
        self.assertEqual(backups, list((self.root / 'sync/backups').iterdir()))

    def test_append_and_reverse_continuation_preserves_old_file(self):
        self.seed('codexpp'); self.sync.run()
        old = Path(self.thread('official')['rollout_path']); old_bytes = old.read_bytes()
        self.append('codexpp')
        self.assert_ok(self.sync.run())
        self.assertEqual(old.read_bytes(), old_bytes)
        self.assertIn(b'next', Path(self.thread('official')['rollout_path']).read_bytes())
        self.append('official', 'return')
        self.assert_ok(self.sync.run())
        self.assertIn(b'return', Path(self.thread('codexpp')['rollout_path']).read_bytes())
        self.assertEqual(self.count('official'), 1)

    def test_conflict_converges_without_losing_either_version(self):
        self.seed('official'); self.sync.run()
        self.append('official', 'official branch'); self.append('codexpp', 'pp branch')
        self.assert_ok(self.sync.run()); self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 2)
        self.assertEqual(self.count('codexpp'), 2)
        for side in self.homes:
            self.assertIn(b'official branch', Path(self.thread(side)['rollout_path']).read_bytes())
            with self.db(side) as db:
                branch = db.execute('select * from threads where id!=?', (self.id,)).fetchone()
            self.assertIn(b'pp branch', Path(branch['rollout_path']).read_bytes())
            self.assertEqual(json.loads(Path(branch['rollout_path']).read_bytes().splitlines()[0])['payload']['id'], branch['id'])
        for _ in range(3):
            self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 2)

    def test_receiving_app_busy_then_close(self):
        self.seed('codexpp'); self.busy_sides.add('official')
        result = self.sync.run()
        self.assertEqual(result['directions']['codexpp→official']['status'], 'waiting_for_receiving_app_to_close')
        self.assertEqual(self.count('official'), 0)
        self.busy_sides.clear(); self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 1)

    def test_active_turn_waits_until_complete(self):
        self.seed('codexpp', extra=[{'type': 'event_msg', 'payload': {'type': 'task_started'}}])
        self.busy_sides.add('codexpp')
        result = self.sync.run()
        self.assertEqual(result['directions']['codexpp→official']['pendingChats'], 1)
        self.assertEqual(self.count('official'), 0)
        self.append('codexpp', 'done', 'task_complete')
        self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 1)

    def test_interrupted_turn_recovered_after_source_closes(self):
        self.seed('codexpp', extra=[{'type': 'event_msg', 'payload': {'type': 'task_started'}}])
        self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 1)

    def test_partial_line_is_deferred(self):
        path = self.seed('codexpp')
        with path.open('ab') as f:
            f.write(b'{"partial":')
        self.assert_ok(self.sync.run())
        self.assertEqual(self.count('official'), 0)

    def test_schema_change_pauses(self):
        self.seed('codexpp')
        with self.db('official') as db:
            db.execute('alter table threads add column future_field text')
        result = self.sync.run()
        self.assertEqual(result['directions']['codexpp→official']['status'], 'error')
        self.assertEqual(self.count('official'), 0)

    def test_account_files_untouched(self):
        self.seed('codexpp'); self.sync.run()
        for side, home in self.homes.items():
            self.assertEqual((home / 'auth.json').read_text(), 'private-' + side)
            self.assertEqual((home / 'config.toml').read_text(), 'separate-' + side)

    def test_project_roots_and_chat_association(self):
        self.seed('codexpp')
        with self.db('codexpp') as db:
            db.execute("insert into projects values('p','Project','{}',0,1,1)")
            db.execute("insert into project_roots values('p',0,?)", (str(self.root),))
            db.execute("update threads set project_id='p' where id=?", (self.id,))
        self.assert_ok(self.sync.run())
        self.assertEqual(self.thread('official')['project_id'], 'p')
        with self.db('official') as db:
            self.assertEqual(db.execute('select count(*) from project_roots').fetchone()[0], 1)
        self.assert_ok(self.sync.run())

    def test_metadata_edit_syncs_both_directions(self):
        self.seed('official'); self.sync.run(); self.sync.run()
        with self.db('codexpp') as db:
            db.execute("update threads set title='Renamed',is_pinned=1 where id=?", (self.id,))
        self.assert_ok(self.sync.run())
        self.assertEqual(self.thread('official')['title'], 'Renamed')
        self.assertEqual(self.thread('official')['is_pinned'], 1)
        with self.db('official') as db:
            db.execute("update threads set archived=1 where id=?", (self.id,))
        self.assert_ok(self.sync.run())
        self.assertEqual(self.thread('codexpp')['archived'], 1)

    def test_new_attachment_after_chat_already_synced(self):
        self.seed('official'); self.sync.run()
        with self.db('official') as db:
            db.execute("insert into thread_attachments values('a',?,'pull_request','https://example.test/pr','{}',1)", (self.id,))
        self.assert_ok(self.sync.run())
        with self.db('codexpp') as db:
            self.assertEqual(db.execute('select count(*) from thread_attachments').fetchone()[0], 1)

    def test_process_appears_before_commit_rolls_back(self):
        self.seed('codexpp')
        calls = 0
        def guard(side):
            nonlocal calls
            if side == 'official':
                calls += 1
                return calls >= 4
            return False
        self.sync.busy = guard
        result = self.sync.run()
        self.assertEqual(result['directions']['codexpp→official']['status'], 'error')
        self.assertEqual(self.count('official'), 0)
        self.assertEqual(list((self.homes['official'] / 'sessions').rglob('*.jsonl')), [])

    def test_original_prompt_text_not_rewritten_in_conflict(self):
        self.seed('official'); self.sync.run()
        self.append('official', 'branch'); self.append('codexpp', self.id)
        self.assert_ok(self.sync.run())
        with self.db('official') as db:
            row = db.execute('select * from threads where id!=?', (self.id,)).fetchone()
        self.assertIn(self.id.encode(), Path(row['rollout_path']).read_bytes())

    def test_paginated_lineage_is_materialized(self):
        path = self.seed('codexpp')
        base_path = path.with_name('rollout-2026-01-01T00-00-00-' + self.id + '.jsonl')
        path.rename(base_path)
        base = base_path.read_bytes()
        segment = self.homes['codexpp'] / 'sessions' / ('rollout-2026-01-02T00-00-00-' + self.id + '_' + str(uuid.uuid4()) + '.jsonl')
        header = {'type': 'session_meta', 'payload': {'id': self.id, 'history_mode': 'paginated',
                  'history_base': {'thread_id': self.id, 'end_byte_offset': len(base), 'end_ordinal_exclusive': base.count(b'\n')}}}
        segment.write_bytes(json.dumps(header).encode() + b'\n' + json.dumps({'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'continued'}}).encode() + b'\n')
        with self.db('codexpp') as db:
            db.execute('update threads set rollout_path=?,history_mode=? where id=?', (str(segment), 'paginated', self.id))
        self.assert_ok(self.sync.run())
        data = Path(self.thread('official')['rollout_path']).read_bytes()
        self.assertIn(b'hello', data); self.assertIn(b'continued', data)
        self.assertNotIn('history_base', json.loads(data.splitlines()[0])['payload'])

    @unittest.skipUnless(hasattr(m.select, 'kqueue'), 'macOS daemon')
    def test_background_daemon_syncs_new_chat(self):
        config = {'stateDir': str(self.root / 'daemon'), 'homes': {k: str(v) for k, v in self.homes.items()},
                  'apps': {k: str(self.root / (k + '.app')) for k in self.homes}}
        config_path = self.root / 'config.json';config_path.write_text(json.dumps(config))
        child = subprocess.Popen([sys.executable, str(MODULE), '--config', str(config_path), 'watch'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 8
            while not (self.root / 'daemon/status.json').exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            if child.poll() is not None:
                self.fail('Daemon exited: ' + child.stderr.read().decode())
            if not (self.root / 'daemon/status.json').exists():
                child.kill();child.wait(timeout=4)
                self.fail('Daemon did not initialize: '+child.stderr.read().decode())
            self.seed('official')
            deadline = time.monotonic() + 8
            while self.thread('codexpp') is None and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertIsNotNone(self.thread('codexpp'))
            self.assertIsNone(child.poll())
        finally:
            child.terminate()
            try:child.wait(timeout=4)
            except subprocess.TimeoutExpired:child.kill();child.wait()
            child.stderr.close()

    @unittest.skipUnless(hasattr(m.select, 'kqueue'), 'macOS vnode watcher')
    def test_filesystem_event_detects_transcript_change(self):
        path = self.seed('official')
        watcher = m.Watcher(self.homes)
        try:
            watcher.refresh()
            with path.open('ab') as out:
                out.write(b'\n')
            self.assertTrue(watcher.wait(1))
        finally:
            watcher.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
