# Decisions

Short architecture decision records. Newest at the bottom.

## D-001: Per-worker baseURL comes from a wrapper config, not a startup preload

- **Problem.** Each Playwright worker must talk to its own app, with zero test edits.
- **Options.** (a) `--require` preload that reads `TEST_PARALLEL_INDEX` at worker startup and sets `BASE_URL`. (b) A generated wrapper config that is re-evaluated in each worker. (c) One reverse proxy that routes by a per-worker header. (d) Network namespaces.
- **Choice.** (b). The wrapper imports a generated side-effect module first (`.isolate.env.ts`) that sets `BASE_URL`, the database URL variables and any configured extra variables from `TEST_PARALLEL_INDEX`, then imports the repo's config.
- **Reason.** Verified on Playwright 1.56.1 (LOG.md, 2026-09-28 08:15): `TEST_PARALLEL_INDEX` is assigned in the `WorkerMain` constructor, *after* process start, so (a) sees `undefined`. The worker then loads the config (`_loadIfNeeded`), so (b) sees the right index. (b) also covers tests that read `process.env.*` directly. (c) and (d) stay as fallbacks.

## D-002: The wrapper config lives next to the repo's config, not in `.isolate/`

- **Problem.** Playwright resolves `testDir`, `outputDir`, `globalSetup`, snapshot paths and so on relative to the directory of the config file it was given.
- **Options.** (a) `.isolate/playwright.config.ts` plus rewriting every relative path. (b) A dot-file next to the repo's config.
- **Choice.** (b): `.isolate.playwright.config.ts` and `.isolate.env.ts` in the same directory as the repo's config, removed after the run and listed in `.git/info/exclude` while present.
- **Reason.** Rewriting paths means knowing every path-valued option across Playwright versions. Placing the file next to the original makes every relative path resolve exactly as before.

## D-003: `isolate` injects `--config` and `--workers` into the command it runs

- **Problem.** The user runs `isolate run -- npx playwright test ...`; Playwright has no environment variable for the config path.
- **Choice.** If the command contains `playwright test`, insert `--config <wrapper>` after `test`. Otherwise refuse with a message asking for a direct `playwright test` invocation. `workers` is set in the wrapper config, not on the command line, so a `--workers` flag in the user's command still wins and is reported.
- **Reason.** Swapping the repo's config file in place works through npm scripts but leaves the repo modified if the process is killed. Refusing is honest and cheap.

## D-004: Dependencies beyond pnpm, zod, execa, pino

- `pg`: the tool issues `CREATE DATABASE ... TEMPLATE`, terminates connections, reads `pg_stat_database`, and the acceptance tests count rows. The alternative is shelling out to `psql`, which the embedded binaries do not ship.
- `embedded-postgres`: only for its per-platform Postgres binaries (`initdb`, `postgres`, `pg_ctl`); we drive them ourselves with execa. A system Postgres (`pg_config --bindir` or `postgres.binDir` in the config) is the fallback.
- `typescript`, `@types/node`, `@types/pg`: build only.
- No test framework: acceptance tests use `node:test`. No CLI framework: `node:util` `parseArgs`. No WebSocket library: Node 22's global `WebSocket`. No source-map library: `node:module` `SourceMap`. No YAML library: the harvester reads the handful of flat fields it needs with line-based parsing.

## D-005: Config file is `isolate.config.ts`, loaded by Node's native type stripping

- **Problem.** Load a TypeScript config from a compiled CLI without a loader dependency.
- **Choice.** `import()` the file directly; Node >= 22.18 strips types natively. The generated file uses only erasable syntax. Validation is zod.
- **Reason.** No `tsx`/`jiti` dependency. The cost is a Node >= 22.18 floor, stated in the README.

## D-006: Acceptance tests use `node:test` on the compiled output

- `tsc` compiles `src`, `e2e` and `scripts` into `dist/`; `just e2e` builds and then runs `node --test --test-concurrency=1 dist/e2e/`. Serial because every test starts real Postgres servers, apps and browsers and parallel e2e tests would distort each other's timings.

## D-007: Children run in their own process groups, with a reaper for SIGKILL

- **Problem.** "Killing the parent kills all children", including `pnpm start` → `node` trees, and including SIGKILL, which no handler can catch.
- **Choice.** Spawn each app and Postgres `detached` (own process group) and kill the group. Signal handlers cover SIGINT/SIGTERM/normal exit. A tiny detached reaper process polls the parent PID and kills the recorded groups if the parent disappears.
- **Reason.** Node has no `PR_SET_PDEATHSIG`. Polling every 500 ms is boring and portable.

## D-008: Setup fraction comes from an `isolate` reporter, not the JSON reporter

- Playwright 1.56's JSON reporter keeps only `test.step` steps, so hook and fixture durations are not in it. The wrapper config appends `isolate`'s own reporter, which sums `hook` and `fixture` step durations per test, and writes `.isolate/pw-results.json` (per-test status, duration, parallel index, setup ms, location). **Revised after the plan review:** the baseline is instrumented too, through a pass-through wrapper that keeps the repo's `webServer`, `workers` and env and only appends the reporter, because an uninstrumented baseline has no comparable test-phase span (its Playwright wall time includes webServer boot, the isolated arms' does not). The reporter also records the first-test-begin and last-test-end times and the maximum number of concurrently running tests.

## D-009: Snapshot keys are split into a database key and a build key

- **Problem.** The spec keys the cache on lockfile + migrations + seed + config, and stores the build output under that key. A source edit would then restore a stale build.
- **Choice.** Database key = hash(lockfile, migration files, seed files, isolate config). Build key = database key + hash of every tracked and untracked-not-ignored file's content (via `git ls-files -s` blob ids plus hashes of modified files). The Postgres data directory is stored under the database key, build outputs under the build key.
- **Reason.** Correctness over cache hits.

## D-010: Browsers for real repos

- The sandbox ships Chromium revision 1194 (Playwright 1.56.x) and forbids `playwright install`. For a repo pinned to another Playwright version, both the baseline and the isolated runs get `PLAYWRIGHT_BROWSERS_PATH` pointing at a directory of symlinks named with the revision that version expects. This touches no repo file, is applied identically to both arms, and is reported per repo.

## D-011: What "global" means in the impact map

- **Problem.** "Everything executed before the first test" includes the top-level code of every eagerly imported module, which in a typical Node server is every route file. Treating all of it as global makes `affected` answer "all" for almost every server edit.
- **Options.** (a) Global = every file with any boot execution. (b) Global = files where a function other than the module top-level scope ran at boot; files touched at boot only by their top-level scope are recorded as `bootLoaded`. (c) Line-level: global only if the diff touches boot-executed ranges.
- **Choice.** (b), with `isolate affected --strict` implementing (a) for teams that want it. The map stores both sets, so the experiment scores both policies.
- **Reason.** (a) is safe but useless; (c) needs diff-to-range mapping we cannot validate in this sprint. The known hole in (b): an edit to a module's top-level code (a constant, a route path) can affect tests that never called a function in that file. The mutation operator in Experiment B (a throw inside a function) does not probe this hole; `RESULTS.md` says so.

## D-012: V1 isolates Postgres and app processes only

- Redis/Valkey, Memcached, S3/MinIO, queues (BullMQ, RabbitMQ/amqplib, Kafka, NATS, SQS), Elasticsearch/OpenSearch/Meilisearch/Typesense, MongoDB, ClickHouse, SMTP and third-party HTTP APIs are not started, namespaced or mocked. `init` detects them from dependencies in every workspace `package.json`, `*_URL`/`*_HOST`/`*_KEY` keys in `.env*` examples, and compose service images. It refuses to write a config without `--allow-unmanaged`. `run` repeats the scan and writes it into the report. With `--allow-unmanaged`, all N apps share the real service: queues, caches and rate limiters can then cross-talk between workers, and such runs are labelled "isolation incomplete".

## D-013: Coverage is taken in-process and served over a local socket

- **Problem.** The first design connected to each app process's inspector over WebSocket and called a helper through `Runtime.evaluate` that re-entered the inspector from inside another session's message. That is unverified, moves megabytes of coverage per take for bundled servers, and does not wait for in-flight requests.
- **Choice.** The app preload starts precise coverage (`callCount: true, detailed: false`) in an in-process `inspector.Session` before app code runs, and listens on a Unix socket `.isolate/trace/w<i>/<pid>.sock`. A take request waits until the process has zero in-flight HTTP requests (counted by wrapping `http.Server.prototype.emit('request')` and the response's `close`, up to 2 s, recording timeouts). It then calls `Profiler.takePreciseCoverage` in-process and returns only repo files outside node_modules, each with its executed function start offsets. The controller in the CLI talks to those sockets; the patched `_runTest` awaits the begin take before the test and the end take after it. It is still V8 precise coverage through the Inspector protocol; the transport is a socket instead of the DevTools WebSocket.
