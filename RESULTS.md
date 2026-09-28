# Results

**Status: draft, being filled in as runs finish.** Every number cites a committed file under `data/results/` or `experiments/recipes/`.

## Verdicts

- **Claim A (isolation):** _pending Experiment A._
- **Claim B (impact map):** _pending Experiment B._

## Machine

Cloud sandbox VM (`cloudSandbox: true`): Intel Xeon @ 2.80 GHz, 4 cores, 1 thread per core, 1 socket, 15 GB RAM. Linux 6.18, Node 22.22.2, Postgres 18.4 (embedded-postgres binaries) running in `/dev/shm` with fsync, synchronous_commit and full_page_writes off. Playwright 1.56.1 on the fixture; each real repo uses its own pinned Playwright against the pre-installed Chromium 141 (revision 1194), which the harness exposes through a revision shim (DECISIONS D-010). Every timed run records its load average and CPU steal (`data/results/<repo>/runs/*.json`).

## Harvest and runnability

Pool: the 23-repo seed list plus awesome-selfhosted-data (daily star counts; snapshot 2026-09-28). GitHub search was blocked in the sandbox (LOG.md, 07:59), so the pool is self-hosted apps only and is not representative of GitHub at large.

| Stage | Count |
|---|---:|
| Repos in the pool | 998 |
| Qualified (Playwright config + DB evidence + ≥ 200 stars + pushed in the last 12 months) | **96** (target 100; pool exhausted) |
| Static class A / B / C | 1 / 36 / 59 |
| Tried for real by the scout (top candidates by expected feasibility) | 12 (3 more not examined) |
| Repo's own suite green at baseline in this sandbox | 3 (rallly, umami, documenso partially) |
| Runs under isolate | _pending_ |

Why the 902 others did not qualify: 828 have no Playwright config, 74 have no database evidence (`data/harvest-summary.md`). Among the 96, the most common blockers are Redis (55), SMTP (50), S3/MinIO (41), Stripe (24), OpenAI (22), Anthropic (19), a Python backend (16) and BullMQ (14).

Static classes over-detect. The three repos that actually ran are all static class B, because optional integrations look like dependencies in `package.json` and `.env` examples.

Premise check. By their own config text, 47 of the 96 qualified repos run one worker in CI: 24 with a literal `workers: 1` and 23 with `process.env.CI ? 1 : ...` (`reviews/harvest.md`). "Most suites run with workers: 1" is roughly half, in this pool.

### Every repo attempted

| Repo | Static class | Outcome here | Blocker / note |
|---|---|---|---|
| fixture-app (this repo) | n/a | runs | built to collide; reported separately and never pooled |
| lukevella/rallly | B | baseline green (137-140/140) | isolation: build-time origin baked into Next.js chunks and auth trusted origins (see below) |
| umami-software/umami | B | baseline green (browser suite 24/31, 7 stale tests CI does not run; API suite 271/271) | _pending_ |
| documenso/documenso | B | baseline partly run (`api` project 458/15/34 in 939 s) | over the 5-minute limit per run; CI's rate-limit bypass variable was refused by the sandbox's permission checker, so rate limits stay on |
| formbricks/formbricks | B | blocked | pgvector extension, Valkey, SpiceDB, S3, license key |
| hoppscotch/hoppscotch | — | blocked | no Playwright suite |
| Infisical/infisical | B | blocked | suite targets a deployed environment with real tokens |
| twentyhq/twenty | B | blocked | server requires Redis |
| langfuse/langfuse | B | blocked | ClickHouse, Redis, MinIO |
| calcom/cal.com | B | blocked (not attempted) | ~40 real third-party secrets; CI shards over 8 machines × 4 workers |
| rhonda-rodododo/llamenos-platform, gitroomhq/postiz-app, payloadcms/payload | — | not examined | the scout stopped after 3 green repos |

## Experiment A: isolation

Protocol: PLAN.md §5 (v3), reviewed in `reviews/experiment-a-protocol.md` before running. Verdict metric: median test phase (first test begin → last test end) at isolated N=1 divided by the same at isolated N=4. Every arm runs with `CI=true` and `--retries=0`. Each arm gets one discarded warm-up, then at least 3 rounds in rotated order, with rounds added while an arm's max/min exceeds 1.10.

### Fixture app (mechanism demonstration; never pooled with real repos)

Source: `data/results/fixture-app/experiment-a.json` (37 runs, all valid; every timed run started at 1-min load average < 1.0).

| Arm | Median test phase [min-max] | Speedup vs isolated@1 | Scheduling ceiling | Resource ceiling | Per-test inflation | Median end-to-end wall |
|---|---:|---:|---:|---:|---:|---:|
| baseline@1 (repo's own config, one shared app) | 6.47 s [6.21-6.66] | — | | | | 10.87 s |
| isolated@1 | 6.60 s [6.27-7.05] | 1.00 | 1.00 | 1.00 | 1.00 | 12.98 s |
| isolated@2 | 4.65 s [4.37-5.30] | 1.42 | 2.00 | 2.00 | 1.13 | 10.95 s |
| **isolated@4** | **4.47 s [4.39-4.81]** | **1.48** | 2.29 | 2.14 | 1.49 | 10.99 s |
| isolated@8 (oversubscribed: 8 > 4 cores; at most 5 tests ran at once) | 4.68 s [4.42-4.93] | 1.41 | 2.29 | 2.14 | 1.90 | 11.12 s |

"End-to-end wall" covers the whole command without the build: Postgres start, restore or migrate+seed, clone, app boot, tests and teardown for isolate, and `webServer` boot plus tests for the baseline.

- The shared-app suite fails at workers 4 in every run (`just fixture-collide`; `reviews/fixture.md`). Under isolation, workers 4 passes 12/12 in all 5 rounds: **zero new failures**.
- **Why 1.48x and not 4x.** The suite has 5 files and `fullyParallel: false`. `maintenance.spec.ts` alone takes 2.7 s of the 6.2 s serial run, so no worker count can beat 2.29x. Separately, one worker slot (Chromium, a Playwright worker, the app, its Postgres backends) uses 1.87 cores at N=1, so 4 cores hold about 2.1 slots. The measured 1.48x is 0.69 of the lower ceiling. Tests also run 1.49x slower each at N=4, which is contention.
- **Setup fraction.** Hooks and fixtures take 28% of summed test time, and the pre-test phase (runner start, workers, browsers, and `webServer` in the baseline) takes 14-18% of Playwright's wall time. Setup does not dominate this suite.
- **Harness effect.** baseline@1 / isolated@1 = 0.98, inside 0.85-1.15, so vs-baseline speedups can be quoted. Test phase: 1.45x at N=4 against the repo's own serial run. **End to end: 0.99x, no gain.** On a suite this short, the ~4 s isolate spends starting Postgres, cloning, booting apps and tearing down cancels the ~2 s saved in the test phase.
- **Snapshot cache effect** (reported separately, never inside a speedup): a cold isolated@1 run takes 15.95 s and a warm one 12.98 s, 1.23x. On the cold run, build takes 1.8 s and migrate+seed 0.9 s; on a warm run, restore takes 0.13 s.
- **Memory at N=8:** 926 MB peak. Apps take ~70 MB each; Postgres takes 364 MB, an upper bound because shared buffers are counted once per backend.

### Real repositories

**umami** (umami-software/umami @ ec0ff5038, Next.js 16 production build, Playwright 1.63, browser suite of 38 tests in 8 files, `fullyParallel: false`). Source: `data/results/umami/experiment-a.json` (21 runs, all valid; every timed run started below load 1.0). No umami file was changed.

| Arm | Median test phase [min-max] | Speedup vs isolated@1 | Scheduling ceiling | Resource ceiling | Median end-to-end |
|---|---:|---:|---:|---:|---:|
| baseline@1 (repo's own config and `webServer`) | 131.5 s [128.6-133.1] | — | | | 143.0 s |
| isolated@1 | 130.6 s [129.7-132.1] | 1.00 | 1.00 | 1.00 | 141.5 s |
| isolated@2 | 111.9 s [111.3-113.6] | 1.17 | 1.23 | 2.00 | 122.6 s |
| **isolated@4** | **100.3 s [100.2-101.3]** | **1.30** | 1.23 | 4.00 | 113.3 s |

- **Zero isolation failures.** The same 7 stale tests (tests CI does not run and that no longer match the app) fail in every arm, the baseline included, and pass in none. Every other test passes in every run.
- **The ceiling is file granularity, not CPU.** `tests/e2e/website.spec.ts` holds 3 serial tests that take 90 of the 111 s summed test time, so no worker count can beat about 1.23x without splitting that file. The measured 1.30x is slightly above that ceiling because the long file ran a little faster at N=4 than at N=1. One worker slot uses only 0.59 cores.
- **Harness effect 1.006.** Against the repo's own serial run: 1.31x in the test phase and 1.26x end to end.
- **Setup is small.** Hooks and fixtures are 10% of test time; the pre-test phase is 3-6% of Playwright's wall time.
- **Memory at N=4:** 2.2 GB peak. Each Next.js server takes 420-490 MB; Postgres takes 435 MB as an upper bound.

**umami API suite** (271 request-level tests; no browser; onboarding runs, not the timed protocol). Source: `data/results/umami-api/onboarding/`.
- With a plain config it passes 271/271 at N=1, but 75 tests differ from baseline at N=2 and 139 at N=4. The cause is **shared setup state outside the database**: the suite's `globalSetup` runs once in Playwright's main process, seeds only worker 0's app over HTTP, and writes `seed.json`/`openapi.json` under a host-keyed directory. The other workers fail with ENOENT.
- A config-only fix makes it pass 271/271 at N=1, 2 and 4. `db.seed` starts a temporary app on `seed` and runs umami's own global setup against it, so every copy inherits the seeded state. `API_SKIP_SEED=1` stops the run from reseeding.
- This is the "setup projects / globalSetup" hazard from RISKS R9, observed in a real repo.
- It was not timed: `isolate run --baseline` cannot start an app for a Playwright config without `webServer` (a gap recorded in the reviews).

**rallly** (lukevella/rallly @ fa6bfd478b, Next.js with Turbopack, Playwright 1.58.1, `workers: 1`).
- **Without the shared-origin mode, isolation fails at every N, N=1 included.** The build bakes `http://localhost:3201` into 63 client chunks and into the auth library's trusted origins. isolate's apps listen on random 127.0.0.1 ports, so pages never hydrate: 20 browser tests fail in every isolated arm. One mitigation that changed no rallly file failed, because `next.config.ts` ties `assetPrefix` to the same variable.
  Source: `data/results/rallly/onboarding-without-shared-origin/`.
- **With the shared-origin mode (D-014)**, subset L of 16 files and 70 tests, quick arms (1 run each, no warm-up, no load gate; a reduced protocol). Source: `data/results/rallly/quick-shared-origin-arms/`.
  - Baseline at workers 1: 70/70, test phase 143.7 s.
  - Isolated N=1: 70/70, 144.6 s. N=2: 70/70, 98.5 s (1.47x). N=4: 69/70, 99.0 s (1.46x), CPU 96% busy.
  - The one failure at N=4 was a 5 s `locator.waitFor` timeout that passed both solo reruns, so it is categorized as a timeout under load.
  - The proxy counted every request reaching its own worker's app and refused none.
- _The full protocol on rallly is pending._

**documenso** was not measured: its `api` project alone takes 939 s at workers 1, over the protocol's 5-minute limit, and CI's rate-limit bypass variable was refused in this sandbox. See HANDOFF.md.

## Experiment B: impact map

Protocol: PLAN.md §5 (v3), reviewed in `reviews/experiment-b-protocol.md` before running.

### Fixture app

Source: `data/results/fixture-app/experiment-b.json`: N=4, seed 20260928, three mutant kinds (throw, top-level literal, wrong-value return), two unmutated reference runs (no failures to exclude).

- **Targets.** All 15 source files, of which 8 are in some test's set, 6 are global and 1 is absent (`src/locals.ts`, types only, so no control mutant is possible). The sample has 10 files and 19 mutants.
- **Outcomes.**
  - 2 were not live: the `db.ts` mutants do not compile, because a leading `throw` makes TypeScript flag the next line.
  - 5 hit global files; 4 of those kept the app from starting at all, which counts as every test failing.
  - 2 top-level mutants broke nothing: a renamed session cookie, and a dead selector in `settings.js`.
  - 11 live, non-global mutants had failing tests, and all 11 were scored.
- **Recall.** With the default (function-level) global policy, **11 of 11 scored mutants had zero missed tests**, 95% Clopper-Pearson interval 0.715-1. Worst recall 1.0. No control could be made.
- **Selection.** Median over mutated files: 0.96 of tests by count and 0.97 by time. Only four files let `affected` skip tests: `routes/items.ts` and `js/items.js` select 4/12, `routes/settings.ts` and `js/settings.js` select 3/12, and `routes/home.ts` selects 11/12. Every test signs in through `auth.ts` and renders through `views.ts`, so those select everything.
- **Stability.** The N=4 and N=2 maps are identical, as expected for a deterministic app.
- **Strict policy.** Every bootLoaded file selects all tests, so 10 of the 11 scored mutants answer `all`.
- **Non-JS edits.** A migration SQL edit gives `all` (a seed/migration input); a `tsconfig.json` edit gives `all` (a test-support/config rule).

By the pre-registered rule, the claim holds only if the interval's lower bound is ≥ 0.9. That needs about 36 scored mutants with zero misses, and the fixture has too few source files to supply them. So the fixture shows the mechanism works (no miss), but it cannot establish Claim B. Its selection numbers also show the flip side: on an app where every test crosses the same core files, per-file selection saves little.

### Real repositories

_pending._

## What I would build next

_pending_
