# Review: F5 (snapshot and restore)

Subagent report: split database and build keys (D-009), atomic cache writes, 3 entries kept per kind, restore of a 46.5 MB data directory in 157 ms vs migrate+seed 911 ms plus the save on the fixture; build restored in 8 ms vs ~4 s of `tsc`. Integrated by the lead (87e31be, one conflict in `src/stack.ts` resolved by keeping both the F4 `postgresVersion` and the F5 `cache` fields); report wiring and acceptance finished by the subagent in the main tree (results at the end).

## What could be wrong

- **Keys can miss real inputs.** The database key hashes `cache.inputs`; if a repo's seed reads a file not listed there (a JSON fixture, a CSV), a changed seed restores a stale database. `init` must list inputs generously; the fixture lists its migrations and both scripts. The build key in git mode covers every tracked and untracked-not-ignored file, which is safe; with `build.inputs` it is only as good as the list.
- **Timings shift between phases.** The cache save is booked inside `build` and `migrateSeed` (the f6 test forbids new phase names), so a cold run's `migrateSeed` includes a Postgres stop/copy/restart (~420 ms on the fixture). Harmless for Experiment A (the verdict uses the test phase only), but the cold-vs-warm cache effect must be computed from wall time, not from `migrateSeed` alone.
- **`fs.cpSync` creates directories 0755**, which Postgres rejects; the subagent restores modes by hand. A future Node change here would surface as "data directory has invalid permissions" at startup, loudly.
- **Concurrent runs saving the same key** can race on the final rename; one run fails. Not relevant to the experiments (runs are serial) but a real limitation for a CI machine running two jobs in one checkout.
- **Process hygiene incident.** The subagent once used `pkill -f 'dist/src/cli.js app up'`, which could have hit another agent's run. None was running; it switched to PIDs. Noted because timed experiments must not share the machine with anything that signals by pattern.

## What was not tested

- A corrupted cache entry (the fix is deleting `.isolate/cache`; not automated).
- Non-root and macOS.
- A repo whose build output is outside the repo (the cache refuses to cache it, by design).

## What was assumed

- That a Postgres data directory copied while the server is cleanly stopped is a valid cluster (true for a clean shutdown).
- That `postgres --version` plus `process.arch` is enough to guard portability (major version is inside the version string).

## Lead's run on the main tree (09:42-09:48 UTC, after the report wiring patch)

- `just e2e-one f5-snapshot`: pass twice (55.0 s, 43.0 s). Build, migrate and seed each ran exactly once across the two runs (side effects counted outside the tool); the second report has `cache.hit: true`, a `restore` phase, no `build` or `migrateSeed` phase.
- `just e2e-one f4-run`: pass (171 s). `just e2e-one f6-report`: pass (46 s).
- The subagent could not edit the main tree (worktree isolation); it sent its report-wiring change as a patch, which the lead read and applied as-is.
- Verdict: accepted.
