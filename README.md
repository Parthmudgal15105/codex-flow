# Codex Flow

A local Mac workspace for building with the Codex CLI. Keep project conversations, Ask/Build modes, files, changes, and account usage together.

[Project website and early-access updates](https://codex-flow-waitlist.vercel.app)

This repository contains the standalone CLI and native Mac workspace. It does not include a patched copy of the official Codex desktop app. The project is independent of OpenAI.

## Requirements

- macOS 14 or later for the Mac app.
- Node.js 22 or later, npm, and Git.
- A working [Codex CLI installation](https://developers.openai.com/codex/cli), available as `codex` on your PATH. Developed against CLI 0.157.1; the account/app-server interface may change between versions.
- Two ChatGPT accounts you are authorized to use, signed in through the CLI's normal login flow. Existing account limits still apply.
- Xcode command-line tools to build the Mac app: `xcode-select --install`.

The CLI uses Node.js and may work on other systems, but Linux and Windows have not been verified. The graphical app is Mac-only. There is no prebuilt signed/notarized release yet.

## Install from source

```sh
git clone https://github.com/Parthmudgal15105/codex-flow.git
cd codex-flow
npm ci
node --version
codex --version
npm link
codex-flow login a
codex-flow login b
codex-flow status
```

Each login opens the normal Codex sign-in flow. Sign in with a different account for each slot. Credentials stay in separate local account folders; your regular Codex login is not overwritten. An API key is not required by this workspace.

To avoid `npm link`, substitute `node src/cli.js` for `codex-flow` while in this repository.

## Build and open the Mac workspace

```sh
zsh macos/build.sh
open "$HOME/Applications/Codex Flow.app"
```

The build records the Node, Codex and source paths from your machine. Keep the cloned repository in place; rebuild after moving it or changing your Node installation. This is a locally built app with an ad-hoc signature. It has not been notarized or packaged as a standalone redistributable application.

Choose **Open project** or create a project folder. Start a conversation, then:

- **Ask** investigates and plans with a read-only worker.
- **Build** edits the project and updates shared `implementation.md` notes.
- Review **Files**, **Changes**, and **Preview** before continuing.
- Use **Accounts & usage** for usage and reset information.
- **Stop** interrupts the active request; **Retry** checks partial work before retrying it.

A website preview needs an already-running development server. The app does not automatically start it.

## Use the CLI

Create or choose a local Git project, then run:

```sh
codex-flow start /absolute/path/to/your/project
```

Enter your coding request. Use `/status` to refresh account usage, `/quit` to leave, and Ctrl+C to stop. A single request can also be supplied:

```sh
codex-flow start /absolute/path/to/your/project "Review the settings screen"
```

If both accounts are unavailable, the request is saved locally. Resume later with:

```sh
codex-flow continue /absolute/path/to/your/project
```

## How routing works

Flow reads reported account availability and chooses an eligible account. A recognized quota failure can hand unfinished work to the other account after checking partial results. Shared files and project notes support continuity. The exact scheduler uses HiGHS to optimize an explicit planning model; consumption and future availability remain estimates. It does not add quota, guarantee uninterrupted work, or change your account entitlements.

Conversation transfer is bounded. Very old discussion may need a summary in project notes. Official Codex desktop conversations are separate and are not imported here.

## Local data and limitations

Account credentials, session history, prompts, saved requests and usage-learning data live under `~/.codex-flow`. Treat that folder as private. Never commit it. Project notes live inside the selected project; review them before sharing. Set `CODEX_FLOW_HOME` to change the data folder and `CODEX_FLOW_CODEX` to select another CLI executable for CLI use.

Workers use Codex's workspace-write sandbox. Interactive command approvals, native desktop plugins and cloud conversation synchronization are not implemented. Commands needing additional permissions may require manual setup. Project locks cover Flow workers, not unrelated editors or other Codex instances. This is experimental software; review changes and keep backups of important work.

## Verify

```sh
npm test
```

Tests use mocked account/worker processes and do not consume live account usage. They cover routing, scheduling, quota handoff, conversation continuity, project isolation and saved-request recovery. Building the Mac app checks compilation; live sign-in and hardware-dependent interface behavior still need verification on your own device.
