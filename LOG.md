# Log

Running log of what was tried, what failed, and what was learned, in order. Times are UTC.

## Resumes

Rate-limit resumes used: 0 of 4 (no resume after 2026-09-28 12:00 UTC).

## 2026-09-28

**07:59 Environment probe.** Cloud sandbox VM: Intel Xeon @ 2.80GHz, 4 vCPU, 15 GB RAM, 16 GB `/dev/shm`, ~30 GB free disk, Linux 6.18, Node 22.22.2, pnpm 10.33.0. Postgres 16.13 system binaries under `/usr/lib/postgresql/16/bin`. Chromium revision 1194 pre-installed at `/opt/pw-browsers` (matches Playwright 1.56.x). `just` is not installed; `npm i -g rust-just` gives just 1.57.0. Network: `git clone` of public GitHub repos works; raw.githubusercontent.com works; npm registry works; the GitHub REST API is scoped to this session's own repository (search endpoints return 403 "sessions are bound to their configured repositories"); github.com HTML pages, sourcegraph, grep.app and ecosyste.ms are blocked by the egress policy. Consequence: the harvester cannot use GitHub search and will use awesome-selfhosted-data (daily-refreshed star counts) plus the seed list and shallow clones.

**08:05 embedded-postgres check.** `embedded-postgres@18.4.0-beta.17` installs `@embedded-postgres/linux-x64` with `initdb`, `pg_ctl`, `postgres` (PostgreSQL 18.4), no `psql`. So the tool needs the `pg` driver for SQL.

**08:10 F4 mechanism, throwaway experiment (scratchpad, not committed).** Playwright 1.56.1, 4 tiny HTTP servers on ports 4100-4103, a "repo" config with `baseURL: process.env.BASE_URL ?? ...` and a `webServer` that would exit 1 if started, 3 spec files x 4 tests, and a wrapper config that imports a side-effect module then the repo config.
- Reading Playwright's source first: `lib/worker/workerMain.js` sets `process.env.TEST_PARALLEL_INDEX` in the `WorkerMain` constructor, i.e. after the worker process has started, and loads the config afterwards in `_loadIfNeeded()`.
- Observed: a `--require` preload in the worker sees `TEST_PARALLEL_INDEX=undefined`. **The spec's literal mechanism does not work.**
- Observed: the wrapper config's side-effect module runs inside each worker with `TEST_PARALLEL_INDEX` set (0, 1, 2) and sets `BASE_URL` before the repo config is evaluated; the repo config then logs the per-worker `BASE_URL`. All 12 tests passed; each test saw `baseURL` and `process.env.BASE_URL` equal to its worker's server; server request logs: 4/4/4 requests on 3 servers (3 files, not fully parallel, so 3 workers). `webServer` was not started.
- Same with `"type": "module"` and `--fully-parallel`: 12 passed, 3/3/3/3 requests across all 4 servers, zero mismatches.
- Patching `WorkerMain.prototype._runTest` from the preload (resolved from `process.argv[1]` = `playwright/lib/common/process.js`) gives begin/end hooks around every test in every worker (24 hook lines for 12 tests). This is what tracing will use.
- Decision recorded as D-001. The preload stays, for tracing only.

**08:20 Harvest source check.** `awesome-selfhosted/awesome-selfhosted-data` clones fine: 1351 entries, 1153 with `stargazers_count`, 229 tagged `Nodejs`, refreshed today.

**08:30 Plan v1 → v2.** Measurement reviewer: the baseline's Playwright wall time includes webServer boot while the isolated arms' does not, so the test phase is now first test begin → last test end in every arm, measured by the isolate reporter, which runs in the baseline too through a pass-through wrapper. The verdict denominator is isolated N=1 vs N=4, with 3 rotated rounds after a warm-up, mutation targets drawn from `git ls-files` rather than the map, and more mutant kinds.

**08:40 Pre-registration.** PLAN.md §1 verdict rules fixed as of this entry, before any real-repo data exists.

**08:45 Plan v3.** Mechanism and process reviewers: Postgres refuses to run as root, and this sandbox is root. Confirmed: a `postgres` system user exists (uid 102) and `setpriv` is available. The fix was sent to the F1/F3 subagent. Real-repo scout started now rather than in Phase 4. Clock checkpoints set around the 12:00 UTC no-resume cutoff. Acceptance tests hardened (ca4ad31). `lscpu`: 4 cores, 1 thread per core, 1 socket.

**08:35 Subagents launched (worktrees):** fixture app; F1+F3; F4+F6 (with a `--baseline` mode added for the experiment); harvester; real-repo scout (no worktree; writes only `experiments/recipes/` and `work/`).
