# Exact scheduling, 11 October 2026

The scheduler now uses the local HiGHS 1.15.3 mixed-integer solver instead of a beam search. It accepts a route only when every candidate solve and its switch-count tie-break finish with `Optimal`. Timeouts, solver errors, missing/stale quota, invalid inputs and exhausted accounts do not produce an allegedly optimal route.

## Earlier-reset selection repair, 12 October 2026

The reported snapshot had A at 98% short-window / 64% weekly remaining and B at 14% / 67%, with A resetting about an hour before B. The previous decision scored B at 214.989 modeled minutes and A at 211.989. Replaying the same inputs showed that both routes actually provided 214.989 productive minutes: A's two-minute initial switch also incurred a three-minute continuity penalty, despite its ample current allowance. After removing that double charge, both objectives are equal and the declared earlier-reset tie-break selects A. Weekly capacity remains a simultaneous constraint; this is not a highest-percentage or unconditional earliest-reset rule.

The `finite-horizon-v3` certificate records the global best objective and the selected route's gap. Decision scores additionally expose productive minutes, quota shortfall and the next reset countdown. [Packaged validation](scheduling-fix-validation.json) records the reproduced snapshot and result. All 49 tests pass, including 80 seeded exhaustive instances (160 first-account comparisons); all 13 packaged adapter checks pass. The app's bundled Node runtime independently selects A from the frozen snapshot without switching the live account.

## Exact guarantee

For the **specified finite model**, the selected first account achieves the maximum objective to numerical tolerance (1e-5 modeled minutes). Among routes within that tolerance of the same global optimum, it prefers the first account with the earliest reported reset that has remaining allowance and falls within the planning horizon. It then minimizes account transitions, prefers the already-active account, and finally uses a deterministic account identifier. Deadline priority cannot override a greater modeled work objective.

The desktop objective is productive minutes over a rolling eight-hour continuous work horizon, minus 1.5 times any quota-related productive-minute shortfall in the first 15 minutes. Initial switching time reduces available productive time once; it is excluded from the continuity target so that switching does not also incur a quota-shortage penalty. The 15-minute commitment is a continuity preference, not a prediction of the actual prompt's length. Solver options can change the blocks, their weights, commitment, penalty, switching cost and grid resolution.

The model allows account changes on a one-minute grid **and at every exact reported reset boundary**. Work amounts within an interval are continuous. A transition's overhead can span multiple short intervals; it is never rounded down at a reset. A switch prepared during the two-hour break consumes no working time. A reported quota reset replenishes only that resource, once. Unknown/past resets do not grant extra capacity, and future recurring resets are not invented.

Every reported quota bucket is a separate simultaneous constraint. A unit of productive work consumes all of its account's relevant pools at that pool's estimated rate. Currently blocked accounts can contribute after a known future reset, but cannot be selected for the current request. Work and switching cannot consume break time as productive minutes.

## Why the model is globally solved

For each account and time interval there is a binary active-account variable, a binary transition variable and a nonnegative productive-work variable. Exactly one account is active in each interval; productive work is bounded by that account's active duration. Transition variables equal actual changes from the preceding account, and interval capacity subtracts the overlapping switching time. For every quota pool, separate inequalities bound work before and after its reported reset. The chosen first account is held during the configured commitment interval. A shortfall variable implements the continuity penalty after deducting initial switch overhead from its target.

Every admissible model schedule maps to these variables. Conversely, the variables map to a schedule with a constant account within each interval and sufficient time for its productive work after switching overhead. Quota and time inequalities establish feasibility. Exact transition constraints prevent fictitious switches from relaxing the continuity requirement. For each eligible first account, the primary solve maximizes its objective and the secondary solve minimizes transitions while preserving that optimum. Enumerating all first accounts finds the global optimum **over this model**. Comparing reset deadlines only among routes within 1e-5 of that global optimum implements the declared ordering without a heuristic reset bonus or a pairwise floating-point comparator.

HiGHS uses floating-point arithmetic. Its `Optimal` status with zero requested absolute/relative MIP gap is a solver certificate within numerical feasibility tolerance, not a machine-checked symbolic proof. Returned quota allocations, work bounds and objectives are checked independently in code. Independent exhaustive tests cover 80 seeded small instances, comparing both the objective and the minimum number of switches (160 first-account comparisons).

## Improved inputs and execution

- Desktop replanning uses a rolling eight-hour continuous work horizon. No breaks are assumed or enforced.
- All reported quota buckets, server-reported blocked states, workspace identity, exclusions and persistent auth failures are respected. Probe subprocesses do not inherit API billing credentials.
- Fresh usage is requested before routing. Snapshots at least 60 seconds old, future timestamps and failed refreshes are rejected.
- Completed turns feed persisted per-account/per-plan/per-pool usage rates back into planning. Refresh latency is excluded. Overlapping turns invalidate attribution rather than producing a misleading measurement. Reset crossings, invalid durations and zero/negative usage deltas do not teach a rate.
- Acknowledged account changes teach switching duration; planning uses the recent 80th-percentile observation, with the previous conservative two-minute assumption until measurements exist.
- Automatic mode retains the last-used account after completion instead of restoring the default and switching out again on the next message. Explicit pins and manual mode remain supported.
- Optimization runs in a separate process, so the desktop main event loop stays responsive.
- Every successful desktop choice writes its certificate, assumptions, scores and account ID to `~/Library/Application Support/CodexPP/flow-last-decision.json`. No credentials are included in this diagnostic.

## Limits that no scheduler can remove

This does not prove maximum real-world productivity. Future prompt cost, model choice, context growth, tool delays, external account usage, future availability and actual task duration are not known in advance. Learned rates estimate those costs; until measurements exist they use the conservative original starter rate (100% per 90 work minutes). A highly uncertain forecast can be exactly optimized and still predict poorly.

The certificate covers the stated horizon, grid and continuity preference. It does not cover unrestricted continuous switching times, an infinite working week, or every possible future workload. The model re-solves before each request; it never interrupts/replays an already-running coding turn. Exhaustion during a turn still needs the existing failover flow. Model-specific entitlement failures remain runtime failures, rather than facts that quota percentages alone can predict.

There are infinitely many possible inputs, so no finite suite covers literally every test case. The independent oracle, resource validation and explicit model formulation complement the regression tests.

## Validation and activation

`npm test` exercises solver/oracle agreement, reset boundaries, blocked-future capacity, malformed inputs, async responsiveness, session timing, switching across short intervals, usage learning, concurrent-attribution rejection, every exclusion form, multiple quota buckets, existing handoff behavior and history isolation.

The packaged scheduler was also tested with the app's bundled Node runtime and fresh quota reads from both signed-in accounts. The installed adapter audit checks exhausted windows, stale/failed reads, exclusions, permanent/transient failures, certificate status and credential omission. Desktop thread tests check pins, running-turn locks, per-message routing and avoiding redundant restoration.

The updated app is installed at `/Users/parthmudgal/Applications/Codex++.app`; the preceding bundle is retained under `~/Library/Application Support/CodexPP/backups`. Quit and reopen Codex++ after the current conversation finishes to load the new scheduler. This update does not terminate the running app or current coding turn. The original `/Applications/ChatGPT.app` is untouched.

Visual interaction remains outside this certification: computer control of Codex was refused by the tool. Clipboard paste, sidebar rendering and live UI switching have not been newly certified by these solver tests.

Solver references: https://highs.dev/ and https://github.com/lovasoa/highs-js .


## Automatic window activation and continuous work

The desktop router now plans a rolling eight-hour continuous work horizon, with no assumed two-hour break. The solver still uses only reported reset boundaries; it does not invent future recurring resets.

The central scheduling entrypoint (`flow-routing.schedule`) prepares account windows before solving. When a message is prepared with automatic routing enabled, the router refreshes both accounts. An eligible account with a reported five-hour bucket at exactly 0% usage receives one short, isolated request before the user task is routed. This also runs for pinned chats while automatic routing is enabled globally. The model replies `OK`; the request runs in a temporary, read-only, ephemeral thread and does not switch the active app engine. It prefers the available GPT-6 Luna model, otherwise the account's default model, at standard speed. It consumes a small amount of the normal allowance.

Zero usage does not prove a window is dormant: the service may round small usage down or already report a reset time. After completion, the router reads the actual limits again and records the reported reset and usage. It does not promise identical resets or assert that every request changes a reset time.

The private ledger `~/Library/Application Support/CodexPP/flow-window-activation.json` records attempts before sending. Duplicate messages and restarts cannot repeat an activation within five hours of that identity's attempt, including failures and uncertain completion. Busy accounts, failed/stale usage reads, unknown/exhausted quota buckets and ineligible/excluded accounts are skipped. Disabling Automatic routing disables activation. Checks occur when sending messages; there is no timer spending quota while the app is idle.

Validation: `node --test test/window-activation.test.js test/activation-probe.test.js`; `node scripts/verify-window-activation.cjs` performs the authorized live activation with credential backups and emits sanitized before/after usage to `docs/window-activation-validation.json`.
