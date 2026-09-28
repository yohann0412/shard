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

## rallly isolate onboarding

09:31-10:40 UTC. Goal: run rallly's own Playwright suite under `isolate run` at N = 1, 2 and 4 without changing any rallly file. This is onboarding, not timing: the machine was shared (load average 3-10), so no number below is a timing result. Artifacts are under `work/`: clone `work/repos/rallly` at fa6bfd4 (recipe build), second clone `work/repos/rallly-mit` (mitigation build), and `work/rallly-isolate/` (env.sh, run-arm.sh, build-mitigation.sh, probes, logs, and one `results/<arm>/` per run with report.json, pw-results.json, isolate logs and test-results). The config is `work/repos/rallly/apps/web/isolate.config.ts`, and `isolateConfig` in rallly.json has the same content.

Result: **not runnable yet.** Routing works: each worker gets its own app and database, and specs' Prisma reaches the worker's database. But every browser test fails at every N, N=1 included, because of the build-time URL (hazard a). The one mitigation tried, a build without the URL, did not help. Only request-level specs pass.

Setup (recipe, Node 24, ports 3200+):
- `git clone https://github.com/lukevella/rallly work/repos/rallly && git checkout fa6bfd4`, then `pnpm install --frozen-lockfile` (8 s, warm store).
- `bash experiments/recipes/make-pw-shim.sh 1208 work/rallly-isolate/pw-browsers`.
- `source work/rallly-isolate/env.sh`, which sets PATH to node24, CI=true, PORT=3201, NEXT_PUBLIC_BASE_URL=http://localhost:3201, SMTP 127.0.0.1:3225, MAILPIT_API_URL=http://127.0.0.1:3226/api, the shim, and PLAYWRIGHT_HTML_OPEN=never.
- `pnpm db:generate && pnpm turbo build:test --filter=@rallly/web` (234 s).
- `work/bin/mailpit --smtp 127.0.0.1:3225 --listen 127.0.0.1:3226 --disable-version-check`: one instance shared by all workers, so every run is "isolation incomplete".
- **CI=true, not CI=1.** playwright.config.ts:6 tests `CI === "true"`. With CI=1 the baseline's webServer runs `rm -rf .next && next dev`, which deletes the build, and the timeouts double.
- `isolate init` at 09:36 printed "Cannot find module .../dist/src/commands/init.js". After the lead integrated F2 it worked in `work/repos/rallly-mit/apps/web`: exit 3 without `--allow-unmanaged`, and with the flag it wrote a config. The comparison is in rallly.json `isolateNotes`. It differs in `build: pnpm build`, a `db.seed` that CI does not run, `healthPath: /` and a bare `next`.

Arms. Each was run as `run-arm.sh <arm> <isolate args> -- pnpm exec playwright test --retries=0 [files]` from apps/web. S is the 7-file subset tests/{accessibility, house-keeping, otp-email-locale, otp-sign-up, password-sign-up, stripe-portal-auth, zoom-deauthorization}.spec.ts, 21 tests.

| arm | tests | passed | failed | did not run | routingValid | dbActivity (commits) |
|---|---|---|---|---|---|---|
| baseline@1 (`--baseline`, `--workers=1`) | 140 | 137 | 1 (email-invites:104, 30 s timeout at 94% CPU: timeout under load) | 2 (serial siblings) | true | b0 5121 |
| isolated@1, full, recipe build | 54 of 140 reached, **interrupted** by me after 577 s of test phase | 3 | 20 that pass at baseline, plus email-invites:104 interrupted | 30 serial skips, 86 not reached | true (vacuous: reporter wrote no results) | w0 244 |
| isolated@1, S | 21 | 18 | 2 (accessibility:44, :75) | 1 | true | w0 189 |
| isolated@2, S | 21 | 18 | 2 (same) | 1 | **false** (w0 0) | w0 0, w1 193 |
| isolated@4, S | 21 | 17 | 3 (same two, plus otp-sign-up:62 timed out, "flaky" after reruns) | 1 | **false** (w0 0) | w0 0, w1 122, w2 32, w3 33 |
| mitigation isolated@1, full | 54 reached, **interrupted** after 578 s | 3 | the same 20 (+1 interrupted) | 30 | true (vacuous) | w0 253 |

N=2 and N=4 ran on subset S because N=1 on the full suite would have taken far more than 10 minutes: executed failures each ran to the 30 s timeout. The mitigation was not run at N=2 or N=4 because it changed nothing at N=1.

Failure categories (tests that pass at baseline and fail under isolation):
- **Build-time URL (hazard a), 20 tests, every N:**
  - accessibility.spec.ts :44, :75
  - admin-setup.spec.ts :36, :54, :69, :83, :97
  - authentication.spec.ts :30
  - closed-poll-writes.spec.ts :59
  - comments-disabled.spec.ts :9, :47
  - conferencing.spec.ts :79
  - control-panel.spec.ts :30
  - create-delete-poll.spec.ts :16
  - cross-timezone.spec.ts :229, :247, :274, :294, :321
  - edit-options.spec.ts :20

  Serial siblings of these did not run. Mechanism:
  - isolate puts app i on `http://127.0.0.1:<port chosen by the OS>` (src/proc/ports.ts binds port 0), never on the build origin, so N=1 is affected too.
  - The build inlines `TURBOPACK_CHUNK_BASE_PATH: "http://localhost:3201/_next/"` (.next/static/chunks/turbopack-*.js), and 63 .next JS files contain the URL.
  - Every failed trace has `ERR_CONNECTION_REFUSED http://localhost:3201/_next/static/chunks/*.js`. The client never hydrates, the login form falls back to a native `GET /login?identifier=...`, and steps time out, e.g. "waiting for getByRole('heading', { name: /Verify your email|Finish logging in/ })".
  - Server-side `absoluteUrl()` (packages/utils/src/absolute-url.ts:28) is inlined as well, and it sets better-auth `baseURL`/`trustedOrigins` (apps/web/src/lib/auth.ts:59, 667-668).
- **Unmanaged service (hazard b), N=4:** otp-sign-up.spec.ts:62 timed out (30 s) on worker 3. It was waiting in `getCode()` (line 75) while otp-email-locale.spec.ts:25 (`beforeEach` → `deleteAllMessages()`) ran on worker 2 at 5.17 s and 5.51 s, inside its window from 5.30 s to 35.3 s. It passed both of isolate's solo reruns.
- **Hazard (c): verified.** The env module's DATABASE_URL reaches specs' Prisma (packages/database/src/client.ts:14):
  - At N=4, house-keeping.spec.ts on worker 1 inserts polls with Prisma and app w1 marks exactly 3 deleted (house-keeping.spec.ts:182).
  - otp-sign-up.spec.ts:40 on worker 3 sets `disableUserRegistration` with Prisma and app w3 answers SIGNUP_DISABLED.
- **Routing false alarm:** at N=2 and N=4, w0 only ran accessibility.spec.ts. With a dead client, those tests make no DB queries. isolate reports "the app probably ignores DATABASE_URL", but the app log shows it served pages.
- None were cross-test dependency, shared auth state, hardcoded URL or global state outside the DB. rallly has no globalSetup and no setup project. The hardcoded `http://localhost:3000/hook` at webhooks-settings.spec.ts:219 is typed text, and those specs were not reached in the full runs.

Mitigation (one, no rallly file changed, but a non-recipe build env): `work/rallly-isolate/build-mitigation.sh`. It exports .env.test except NEXT_PUBLIC_BASE_URL, sets `__NEXT_PROCESSED_ENV=true` so `NODE_ENV=test next build` does not reload .env.test, sets `SKIP_ENV_VALIDATION=1` as rallly's Dockerfile:37 does, and runs `pnpm turbo build:test --filter=@rallly/web --env-mode=loose` (145 s). The URL then comes from app.env `NEXT_PUBLIC_BASE_URL={url}`. Outcome:
- The build contains no build URL, and the chunk base is `/_next/`.
- Nothing is refused any more, but the client still does not hydrate: the same 21 tests fail and the forms submit natively.
- Probes run outside isolate (probe-server.sh + probe-hydration.cjs, checking React props on the login button):
  - The recipe build on its own origin hydrates (control).
  - The mitigation build with a runtime URL does not hydrate. `next start` re-evaluates next.config.ts, so assetPrefix (next.config.ts:32 = NEXT_PUBLIC_BASE_URL) becomes absolute while the build's chunk base is `/_next/`. There were no console errors.
  - The mitigation build with no runtime URL hydrates, but it needs SKIP_ENV_VALIDATION and then shows "Login is currently not configured."
- Conclusion: with `next start`, per-worker runtime URLs from one rallly build are not possible without a rallly change, such as not tying assetPrefix to NEXT_PUBLIC_BASE_URL. That change would make the run "with modifications", and it was not tried.
- Building for a worker's port is also impossible, because isolate picks ports at random.

isolate bugs and gaps found (src not edited; proposed fixes are in rallly.json `isolateNotes`):
- Missing capability: shared-origin proxy mode. One proxy on the build origin, routing by the existing `x-isolate-worker` header. This is the fix for hazard (a).
- Missing capability: pinned ports and per-worker builds.
- Missing capability: managed per-worker sidecars, e.g. mailpit.
- Rerun apps get `{i}` = N+run.
- The routing check blames DATABASE_URL when a worker simply made no queries; per-app request counts are missing.
- After an interrupt, no per-test results are written, and routing reads "valid".
- Reruns wipe the main run's test-results/ (Playwright empties outputDir), so its traces are lost.
- `unmanaged.services` in the config is ignored by `run`.
- `.isolate/` is not git-excluded.

All processes I started (mailpit, the throwaway `db up`, the probe servers) were stopped at 10:33. Nothing in /home/user/shard was committed.
