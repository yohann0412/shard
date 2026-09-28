# isolate

Run a Playwright suite with N workers, each against **its own app process** and **its own copy of a seeded Postgres database**, with no edits to the tests.

Most end-to-end suites run with `workers: 1` because every worker would share one app and one database, and parallel tests then collide. `isolate` starts one Postgres server in RAM, migrates and seeds a `seed` database once, copies it N times with `CREATE DATABASE ... TEMPLATE seed`, starts N copies of your app (one per database, one port each) and points Playwright worker *i* at app *i*.

It also has a tracing mode that records which server and client files each test executed, and an `affected` command that turns a diff into the list of tests to run.

This repository also holds a research sprint that measured whether either idea works on real repositories. **Short version:** isolation works with no test edits (zero new failures on the fixture and on umami; rallly also needed two extras, listed in RESULTS.md), but on a 4-core machine the test phase got 1.3-1.6x faster, not close to N×. The limits were file-level scheduling and about 2 cores per worker slot. The impact map missed no tests in the small samples we could score, but it selected almost every test for the typical changed file. Details, and every repo that could not run, are in [RESULTS.md](RESULTS.md).

## 30-second quickstart

Requirements: Node >= 22.18, pnpm 10, Linux or macOS. Postgres binaries come from the `embedded-postgres` npm package, so no Docker is needed.

```bash
pnpm install && pnpm build
cd examples/fixture-app
pnpm run test:collide                                  # workers 4 against one shared app: fails
node ../../dist/src/cli.js run --workers 4 -- npx playwright test   # one app and database per worker: passes
```

Or `just demo` from the repository root, which shows both runs and their wall times.

In your own repo:

```bash
npx isolate init                                   # inspects the repo, writes isolate.config.ts
npx isolate run --workers 4 -- npx playwright test
```

## Commands

| Command | What it does |
|---|---|
| `isolate init [--allow-unmanaged] [--force]` | Detect package manager, build, migrate, seed, start command, env var names, health path and Playwright config; write `isolate.config.ts`. Refuses when the app needs services isolate does not manage (see below). |
| `isolate db up --workers N` | Start Postgres with `seed` and N template copies; print their URLs; stop on Ctrl-C. |
| `isolate app up --workers N` | The above plus N app processes, health-checked; stop on Ctrl-C. |
| `isolate run [--workers N] [--shared-origin URL] [--baseline] -- <playwright command>` | Run the suite with one app and database per worker. Ends with a timing table and `.isolate/report.json`. `--shared-origin` puts every app behind the origin the app's build baked in (see below). `--baseline` instead runs the repo's own config (its `webServer`, its workers) against one fresh copy of `seed`, with the same timing reporter, for comparisons. |
| `isolate snapshot` | Build, migrate and seed, and cache the result so later runs restore instead of rebuilding. |
| `isolate trace [--workers N] -- <playwright command>` | Like `run`, and write `.isolate/map.json`: for each test, the server and client files it executed, plus the files that run at boot. |
| `isolate affected --base <ref> [--strict] [--json]` | Print the tests affected by the changes since `<ref>`, or `all`. A change to test-side code that tracing cannot see (a helper, fixture or page object next to the specs or elsewhere in the Playwright config's directory outside the app's source directories) gives `all`, as do lockfiles and `cache.inputs`, including those above the repo directory. Run it without `--base` for the full rules. |
| `isolate report --check <file>` | Validate a report against its schema. |

## How a worker finds its app

Playwright forks each worker, sets `TEST_PARALLEL_INDEX` inside it, and then loads the config file again in that worker. `isolate` writes two small files next to your Playwright config for the duration of the run:

- `.isolate.env.ts` sets `BASE_URL`, your database URL variable and any configured variables to worker *i*'s values.
- `.isolate.playwright.config.ts` imports that module first, then your config, removes `webServer`, sets `workers` and `use.baseURL`, and adds a timing reporter.

Tests that read `process.env.BASE_URL` or connect to the database directly (for fixtures seeded through Prisma, say) get their own worker's values too. The two files are removed after the run and listed in `.git/info/exclude`. See [DECISIONS.md](DECISIONS.md) D-001 and D-002, and [LOG.md](LOG.md) for the experiment that established this mechanism.

### Apps that bake their origin into the build

Some builds fix the origin the browser talks to: Next.js inlines `NEXT_PUBLIC_*`, Turbopack its chunk base path, auth libraries their trusted origins. Behind isolate's per-worker ports such an app breaks even with one worker, because the page loads its scripts from, and posts its logins to, an origin where nothing listens. For these apps, pass that origin: `isolate run --workers 4 --shared-origin http://localhost:3201 -- npx playwright test` (or set `playwright.sharedOrigin`). isolate then starts a small reverse proxy on that host and port, refuses to start if the port is taken, and gives every worker the shared origin as `baseURL` and base-URL variables. The wrapper adds an `x-isolate-worker: i` header to every request Playwright makes (pages, their subresources and the `request` fixture), and the proxy sends each request to app *i*, which still listens on its own port. Requests without the header, such as the app calling its own public URL, are answered 421 and counted. The report lists the requests each app received through the proxy, and the run is invalid if a worker that ran tests sent none or a request reached another worker's app. The header also goes with the page's cross-origin requests, which makes browsers send CORS preflights to third parties. See [DECISIONS.md](DECISIONS.md) D-014.

## Configuration

`isolate.config.ts` is plain TypeScript with only erasable syntax. Node loads it natively, which is why Node 22.18 or later is required. In `app.env` and `playwright.env`, the values `{i}` (worker index), `{port}`, `{url}` (the app's own base URL), `{origin}` (the shared origin with `--shared-origin`, otherwise the app's own URL) and `{db}` (the worker's database URL) are filled in per worker, for example `NEXTAUTH_URL: '{url}'` or `NEXT_PUBLIC_BASE_URL: '{origin}'`.

A cached Postgres data directory only works with the same Postgres major version and CPU architecture. Both are part of the cache key.

## What it does not do

- **Unmanaged services.** Redis, S3, queues, search engines, SMTP and third-party APIs are not started, namespaced or mocked. `init` detects them and refuses without `--allow-unmanaged`. With it, all N apps share the real service, and runs are labelled "isolation incomplete".
- **Non-Node backends.** `run` works for any app that can be started N times with a different port and database URL. Tracing is Node-only.
- **Per-test isolation.** Tests in the same worker share that worker's database, exactly as the serial suite shares one. `isolate` makes parallel runs behave like serial runs; it does not make order-dependent tests independent.
- **Shared auth state.** A `globalSetup` or a Playwright "setup" project writes its session into one worker's database, so database-backed sessions are missing in the other workers. `run` warns when it sees either.
- **Build-time URLs.** Values baked into client bundles (Next.js `NEXT_PUBLIC_*`) cannot differ per worker. `--shared-origin` covers the common case, a build that fixes the app's own origin (see above), but not other per-worker values baked into a build.
- **Other browsers for tracing.** Client-side coverage uses Chromium's `page.coverage`.

## Developing

`just --list` shows every command. `just e2e` runs the acceptance tests: real Postgres, real Chromium, no mocks. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
