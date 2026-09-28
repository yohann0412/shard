# Review: F4 (Playwright integration, `isolate run`) and F6 (timing report)

Subagent report: `f4-run` green once on the real stack; f6 scenario, invalid-routing case, SIGINT handling, `-c`/`--reporter`/`--workers` handling rehearsed on a scratch copy; `--baseline` not demonstrated green because another agent's server held :3000. Lead read the diff (~1500 lines: src/playwright/*, src/report/*, src/session.ts, two commands, small additions to stack/apps/databases) and re-ran f4, f6, f1, f3 on the merged code (results at the end).

## What could be wrong

- **Routing check can pass when it should fail.** `xact_commit` on w<i> also grows from the worker's own test-side database traffic (a test that seeds through Prisma with `DATABASE_URL`, which the env module points at w<i>). An app that ignores `DATABASE_URL` would then go unnoticed if its tests also write directly. The fixture's tests never touch the DB directly, so the e2e case cannot see this. A stronger check (which backend PIDs belong to which app, via `pg_stat_activity.client_port` joined to `ss`) is designed in PLAN_REVIEW but not built; RESULTS.md must state the limitation.
- **The check polls up to 11 s** for statistics to flush. That is honest (Postgres defers stat flushes) but adds up to 11 s to an invalid run and ~0 s to a valid one; it is inside the `teardown`-adjacent phase, not `tests`, so it does not distort the test phase.
- **`--reporter X` is moved from the command into the wrapper.** Semantically equivalent, but if a repo relies on a reporter's CLI-only options this could differ. Low risk.
- **`.git/info/exclude` entries are left behind** (two anchored lines). Harmless and intentional (worktrees share the file), but it is a write outside `.isolate/` that users might not expect; README should say so.
- **Interrupted tests count as skipped.** A run cut by the 45-minute cap would under-report failures; the harness records "exceeded cap" separately, so the report is not the source of truth for capped runs.
- **Each test is counted by its last attempt.** With `--retries=0` in every timed arm (PLAN §5) this changes nothing; with retries, a flaky test counts as passed in totals and shows up as `flaky` from the reporter's `ok` field. Consistent with Playwright's own summary.
- **Baseline mode cannot stop Playwright from reusing a stray server on :3000** (`reuseExistingServer: !CI`). The harness must check the port and run every arm with `CI=1` (which flips that option to false in most configs, including the fixture's).

## What was not tested

- Playwright versions other than 1.56.1; `.js`/`.mjs` repo configs; repos whose config exports a function or a promise.
- A repo whose tests connect to the database directly (see the first bullet).
- `--baseline` passing green end to end (lead runs it below).
- macOS.

## What was assumed

- That appending a reporter never changes test behaviour (reporters only observe).
- That `TEST_PARALLEL_INDEX` < `workers` always holds (the env module throws otherwise, loudly).
- That `pg_stat_database` counters are per-database and survive for the life of the server (true; they reset only on `pg_stat_reset`).
