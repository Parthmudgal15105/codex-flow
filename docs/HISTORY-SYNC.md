# Local history sync

The independent sync service connects the official app's `~/.codex` history and Codex++'s private history on this Mac. It does not modify either app bundle.

## Everyday use

Use one app at a time. A new chat, prompt, completed reply, or project change triggers a filesystem watcher. Writes are debounced for roughly half a second (up to three seconds during a burst). Unfinished replies wait until completion; an interrupted conversation can be copied once its source app closes.

The receiving app must be fully quit, not merely have its window closed. App processes and open history databases are checked before applying changes. If both apps are open, updates wait. A lightweight check every 20 seconds catches app exits and missed filesystem events. The service starts when you log in and sends no notifications.

Allow the final reply to sync before opening the other app. If you open it before an update finishes, sync waits for it to close again. This is local replication, not a cloud sync service or a supported OpenAI live-history interface.

Open **Codex Flow Sync Status.command** in your Applications folder to see its current status and last successful update.

## What is carried across

- New chats and continued conversation history.
- Projects, project folder associations, and added project roots. Missing desktop sidebar project entries and their existing chat assignments are also imported, including when the database already contains the project. The receiving sidebar file is backed up first; unrelated app preferences and existing project entries are preserved.
- Chat names, pin/archive state, sections, and project assignments.
- Stored dynamic tool definitions, attachment records, and child-chat relationships.

The actual project files already live in the same folders on this Mac. Existing attachment paths remain accessible on this Mac; sync does not package arbitrary external files, temporary images, worktrees, or generated artifacts for another computer.

Account logins, quota counters, account routing settings, app preferences, plugins, and unrelated databases are not replicated. Deletions and project-root removals are not propagated. This first version is intended for continuity while alternating apps, rather than simultaneously editing one chat in both.

## Conflicts and backups

An ordinary continuation retains the same chat ID. If both sides independently continue a chat, the official app's version retains that ID and the Codex++ version is preserved in a separate conflict chat. Stable IDs prevent repeated syncs from producing more copies. The three known chats recovered earlier are reused rather than duplicated.

Metadata uses a saved common baseline. Concurrent edits to the same field prefer the official app; both field values are saved in the private conflict journal. Project roots are merged by folder path.

Before any applied batch, the service saves a SQLite snapshot and copies transcripts being superseded. New transcript versions use separate filenames; original files are retained. Failed transactions roll back database writes and remove only newly created files. Backups are retained without automatic pruning.

Recent Codex versions split histories into paginated lineage segments. Sync follows their byte cutoffs and materializes a standalone log for the receiving engine. The official engine prepares its message index in an isolated temporary home, using ephemeral in-memory forks that do not create saved chats or send model requests. Only new immutable index entries are published before the main history index changes. Original logs remain available in the backup. Database schema differences pause syncing rather than attempting a guessed migration.

Data, status, and backups live in:

`~/Library/Application Support/CodexFlowSync/`

## Controls

```sh
python3 "$HOME/Library/Application Support/CodexFlowSync/syncctl.py" status
python3 "$HOME/Library/Application Support/CodexFlowSync/syncctl.py" pause
python3 "$HOME/Library/Application Support/CodexFlowSync/syncctl.py" resume
```

The launch agent is `~/Library/LaunchAgents/com.local.codex-flow.history-sync.plist`. Pausing it preserves histories and backups. It runs the installed copy of the service, so moving the development project does not stop syncing.

## Development and validation

```sh
python3 -m unittest discover -s codex-flow/tests -p 'test_history_sync.py' -v
python3 codex-flow/scripts/test-history-sync-real.py
python3 codex-flow/scripts/install-history-sync.py
```

The real-history test uses disposable database and transcript copies. It checks convergence, database integrity, chat identities, and conversation text through the official engine's read-only history interfaces. It sends no prompts and consumes no model quota. Reports are saved in `docs/history-sync-real-validation.json`.

Official protocol reference: [OpenAI Docs: Codex App Server](https://learn.chatgpt.com/docs/app-server). File/database replication is custom compatibility code; it is not an official synchronization API.
