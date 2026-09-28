# Scout log (real-repo baseline, Experiment A)

All times UTC, 2026-09-28. Machine shared with other agents (load average 6-9 on 4 vCPU during most runs). Checkouts in /home/user/shard/work/scout/ (deleted after each repo); throwaway Postgres 16.13 clusters under /dev/shm on ports 55432+, run as the `postgres` user (`initdb` refuses to run as root: `runuser -u postgres -- initdb ...`).

Shared tooling built under /home/user/shard/work (gitignored):
- `node24/`: Node v24.21.0 from nodejs.org (reachable), for repos with `engines.node` 24 and engine-strict.
- `pnpm12/`: pnpm 12.3.4 from npm. Run it from inside the checkout: under /home/user/shard it switches itself to the parent package.json's pnpm@10.33.0.
- `bin/mailpit`: `GOPATH=work/gopath GOBIN=work/bin go install github.com/axllent/mailpit@latest` (Go at /usr/local/go; proxy.golang.org works). Run as `mailpit --smtp 127.0.0.1:11025 --listen 127.0.0.1:18025 --disable-version-check [--smtp-auth-accept-any --smtp-auth-allow-insecure]`.
- `experiments/recipes/make-pw-shim.sh <rev>` (a copy is kept in work/): builds `work/pw-browsers/r<rev>`, which exposes Chromium 1194 under revision <rev>. Plain directory symlinks, as in the task brief, are NOT enough for Playwright >= 1.57. It looks for `chrome-linux64/chrome` and `chrome-headless-shell-linux64/chrome-headless-shell`, while 1194 ships `chrome-linux/{chrome,headless_shell}`. The script makes real directories of per-file symlinks, adds the renamed executable link, and keeps a `chrome-linux` link for older versions.

## 08:26-08:51 rallly: WORKS (140/140)

- Cloned at fa6bfd4. Read apps/web/playwright.config.ts and .github/workflows/ci.yml (job integration-tests: postgres:18 + mailpit services, `pnpm turbo build:test`, `pnpm db:deploy`, `playwright test` with CI=true).
- `engines.node: "24"` + `.npmrc engine-strict=true`, so Node 24 was needed: downloaded v24.21.0. `corepack enable` then `pnpm install --frozen-lockfile` took 1m05.
- Mailpit is required: OTP login codes are read from the mailpit HTTP API (packages/test-helpers/src/mailpit.ts). Built it with `go install` (about 1 min) and ran it on 11025/18025.
- `pnpm db:generate`, `pnpm db:deploy` (all migrations fine on PG16), `pnpm turbo build:test --filter=@rallly/web` took 2m29.
- First test run: every test failed in ~3 ms with "Executable doesn't exist at .../chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell": the layout changed in Playwright 1.57+. I wrote make-pw-shim.sh, and after that a single spec passed.
- Aside: killing the first run with `pkill -f` on a pattern also matched my own shell command (exit 144). Kill by PID only; other agents' Playwright processes run on this machine.
- Full run (`pnpm exec playwright test --workers=1 --reporter=list`, PORT=3101): **140 passed (8.2m), wall 495 s**, no retries configured, 0 flaky.
- Key parallelism hazards: NEXT_PUBLIC_BASE_URL is baked into the build (it drives better-auth trustedOrigins), so N instances from one build all believe they live on one port. One mailpit is shared, and 10 specs call deleteAllMessages().

## 08:31-08:58 umami: WORKS (browser suite 24/31 due to suite rot; API suite 271/271)

- Cloned at ec0ff50. `engines.pnpm` 12.3.4 (installed from npm). Node 22 OK. `pnpm install --frozen-lockfile` took 27 s.
- The browser suite (`test:e2e`, tests/e2e, 38 tests) is NOT run in CI (ci.yml runs only vitest and the build). webServer defaults to `pnpm dev`; the config reads PLAYWRIGHT_WEB_SERVER_COMMAND, so I used `pnpm start` after `pnpm build` (205 s, with SKIP_BUILD_GEO=1; the build also runs `prisma migrate deploy`). The admin/umami user comes from migration 01_init.
- Playwright 1.63.0 expects Chromium 1243 (Chrome 153); it ran on the 1194 shim with no protocol problems.
- Run 1: 24 passed, 7 failed, 7 did not run, 2.4m (wall 148 s). Run 2 on a fresh DB: identical outcomes, 2.6m (158 s). The failures are deterministic drift between the unmaintained tests and the app: /dashboard became /websites, password is no longer returned by the users API, and the settings UI moved.
- Also ran the maintained API suite (playwright.api.config.ts, request-only, normally started via docker compose) against `pnpm start` on 3104 with the compose env: **271 passed (1.6m), wall 98 s**. Its globalSetup seeds one server and writes a seed file keyed by host, which breaks under per-worker apps.
- After `kill` of the pnpm wrapper, next-server kept running: kill the process group.

## 08:32-09:27 documenso: WORKS, partially run (api project 458/507; ui sample 15/18)

- Cloned at a1d4bec. Playwright pinned to 1.56.1, the exact installed revision 1194, so no shim was needed. Node >= 24, npm >= 11.17 (Node 24.21's bundled npm 11.19.0).
- CI (e2e-tests.yml): `cp .env.example .env`, docker compose dev stack (postgres, inbucket, redis, minio, gotenberg), `prisma:migrate-dev`, `prisma:seed`, `npm run ci` (turbo build, then start-server-and-test on the literal http://localhost:3000), with DANGEROUS_BYPASS_RATE_LIMITS=true. With upload transport `database` and the local jobs provider, only Postgres plus an SMTP sink are actually needed; mailpit served as the sink.
- `npm ci` 181 s (run concurrently with rallly's test run). Migrate + seed 46 s (the seed includes a 1000-document account). `turbo run build --filter=@documenso/remix` 514 s; its lingui extract rewrites 11 tracked .po files.
- This session's permission check refused to set DANGEROUS_BYPASS_RATE_LIMITS=true, so everything ran with real rate limiting. Here the classifier also returned transient "no verdict" errors 6 times in a row, which cost a few minutes.
- The suite has 1200 tests (api 507, ui 681, license 12); the full workers=1 run does not fit the time box. Ran the whole `api` project: 458 passed, 15 failed, 10 skipped, 24 did not run, 15.6m (wall 939 s, load avg 9-12). The failures include a 429 where 401 was expected and the two org rate-limit specs that CI skips via the bypass flag; the rest (null lookups, 401 on allowed calls) were not diagnosed.
- UI sample `--project=ui e2e/user`: 15 passed, 3 failed (2.4m). All 3 failures are password.spec.ts navigating to the hardcoded http://localhost:3000 (ERR_CONNECTION_REFUSED; the app was on 3103).
- The server env was confirmed from /proc (DB 55434, PORT 3103); 63k commits on the DB. Stopped via its process group.

Stopped here: 3 repos work (rallly, umami, documenso). Not examined: llamenos-platform, postiz-app, payload.

## Quick rejections (read-only, no install)

- 08:37 formbricks (c40632e, ~5 min): migration 20241017124431 runs `CREATE EXTENSION "vector"` (pgvector is not installed). CI also needs Valkey, SpiceDB/AuthZed, a RustFS S3 bucket and the ENTERPRISE_LICENSE_KEY secret. BLOCKED.
- 08:38 hoppscotch (a9ffa29, ~3 min): no Playwright suite at all (backend e2e is Jest). BLOCKED.
- 08:39 infisical (e008b8c, ~4 min): the only Playwright suite (e2e/) targets the deployed https://gamma.infisical.com behind Twingate, with real SCIM/IdP tokens. BLOCKED.
- 08:40 twenty (a431f9a, ~4 min): the server hard-requires Redis (cache, session storage, BullMQ worker). BLOCKED.
- 08:42 langfuse (e0a2735, ~3 min): the e2e job needs ClickHouse migrations/seed plus Redis and MinIO. BLOCKED.
- 08:43 cal.com (54343aa, ~4 min): CI injects ~40 real third-party secrets and shards the suite 8 x 4 workers x 20 min; a workers=1 baseline cannot fit the 45-min box. The webServer port is the literal 3000. BLOCKED (not attempted).
