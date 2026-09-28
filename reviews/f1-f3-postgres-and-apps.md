# Review: F1 (Postgres manager) and F3 (app process manager)

Subagent report: `f1-db` and `f3-app` green twice each; root handling via `setpriv` as the `postgres` system user; reaper + `ISOLATE_RUN_ID` sweep; copies 40-48 ms each on the fixture. Lead read the full diff (22 new files, ~1100 lines) and re-ran both acceptance tests on the merged code (results at the end).

## What could be wrong

- **Explicit `postgres.binDir` was ignored when embedded-postgres is installed** (lookup order followed the spec literally). Sent back; now `binDir` wins.
- **Peak RSS over-counts Postgres.** It sums RSS over the process tree, so shared buffers are counted once per backend. The number is an upper bound and RESULTS.md must say so (or use PSS from `/proc/<pid>/smaps_rollup`, which is Linux-only).
- **`cloneDatabases` terminates connections to `seed` once, then copies sequentially.** If anything reconnected to `seed` between copies (nothing does today: migrate/seed have exited), `CREATE DATABASE ... TEMPLATE` would fail with "source database is being accessed by other users". Copies are sequential by design (Postgres serializes template copies anyway), so N=8 costs 8 × ~45 ms.
- **`shared_buffers` = 25% of RAM (capped 2 GB) with the data directory itself in RAM** double-counts memory: pages live in /dev/shm and again in shared buffers. On a 16 GB laptop running 8 apps + 8 Chromiums this could matter. Not a correctness issue; revisit if memory at N = 8 is tight.
- **Zombie reaping by pid 1 is slow in this sandbox** (~2 s), so "no survivors" checks can pass late rather than never. Inside the test's 10 s budget; noted.
- **The reaper polls every 500 ms**; a crash between a spawn and its `trackGroup` call leaves a tiny window where a group is not recorded. The `ISOLATE_RUN_ID` sweep closes it on Linux (the marker is in the environment from the first instruction).

## What was not tested

- macOS and non-root runs (no `setpriv`, `/tmp` data directory, no `/proc` sweep).
- System Postgres binaries as the source (embedded 18.4 was always found first).
- A migrate command that leaves a connection open to `seed` after exiting (e.g. a daemonized helper).
- N > 4 (the fixture test uses 4 and 2).

## What was assumed

- That `setpriv` exists wherever isolate runs as root (it is in util-linux, present on Debian/Ubuntu/Fedora images, but not on Alpine/busybox by default).
- That `{db}` in `app.env` means the worker's database URL (confirmed by the lead; documented in the README).
- That the build belongs to `app up` and `run` but not to `db up` (a database-only stack does not need the app built).

## Lead's re-run (merged code, a861b86)

- Sent back once: `postgres.binDir` now wins, and a `binDir` without `initdb` and `postgres` fails loudly.
- `just e2e-one f1-db`: pass (2.6 s). `just e2e-one f3-app`: pass (14.7 s), including the SIGKILL-of-parent case.
- Verdict: accepted.
