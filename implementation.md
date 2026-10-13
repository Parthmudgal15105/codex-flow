# Codex Flow implementation

## Goal
Manage two personal Codex subscription accounts in one terminal workflow with usage-based account selection and continuity in the same coding project. No break notifications.

## Decisions
- First iteration is a local Node.js CLI, with no dependencies or API keys.
- Two independent CODEX_HOME directories preserve the existing desktop login.
- Fresh app-server rate-limit reads determine availability; unknown data cannot select an account.
- One noninteractive Codex worker at a time, workspace-write sandbox.
- Shared implementation.md plus actual project files transfer context; conversations resume separately for each account.
- Switch only on explicit usage exhaustion, after the prior process closes. Each account is attempted once per request.

## Completed
- Account login, live status, preferred-account selection, and weekly-limit checks.
- Persistent conversations, milestone-note instructions, partial-work handoff.
- Project locks, local private event history, saved pending request recovery.
- Installed the codex-flow terminal command with npm link.
- Real installed app-server smoke check correctly reports new profiles signed out.

## Checks
Run npm test. Tests use a fake Codex process for quota handoff and continuation; no real inference requests are made.

## Remaining setup and limitations
- User must log into accounts A and B. Real authenticated handoff remains unverified until then.
- Usage refresh occurs between requests and with /status, not during a running worker.
- Milestone note updates are model instructions, not guaranteed transactional saves.
- Native SwiftUI desktop dashboard implemented; native Codex desktop chats are still separate.
- Sandbox-restricted setup commands may need manual handling.

## Next steps
Validate with two authenticated accounts and a small disposable Git project; then consider a live usage display and richer interaction if useful.

## Native UI iteration
- Replaced the AppleScript Dock launcher with a signed local SwiftUI app using the same bundle identity and existing account credentials.
- Account cards show reported windows, plan, remaining allowance and local reset dates; refreshed every minute.
- Project picker, remembered project, task editor, streamed activity, stop, saved-request continuation, account sign-in, and project notes.
- Added status --json for the native bridge.
- Verified native compilation/signature, real authenticated usage display for both accounts, project-picker open/cancel, and six passing backend tests. No real coding task or quota exhaustion induced for UI verification.

## Scheduling iteration
- Replaced preference-first account selection with a finite-horizon beam-search scheduler in src/optimizer.js. Both dashboard and task execution use it.
- Evaluates two 3-hour blocks around a 2-hour break, remaining per-pool work capacity, next reported reset, switching costs, and first-request interruption risk.
- Per-account/per-plan learning records actual usage deltas across matching reset windows after each worker; publishes JSON atomically so status readers cannot see incomplete files.
- Starter assumptions and forecast limits documented in README; no claims of guaranteed optimality or equal quota across plans.
- Added recommendation badges and plain-language explanation to the native window.
- Thirteen tests passed, including learned cross-plan capacity and simulated quota handoff.


## Conversation workspace iteration
- Replaced the dashboard-first screen with project/conversation sidebar, chat replies, Markdown/code blocks, expandable command output and compact account controls.
- Read-only Ask and workspace-write Build modes; per-mode sessions avoid inheriting execution permissions from another mode.
- New structured JSONL bridge (ui-run) with per-chat transcripts, partial-work handoffs, retry/stop, and incremental shared context. Existing terminal commands remain available.
- Recent-project discovery, new Git projects, remembered chats/drafts/mode, rename/archive/restore, attachments, project notes, file search, source/image/PDF previews, Git change review scoped to the selected folder, HTML/SVG and website preview.
- Preserved existing account logins and Dock identity. Official Codex desktop chats remain separate; native desktop plugin/approval integration is not included.
- Seventeen automated tests passed. Real Ask request returned FLOW_UI_OK in the UI with no project edits. Verified history after restart, file-row selection, and SVG chart rendering. Simulated account exhaustion only; real exhaustion was not induced.

## Exact scheduler iteration, 11 October 2026
- Replaced the rounded 48-state beam with local HiGHS MILP solves, zero requested MIP gap, independent feasibility checks and certified lexicographic switch minimization.
- One-minute grid plus exact reset events; switching overhead spans intervals, all quota resources constrain work, and past resets never fabricate capacity.
- Desktop learning persists turn-consumption rates and acknowledged switching time; rejects contaminated overlapping measurements and excludes refresh delay.
- Session clock retains elapsed work; async solver avoids blocking the main process. Automatic mode keeps its last account instead of redundant default restoration.
- Regression suite and 80 independent exhaustive scheduling scenarios pass. Packaged quota routing tested with the bundled runtime. Exact scope and non-predictable real-world limitations are documented in docs/EXACT-SCHEDULER.md.
- Updated app activates on the next quit/reopen; running turns are not terminated. Prior bundle retained for rollback; original official app unchanged.
