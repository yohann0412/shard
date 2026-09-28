# Risks

Each risk has a way to detect it and a fallback.

| # | Risk | Detection | Fallback |
|---|---|---|---|
| R1 | The per-worker `baseURL` mechanism fails on some Playwright version | F4 acceptance: every worker's app log must show traffic and no other worker's; `isolate run` checks per-worker request counts in app logs | Reverse proxy on one port routing by a per-worker header injected via `extraHTTPHeaders` in the wrapper config; then Linux network namespaces |
| R2 | Tests hardcode absolute URLs (`http://localhost:3000`, `127.0.0.1`) | Scan test files before the run and print file:line | Report as-is; for otherwise class-A repos, one extra run with a scripted rewrite, marked "with modifications", diff included |
| R3 | App reads a `.env` file that overrides `DATABASE_URL`/`PORT` | Per-worker `pg_stat_database.xact_commit` delta must be > 0 for every used worker DB; health check port must answer | Run marked invalid with the cause; config can set `app.env` to force values, recorded as a modification only if a repo file changes |
| R4 | Non-Node backends | Detection in `init` and harvest | Fine for Experiment A if it starts N times with env; out of scope for tracing |
| R5 | macOS: no `/dev/shm` | `process.platform` | Temp dir on disk; logged as "not RAM" |
| R6 | Sandbox limits: no browser download, blocked clones, 4 vCPUs | Probed on day 0 (LOG.md): Chromium 1194 present, git clone works, GitHub search API blocked, 4 vCPU | Revision symlinks (D-010); harvest from awesome-selfhosted-data + seed list; skip N > cores; everything else to `HANDOFF.md` |
| R7 | Flaky baselines | Baseline pass/fail per test | Compare isolation only against tests that passed at baseline; baseline failures reported |
| R8 | Time | Budget in PLAN.md §6 | Cut order in PLAN.md §6 |
| R9 | `globalSetup` or a Playwright "setup" project writes auth state into one worker's database, then other workers reuse the saved `storageState` against databases that do not contain that session | Config inspection (`globalSetup`, projects with `dependencies`) printed as a warning before the run; failures categorized "shared auth state" | V1: report. V2 idea: run setup per worker, or snapshot after global setup |
| R10 | Apps bind fixed side ports (SMTP mocks, websocket servers, Next.js dev HMR, metrics) so N copies collide | App boot failure or `EADDRINUSE` in `.isolate/logs/w{i}.log` | Report as "global state outside the database"; allow `app.env` overrides per worker via `{i}` placeholder |
| R11 | Build-time URLs (Next.js `NEXT_PUBLIC_*`) bake `localhost:3000` into client bundles | Client-side requests in app logs of the wrong worker; hardcoded-URL failures | Report; a per-worker build is out of scope |
| R12 | CPU contention and frequency scaling inflate or deflate speedups | Machine specs recorded; both runs per N reported; N > cores labelled oversubscribed | Report spread; do not claim precision the data does not have |
| R13 | Coverage misses: lazy imports, error paths, workers/child processes of the app, bundled server code without source maps | Experiment B miss investigation; controls | Report categories; `--strict` global policy |
| R14 | A subagent reports success without the acceptance test passing | The lead re-runs every acceptance test from a clean build before accepting; subagents never commit | Send back with the concern; after two failures the lead fixes it |
| R15 | Playwright internals used by tracing (`WorkerMain._runTest`, client `BrowserContext`) change across versions | Trace preload asserts the methods exist and fails loudly | Generated fixture file + one-line import in a copy of the tests, results marked "with modifications" |
| R16 | Disk fills up with repo checkouts and caches (30 GB in the sandbox) | `df` before each repo | Delete each checkout after its experiment; keep only results |
| R17 | Postgres refuses to run as root (this sandbox is root); `pg_ctl` escapes process groups via `setsid` | First `initdb` call | Run as the `postgres` system user (or a created `isolate-pg`) through `setpriv`; start the postmaster directly; sweep `/proc/*/environ` for the run marker on teardown |
| R18 | N copies of a Next.js app share one `.next` directory (dev-server lock in Next 16, ISR cache flushed to disk) | Apps 2..N exit at boot, or ISR/revalidate tests interfere | Shadow directory per worker with a real copy of `.next` and symlinks for everything else; or production `next start` in every arm, labelled |
| R19 | Bundled servers (Next.js) ship no server source maps and run every module factory at boot | Fraction of executed functions that map to repo files; size of the global set | Trace build with a generated config enabling server source maps (labelled "trace build modified"), bundler module factories treated as top level; else Experiment B limited to unbundled servers + fixture |
| R20 | Background load from subagents or clones during timed runs | 1-min load average recorded at the start of every timed run | Redo the run when it is above 1.0; timed runs only with no subagent active |
