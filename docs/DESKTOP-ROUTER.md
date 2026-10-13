# Codex desktop account router

Installed app: `/Users/parthmudgal/Applications/Codex++.app`.

This replaces the separate-chat-interface approach with an independently installed copy of the existing desktop app. It uses Codex++ (https://github.com/ugarchance/codex-plus-plus), pinned at `b05ded31526690dec5c70c86a490e1a17a44a3a0`, with local compatibility and routing changes. The original `/Applications/ChatGPT.app` is unchanged.

## Use

1. Open Codex++.app from your Applications folder (inside your home folder).
2. Continue an imported local chat or choose your existing project folder.
3. Leave automatic routing enabled. Unpinned chats check current usage before each message. Choosing an account in the chat header pins it; choose Automatic to allow routing again.
4. Compose text and attach images using the desktop app's existing composer. Replies, file changes, and previews remain in that interface.

Both saved accounts are connected and currently report Plus. No additional subscription was purchased. No API billing credentials are used by the account probe or continuity test.

The installed app has a private home at `~/Library/Application Support/CodexPP/codex-home`. Existing local history/projects/settings were imported as a snapshot. Subsequent messages and settings do not synchronize back to the original desktop app or the older Flow interface. Project source files are the same real folders, so edits are shared. Use one interface for ongoing conversations; avoid running the older Flow account poller alongside the new app, because copied OAuth refresh sessions can conflict. If authentication becomes invalid, use Add another subscription to sign in again.

## Routing

Before each unpinned message the app refreshes quota when its snapshot is older than a minute, rejects unknown/stale or exhausted accounts, and simulates the current three-hour work block, a two-hour break, and the next three-hour block. Both short and weekly windows constrain capacity. Current-account preference and switching costs discourage unnecessary switches. Future task cost is unknown; this is an estimate with starter usage assumptions, not a proven global optimum.

Explicit account pins are honored. Accounts cannot switch while another account has a running turn; that conflict stops submission instead of silently consuming the wrong account's allowance. A limit reached during a turn still uses the existing failover banner; automatic replay of partially executed coding instructions is deliberately not added.

## Compatibility and verification, 11 October 2026

Source desktop version: 26.1007.30912 (20156).
Source app.asar SHA-256: `75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`.

Upstream patch check matched 26/27 patches. Optional profile avatar-stack patch 111 was incompatible and omitted. Patch 096, which bypasses the desktop native-pipe peer authorization check, was also omitted. Native computer/browser integrations requiring that check may therefore be unavailable in the independently signed copy; they are not verified. The copied CodexCLI.app and native Computer Use runtime retain their vendor signatures. The copy's archive integrity metadata and application signature have been rebuilt and verified.

Live account-engine test: B -> A -> B on the same conversation; the final B turn recalled an invented phrase from the first B turn. Both account identities were confirmed through account/read. This proves engine-level conversation continuity; it does not prove UI navigation stays stable through every switch.

Automated checks cover history snapshot isolation (9), existing routing policy (57), per-chat pins and switch locks, every-message automatic routing, unknown quota rejection, five-hour exhaustion, and header registration. The existing Flow test suite also passes (17/17).

A live test using the copied engine accepted a local image, correctly described the icon, and executed a terminal tool to create an exact-content file inside an isolated test project. The file was independently checked. The initial read-only test correctly rejected writes; supplying the documented per-turn workspace-write policy allowed the coding test to pass.

The computer-control tool refused interaction with Codex. Therefore visual startup, clipboard image paste, and sidebar navigation have not been certified end to end. Do not present the installed candidate as a fully visually tested production release.

## Maintenance

Local source: `vendor/codex-plus-plus`. `docs/codexpp-local-changes.patch` records tracked upstream changes; `scripts/customize-desktop.py` generates the Flow scheduling adapter. Account backups are private under `~/Library/Application Support/CodexPP/backups`; no credentials belong in this repository.

The copy does not auto-update. After an official app update, rerun the patch compatibility checks and adapt before rebuilding. Do not silently install an untested update. Original app and older Flow remain available for rollback; their histories are independent of the new copy after import.


## Startup crash repair

The initial installed build crashed before JavaScript bootstrap with `Failed to get integrity for validatable asar archive: Resources/app.asar`. A valid code signature and matching ASAR header hash in Info.plist were insufficient: framework version 155 also contains a 66-byte `__DATA_CONST,__asar_integrity` section binding the entire integrity dictionary.

`tools/update-mac-framework-integrity.py` now validates the source framework's dictionary digest, checks the destination slot, and updates only its 32-byte digest. The framework and application are then signed in order. Integrity validation remains enabled; the original app is not modified. The installer performs this step after updating the ASAR header hash and before signing. The approach is corroborated by https://github.com/L1ulee/codex-speed-patch/blob/main/internal/platform/asar_integrity.go .

Cold-start checks are recorded in `docs/startup-test-results.json`. They verify a live main process, primary-window ready-to-show, successful Codex engine initialization, and absence of fatal startup errors. These checks do not inspect the rendered interface or test clipboard paste.

Repaired build: five consecutive cold launches passed, each remaining alive through a ten-second startup observation with primary-window-ready and Codex engine initialization confirmed. Both app signatures and both integrity dictionaries were rechecked.

## Exact scheduler update

The routing section above describes the previous approximate search. It is superseded by [EXACT-SCHEDULER.md](EXACT-SCHEDULER.md): solver-certified mixed-integer scheduling, one-minute grid plus exact reset events, anchored session timing, desktop consumption/switch-time learning, complete quota buckets and no automatic default-account round trip. Both work blocks now have equal weight. See that document for the precise guarantee and remaining uncertainty.

## Pause during account routing, 12 October 2026

A deterministic regression reproduced a cancellation race: `turn/start` waited
for automatic account selection or login, `turn/interrupt` reached the engine
first, and the waiting old submission still started afterward. Patch 093 now
tracks pending submissions before routing and invalidates them on interruption
of that thread. Cancellation is checked before preparation, after selection,
after login, and before dispatch. A rejected duplicate start also no longer
clears the running mark owned by another submission.

Regression checks pass for stopping during account selection and login, no old
prompt dispatch, exactly one dispatch containing the next prompt, and retained
running-turn ownership. The Flow suite passes 33/33. The account-isolation
script's routing cases pass; its separate hub mock has an existing missing
`store.userDataDir` stub and does not pass as a whole. No live UI pause/restart
test is claimed. The signed installed app includes the fix; activation requires
quitting and reopening Codex++. The installer preserved the running session and
backed up the previous app; see `exact-installation.json` for the backup path.

## Remove inactive header account picker, 12 October 2026

Removed the custom Account B header dropdown at the user's request. Patch 095
is excluded from future builds, and its HeaderAction registration was removed
from the installed archive. Automatic routing and the prior pending-submission
cancellation fix remain installed. The modified asset passed JavaScript parsing,
the installed registration is absent, and the rebuilt app passed signature
verification. The running session was preserved; restart the app to activate.

## Spotlight and model catalog repair (2026-10-13)

The Dock continues to use `~/Applications/Codex++.app`. Rollback bundles now use
`.app-backup`, and existing backups live in `backups.noindex` with a compatibility
symlink at `backups`. Run `python3 scripts/hide-app-backups.py` after migrating
older installers. Restore a rollback bundle by copying it to the main `.app`
path while the app is closed; do not launch backups directly.

The Web integration previously injected `model_catalog_json` from an old private
cache, freezing native model discovery. Engine startup now sets only the local
gateway URL; authenticated model refresh supplies native rows plus the Web
metadata through the gateway. An isolated request using the private account
returned `gpt-6.1-sol`. The real bundled engine also listed GPT-6.1 and Web models
against a fixture gateway. Four routing/catalog tests and strict code signature
verification passed. The installed fix activates after quitting and reopening.

This repairs model discovery; the custom app still requires a compatible rebuild
when the official desktop application itself updates.
