# Codex Flow

**Desktop routing iteration:** A separate Codex desktop copy is installed as `~/Applications/Codex++.app`, with both accounts connected and automatic routing before each unpinned message. See [usage, verification, and limitations](docs/DESKTOP-ROUTER.md). The older interface documented below remains available.

A local Mac coding workspace with two-account routing in the background. Chat, plan, edit files and review results without manually juggling accounts. No break reminders and no API key.

## Mac app

Open **Codex Flow** from your Dock.

- Open an existing project from the sidebar, use **Open project**, or create a Git project with the folder-plus button.
- Start a conversation or continue a saved one. Right-click a conversation to rename or archive it; archived chats can be restored.
- **Ask** explains, investigates and plans using a read-only sandbox. It does not create project notes or edit project files.
- **Build** edits the selected project and updates shared `implementation.md` notes.
- **Send** submits a message; Command-Return is the keyboard shortcut. Follow-up messages continue the conversation. Drafts and your mode choice are saved.
- Attach reference files or images with the paperclip. Selected image files are passed to Codex as images; other files are referenced by path.
- Replies and code blocks appear as messages. Project commands and their output are expandable. Use the copy button to copy a reply.
- **Stop** interrupts active work. **Retry** resumes the saved unfinished request after checking partial results.
- The inspector button opens **Files**, **Changes**, and **Preview**. View text/code, common images and PDFs. HTML/SVG files have an explicit preview button. Enter a running website's address to preview it; starting its development server is a separate coding task.
- **Accounts & usage** shows live usage, reset times, login controls and the routing recommendation. It refreshes every minute.

Conversations created in Flow are saved locally and shared across its two account sessions. Each chat has separate account/mode sessions. Recent discussion is copied when an account or mode has not seen it; repeated turns on the same session do not resend the entire conversation. Full transcripts stay on disk, while transferred context is bounded to 60,000 characters plus the current request and project notes. Very old discussion may require a summary in notes.

Existing chats in the official Codex desktop app are separate and are not automatically imported. Flow uses the installed Codex CLI rather than controlling the official desktop UI. Interactive command approvals, native desktop plugins and cloud-chat synchronization are not implemented; a command requiring extra permissions may stop and need manual setup. Project previews require a project file or an already-running website.

The app preserves both existing account logins. Project files stay in their selected folder. UI history/drafts live at `~/.codex-flow/ui/library.json`; per-chat transcripts, pending requests and account sessions live under `~/.codex-flow/projects/<project-id>/chats/<chat-id>`. Treat these as private, because they contain prompts and outputs. Project locks cover Flow workers, not unrelated editors or Codex applications.

Build/install with `macos/build.sh`. Native sources: `macos/FlowApp.swift` and `macos/FlowModel.swift`; structured conversation bridge: `src/ui.js`. This build currently contains this Mac's absolute Node/project paths. macOS 14+ and Xcode command-line tools are required to rebuild.

## Requirements

Node.js 22+ and the Codex CLI on your PATH. Developed with Codex CLI 0.157.1. Use a local Git repository for your coding project.

## Start

From this folder:

```sh
npm link
codex-flow login a
codex-flow login b
codex-flow status
codex-flow start /absolute/path/to/your/project
```

Each login opens Codex's normal sign-in flow. Choose a different ChatGPT account for each. Your existing desktop/CLI login is not changed. To avoid installing a command, replace `codex-flow` with `node /absolute/path/to/codex-flow/src/cli.js`.

Enter a coding request at the prompt. After it finishes, enter the next request. `/status` refreshes both accounts' usage; `/quit` exits. Ctrl+C stops the current worker. You can also run one task:

```sh
codex-flow start /absolute/path/to/your/project "Implement the settings screen and verify it"
```

If both accounts are unavailable, the request is saved. Return later with:

```sh
codex-flow continue /absolute/path/to/your/project
```

## How continuity works

The same project files are used by both accounts. An existing `implementation.md` is preserved; otherwise a starter file is created. Each worker is instructed to read the notes and actual files, update notes after meaningful milestones, and record checks and next steps. Each account retains its own conversation and resumes it for subsequent requests. Every request explicitly asks it to reconcile the notes with current files, including changes made by the other account.

A recognized usage-limit failure stops the old worker before the other starts. The new worker receives the unfinished request with instructions to inspect partial results before continuing. This is a new attempt with a handoff, not seamless transfer of a running command. Notes are maintained by Codex and can be incomplete if usage ends mid-milestone; current files remain the source of truth.

A project lock prevents two Flow processes from editing the same project. Do not run a separate desktop or CLI worker against that project simultaneously: Flow cannot lock other applications. General command failures, network errors, and temporary rate limits do not trigger automatic account rotation. Each account is attempted at most once per request.

## Usage and privacy

Usage is fetched fresh when selecting a worker and through `/status`; this iteration does not display a live meter during a running task. Five-hour and weekly windows are both checked. Missing usage is treated as unknown, and reaching a timestamp does not fabricate a fresh allowance. No schedule can guarantee that an account has allowance.

Account credentials, session history, pending requests, and event logs live under `~/.codex-flow`, outside the project. Account folders use restricted permissions. Logs include your prompts and Codex output; keep them private. Credentials are never printed. `implementation.md` lives inside your coding project; review it before committing or sharing.

Workers use Codex's workspace-write sandbox. Commands needing additional permissions may fail in this noninteractive first iteration; inspect the result and perform required setup yourself rather than bypassing the sandbox.

This is a local personal tool using Codex's app-server account interface, not a hosted service. It respects each account's reported limits and does not purchase credits or resets. Authentication: https://learn.chatgpt.com/docs/auth. Account protocol: https://learn.chatgpt.com/docs/app-server.

## Development

```sh
npm test
```

The 17 automated tests cover scheduling, quota handoffs, conversation continuity, chat isolation, mode permissions, bounded context, and saved-request retries. Automated tests do not consume real account usage. A minimal real Ask request has also been verified through the native UI.

Optional environment variables: `CODEX_FLOW_HOME` changes the private data folder; `CODEX_FLOW_CODEX` selects a Codex executable. Account settings can be customized separately in `~/.codex-flow/accounts/a/config.toml` and `b/config.toml`. Keep `cli_auth_credentials_store = "file"` so logins stay isolated. Existing desktop settings/plugins are not copied.

## Account scheduling

The UI and worker now share a receding-horizon scheduler. It estimates productive work in your next 180-minute block, a 120-minute break, and another 180-minute block. The current block gets weight 1; the next block gets weight 0.5. It searches schedules in five-minute steps using a diverse beam of 48 states, charges two estimated minutes per context switch, and penalizes starting on an account that cannot cover a 15-minute request. A tiny remaining-capacity tie breaker preserves reserve. These are explicit policy assumptions, not a mathematical guarantee of global optimality.

Each account/window's remaining percentage is converted into estimated work minutes using its own observed consumption rate. Samples come from live usage before and after work, only when account, plan and reset timestamp match and measured work lasts at least 15 seconds. Recent samples receive more weight. Zero/negative deltas and reset-crossing samples are ignored. Measurements may include unrelated activity on the same account and rounding; workload and model changes can invalidate predictions. The dashboard marks estimates as learning-based only after three samples for every pool on the selected account.

Before measurements exist, every pool uses a conservative placeholder of 90 work minutes at full capacity. A monthly window is not presumed to hold more work simply because it resets less frequently. These are cold-start priors, **not claims about plan entitlements**, and are replaced by per-account measurements. In particular, Plus and Go percentages are not treated as known equal capacity. Learning data stays in `~/.codex-flow/usage-learning.json`.

Only the next reported reset of each pool is simulated. Unknown, expired or later speculative resets are not invented. Actual availability is freshly read before every real task or handoff; projected resets never authorize work. There is no forced mid-task switching. The app displays the current recommendation and reason, then recomputes at Start. Recommendations can differ after a refresh or a change in project context.

Scheduler tests cover soon-expiring allowance, low-quota interruption risk, weekly bottlenecks, differently sized learned plan allowances, learning across resets, invalid data, exclusions, and deterministic decisions, alongside the existing end-to-end handoff tests.


## Exact desktop scheduling update

The installed Codex++ router now uses HiGHS instead of the earlier beam search. See [the exact guarantee, model, tests and activation instructions](docs/EXACT-SCHEDULER.md). The app update takes effect after quitting and reopening Codex++; the current turn is preserved.
