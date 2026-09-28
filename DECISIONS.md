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
- **Choice.** The app preload starts precise coverage (`callCount: true, detailed: false`) in an in-process `inspector.Session` before app code runs, and listens on a Unix socket `w<i>/<pid>.sock` in a private directory that `isolate trace` creates under `os.tmpdir()` (`isolate-trace-XXXXXX`, removed after the run, and by the reaper if isolate is killed), not under `.isolate/`, because Unix socket paths are capped near 107 bytes and a repository path can use most of that. A take request waits until the process has zero in-flight HTTP requests (counted by wrapping `http.Server.prototype.emit('request')` and the response's `close`, up to 2 s, recording timeouts). It then calls `Profiler.takePreciseCoverage` in-process and returns only repo files outside node_modules, each with its executed function start offsets. The controller in the CLI talks to those sockets; the patched `_runTest` awaits the begin take before the test and the end take after it (on Playwright versions without a reachable `_runTest`, such as 1.63, an automatic test-scoped fixture does, see RISKS R15). It is still V8 precise coverage through the Inspector protocol; the transport is a socket instead of the DevTools WebSocket.

## D-014: A header-routed proxy on the build-time origin (`--shared-origin`)

- **Problem.** Some apps bake their own origin into the build: Next.js inlines `NEXT_PUBLIC_*`, Turbopack writes `TURBOPACK_CHUNK_BASE_PATH`, and auth libraries take their `trustedOrigins` from the same value. isolate puts app *i* on `127.0.0.1:<random port>`, so the page tells the browser to fetch its chunks from, and post its logins to, the build-time origin, where nothing listens. On rallly (`http://localhost:3201`) all 20 browser tests failed at every N, N=1 included (experiments/recipes/SCOUT_LOG.md, "rallly isolate onboarding"). A build without the URL did not help either: `next start` then derives `assetPrefix` at runtime and the client still does not hydrate.
- **Options.** (a) One build per worker, each for its own fixed port: N builds (rallly's takes about 4 minutes each), pinned ports, and a per-worker build cache. (b) Chromium's `--host-resolver-rules` per worker, mapping the build's host to worker *i*'s app: it rewrites host names, not ports, so `localhost:3201` cannot reach `127.0.0.1:<port i>`, and the test process's own requests (the `request` fixture, Node `fetch`) are not covered at all. (c) The fallback D-001 and RISKS R1 already named: one reverse proxy on the build-time origin that routes each request by a per-worker header, which the wrapper config adds through `use.extraHTTPHeaders`.
- **Choice.** (c), opt-in: `isolate run|trace --shared-origin <url>`, or `playwright.sharedOrigin` in the config. A small `node:http` proxy (src/proxy/, no dependency) runs as its own process group under the stack's reaper (D-007), started before the build so that a taken port fails fast with a clear message, and stopped first in teardown. It listens on every address of the origin's host (for `localhost`, both loopbacks when they exist), forwards requests and WebSocket upgrades to app *i* on 127.0.0.1 according to `x-isolate-worker: i`, and answers 421 with a one-line reason, counting it, when the header is missing or names no app. Tagging is forced on. Every worker's `baseURL` and `playwright.baseUrlEnvs` become the shared origin; apps still listen on their own ports, `{url}` still means the app's own URL, and `{origin}` is the shared origin (or the app's own URL without one). The header's value is the app index (`ISOLATE_APP_INDEX`), not the parallel index, so a rerun's app gets its own route. The proxy counts requests per header value and target app; they go into `report.json` (`proxy`, `apps[].requests`) and into the routing check: a worker that ran tests but got no proxied request, or any request that reached another app than its header names, makes the run invalid.
- **Routing verdict.** `routingValid` is `null` (unknown) when Playwright wrote no per-test results or ran no test. A used database without commits whose app served proxied requests is a warning, not a failure, because tests that make no queries are legitimate (rallly's accessibility checks); only when no used database committed anything does it stay an error, since that is what an app that ignores `DATABASE_URL` looks like (RISKS R3). Without the proxy there are no request counts, so an idle database is still an error, but when the app wrote to its log during the tests the message says it probably served them instead of blaming `DATABASE_URL`. The known hole: with the proxy, one app that ignores its database URL while another uses its own passes as valid with a warning.
- **Reason.** (c) needs no rebuild, no pinned ports and no test edits, and covers the browser, the `request` fixture and contexts the tests create themselves (Playwright applies `use` options to `browser.newContext()` too).
- **Costs, honestly.** The header goes with every request the page makes, including cross-origin ones: a third-party API, analytics or CDN request now carries `x-isolate-worker`, which is not a CORS-safelisted header, so the browser sends a preflight first, and a third party that does not allow the header rejects the request. Requests without the header are refused: the app calling its own public URL from the server, a Node `fetch` in a test, a request context created with its own `extraHTTPHeaders`. Every request pays one extra local hop. The proxy speaks plain HTTP only.
