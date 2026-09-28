# Results

Every number cites a committed file under `data/results/` or `experiments/recipes/`. The verdict rules were fixed before any data (PLAN.md §1, commit e5c5361). The plot is `data/results/speedup-vs-workers.png`, and `data/results/summary.md` has the generated tables.

## Verdicts

**Claim A (isolation gives close to N× on the test phase, with zero test edits and no new failures): inconclusive under the pre-registered rule. Every measurement is below the 2x falsification line.**
- **Why inconclusive.** The rule needs at least 3 real repos with a valid N=4 arm, and runs with a stateful unmanaged service ("isolation incomplete") are kept out of the median.
  - rallly's runs share one mailpit.
  - umami's run reports also carry the "isolation incomplete" label. The tool's scan found ClickHouse, Kafka and Redis clients in its dependencies. umami uses them only when their URLs are set, and none were.
  - So, literally, no real repo qualifies.
- **Most important number:** counting umami anyway (a post-hoc reading, logged in LOG.md at 17:04 UTC), its test-phase speedup at N=4 on the common passing subset, the re-timing the protocol requires, is **1.11x** (`data/results/umami-passing/`). On the full browser suite it is 1.30x, but 90 of that suite's 111 s of serial test time are three stale tests waiting out 30 s timeouts.
- **Context, not verdict evidence:**
  - The fixture (never pooled): 1.48x at N=4.
  - rallly: 1.54x at N=2, which is 0.77 of the 2x possible at N=2.
  - rallly at N=4, one mail catcher per worker: 1.58x. This is a control, indicative only: 3 rounds, no warm-up, spread 1.17 (over the 1.10 limit), only 1 of 3 rounds valid by the outcome rule, and the denominator comes from the main run.
- **This setup could not have supported Claim A.** The ceilings, computed from the N=1 runs, were already below the "holds" bar of 3x before any N=4 timing: fixture 2.14 (CPU), umami 1.15 on its passing subset (file layout; 1.23 on the full suite), rallly 1.83 (CPU). Neither real repo could reach even 2x. So the result does not separate "isolation does not scale" from "these suites on 4 cores cannot scale". A machine with more cores per worker slot, and suites with more, shorter files, are needed for a real test.
- **Isolation held only partly.** No new failures on the fixture or umami's browser suite. But umami's API suite lost 75 of 271 tests at N=2 and 139 at N=4 until a hand-written seed step was added. rallly had 5 isolation failures at N=4 with a shared mailpit, and with one mailpit per worker `login verify page` still failed in 2 of 3 rounds (a timeout at ~95% CPU). rallly also needed the shared-origin proxy even to run.
- **What capped the speedup.** (1) File-level scheduling: one serial file caps umami, and one caps the fixture at 2.29x. (2) CPU per worker slot: 1.9-2.2 cores on the fixture and rallly, so this 4-core machine fits about 2 slots.
- **Setup fraction.** Hooks and fixtures are 25-28% of test time on the fixture and rallly. On umami the figure is 10%, but only because stale-test timeouts fill the denominator. Over umami's passing tests, hook and fixture time is about equal to body time.

**Claim B (a per-test file map lets a PR run only the tests that executed the changed files, with the map close to complete): falsified by the pre-registered rule.**
- **Every trigger in the rule fires.** The CI lower bound is below 0.8 on both apps (fixture 0.715, umami 0.025). umami's map stability is below 0.9 (per-file Jaccard median 0.875). The median time-weighted selection ratio is at least 0.8 (fixture 0.97).
- **The recall trigger fires only because n is small.** 11 and 1 scored mutants, and no scored mutant was missed. So completeness is untested, not shown to be good or bad.
- **Most important number:** the fixture's median time-weighted selection ratio, **0.97**. It is pulled up by global files and by files every test crosses to sign in. Over the fixture's non-global files, the median is 0.39.
  - On umami: 0.21 by count. By time it is 0.96, but only with the non-live `useNavigation.ts` mutant included; without it, 0.66.
- **umami's stability number is confounded.** The N=4 trace started at load 3.78 and the N=2 trace at 0.7, so the difference between the two maps cannot be put down to the worker count alone.
- **On a Next.js production build**, 227 route files are global (preloaded at boot), and client code maps to nothing.
- Tracing produced a map on 1 real repo, not 3.

## Machine

Cloud sandbox VM (`cloudSandbox: true`): Intel Xeon @ 2.80 GHz, 4 cores, 1 thread per core, 1 socket, 15 GB RAM. Linux 6.18, Node 22.22.2, Postgres 18.4 (embedded-postgres binaries) running in `/dev/shm` with fsync, synchronous_commit and full_page_writes off. Playwright 1.56.1 on the fixture; each real repo uses its own pinned Playwright against the pre-installed Chromium 141 (revision 1194), which the harness exposes through a revision shim (DECISIONS D-010). Every timed run records its load average and CPU steal (`data/results/<repo>/runs/*.json`).

## Harvest and runnability

Pool: the 23-repo seed list plus awesome-selfhosted-data (daily star counts; snapshot 2026-09-28). GitHub search was blocked in the sandbox (LOG.md, 07:59), so the pool is self-hosted apps only and is not representative of GitHub at large.

| Stage | Count |
|---|---:|
| Repos in the pool | 998 |
| Qualified (Playwright config + DB evidence + ≥ 200 stars + pushed in the last 12 months) | **96** (target 100; pool exhausted) |
| Static class A / B / C | 1 / 36 / 59 |
| Examined by the scout, from a 12-repo shortlist ordered by expected feasibility | 9 (3 green, 6 blocked, cal.com among them without a run); 3 not examined |
| Repo's own suite green at baseline in this sandbox | 3 (rallly, umami, documenso partially) |
| Runs under isolate with no repo edits | 2 (fixture aside): umami (browser suite as-is; API suite with a config-only seeding step), rallly (with the shared-origin mode and, at N=4, one mailpit per worker) |

Why the 902 others did not qualify: 828 have no Playwright config, 74 have no database evidence (`data/harvest-summary.md`). Among the 96, the most common blockers are Redis (55), SMTP (50), S3/MinIO (41), Stripe (24), OpenAI (22), Anthropic (19), a Python backend (16), AWS (15) and BullMQ (14).

Static classes over-detect. The three repos that actually ran are all static class B, because optional integrations look like dependencies in `package.json` and `.env` examples.

Premise check. By their own config text, 47 of the 96 qualified repos run one worker in CI: 24 with a literal `workers: 1` and 23 with `process.env.CI ? 1 : ...` (`reviews/harvest.md`). "Most suites run with workers: 1" is roughly half, in this pool.

### Every repo attempted

| Repo | Static class | Outcome here | Blocker / note |
|---|---|---|---|
| fixture-app (this repo) | n/a | runs | built to collide; reported separately and never pooled |
| lukevella/rallly | B | baseline green (137/140 at workers 1; 3 lost to one timeout under load and its serial group) | measured on a 70-test subset with the shared-origin mode; shared mailpit breaks N=4 |
| umami-software/umami | B | baseline green (browser suite 24 passed + 7 stale failures + 7 not run of 38; API suite 271/271) | measured: Experiment A (browser suite) and Experiment B; API suite needs a config-only seeding step |
| documenso/documenso | B | baseline partly run (`api` project 458/15/34 in 939 s) | over the 5-minute limit per run; CI's rate-limit bypass variable was refused by the sandbox's permission checker, so rate limits stay on |
| formbricks/formbricks | B | blocked | pgvector extension, Valkey, SpiceDB, S3, license key |
| hoppscotch/hoppscotch | — | blocked | no Playwright suite |
| Infisical/infisical | B | blocked | suite targets a deployed environment with real tokens |
| twentyhq/twenty | B | blocked | server requires Redis |
| langfuse/langfuse | B | blocked | ClickHouse, Redis, MinIO |
| calcom/cal.com | B | blocked (not attempted) | ~40 real third-party secrets; CI shards over 8 machines × 4 workers |
| rhonda-rodododo/llamenos-platform, gitroomhq/postiz-app, payloadcms/payload | — | not examined | the scout stopped after 3 green repos |
| johanohly/AirTrail | **A** (the only static class A) | not attempted | the harvest finished after the scout had started from the seed list; it uses bun and a fake OIDC server as its `webServer`. Listed in HANDOFF.md |

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
- **Harness effect.** baseline@1 / isolated@1 = 0.98, inside 0.85-1.15, so vs-baseline speedups can be quoted. Test phase: 1.45x at N=4 against the repo's own serial run. **End to end: 0.99x, no gain.** Outside the test phase, isolate@4 spends 6.5 s (starting Postgres, cloning, booting apps, tearing down) against the baseline's 4.4 s (its own `webServer` boot and teardown). On a suite this short, those 2 extra seconds cancel the 2 s saved in the test phase.
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
- **The full-suite number mostly measures stale tests timing out.** `tests/e2e/website.spec.ts` holds 3 of the 7 stale tests; each waits out Playwright's 30 s timeout, so the file takes 90 of the 111 s summed test time in every arm, and the 7 stale failures take about 104 s (93%). The measured 1.30x is above the 1.23x file ceiling because the N=1 test phase (130.6 s) includes about 20 s outside test durations, not because the file ran faster: it took 90.2 s at both N=1 and N=4. This is why the protocol's re-timing on the passing subset (below) is the number that counts. One worker slot uses only 0.59 cores.
- **Harness effect 1.006.** Against the repo's own serial run: 1.31x in the test phase and 1.26x end to end.
- **Setup share.** Hooks and fixtures are 10% of summed test time, but only because stale-test timeouts fill the denominator. The pre-test phase is 3-6% of Playwright's wall time.
- **Memory at N=4:** 2.2 GB peak. Each Next.js server takes 420-490 MB; Postgres takes 435 MB as an upper bound.

**umami, re-timed on the common passing subset** (PLAN §5 step 5; recipe `umami-passing`). This covers the 4 spec files whose 23 tests passed in every baseline@1 round: 20 request-level API tests and 3 UI tests in `session-modal-dismiss.spec.ts`. Source: `data/results/umami-passing/experiment-a.json` (21 runs, all valid).

| Arm | Median test phase [min-max] | Speedup vs isolated@1 | Scheduling ceiling | Resource ceiling | Median end-to-end |
|---|---:|---:|---:|---:|---:|
| baseline@1 | 8.08 s [7.95-8.19] | — | | | 18.0 s |
| isolated@1 | 8.54 s [8.48-9.09] | 1.00 | 1.00 | 1.00 | 18.4 s |
| isolated@2 | 7.41 s [7.26-7.56] | 1.15 | 1.15 | 1.52 | 17.1 s |
| **isolated@4** | **7.72 s [7.55-8.07]** | **1.11** | 1.15 | 1.52 | 19.0 s |

- Zero isolation failures. The ceiling is again file layout: the 3 UI tests in one file take 5.8 of the 6.7 s serial sum.
- **End to end, N=4 is slower than the repo's own serial run** (0.94x): booting four Next.js servers costs more than the test phase saves.
- Hooks and fixtures take as long as test bodies here (setup share 1.03).
- Harness effect 0.95.

**umami API suite** (271 request-level tests; no browser; onboarding runs, not the timed protocol). Source: `data/results/umami-api/onboarding/`.
- With a plain config it passes 271/271 at N=1, but 75 tests differ from baseline at N=2 and 139 at N=4. The cause is **shared setup state outside the database**: the suite's `globalSetup` runs once in Playwright's main process, seeds only worker 0's app over HTTP, and writes `seed.json`/`openapi.json` under a host-keyed directory. The other workers fail with ENOENT.
- A config-only fix makes it pass 271/271 at N=1, 2 and 4. `db.seed` starts a temporary app on `seed` and runs umami's own global setup against it, so every copy inherits the seeded state. `API_SKIP_SEED=1` stops the run from reseeding.
- This is the "setup projects / globalSetup" hazard from RISKS R9, observed in a real repo.
- **Not run under the timed protocol** (single runs, load up to 1.17). With the seeding step, isolated N=1 took 93.5 s, N=2 70.5 s, and N=4 66.9-74.6 s (1.25-1.40x). A baseline through an app started by hand took 76.4 s, a harness effect of 0.82 (flagged). This is consistent with the browser suite and is not verdict evidence. `isolate run --baseline` cannot itself start an app for a Playwright config without `webServer`.

**rallly** (lukevella/rallly @ fa6bfd478b, Next.js 16 with Turbopack, Playwright 1.58.1, `workers: 1`). The full suite (495 s at workers 1) is also over the protocol's 5-minute limit. It was measured on a subset chosen after onboarding, weighted toward the files that failed there: a logged deviation (LOG.md, 17:04).

- **Without the shared-origin mode, isolation fails at every N, N=1 included.** The build bakes `http://localhost:3201` into 63 client chunks and into the auth library's trusted origins, while isolate's apps listen on random 127.0.0.1 ports. Pages never hydrate, so 20 browser tests fail in every isolated arm. One mitigation that changed no rallly file failed, because `next.config.ts` ties `assetPrefix` to the same variable. Source: `data/results/rallly/onboarding-without-shared-origin/`.
- **With the shared-origin mode (D-014)**, subset L: 16 files and 70 tests, including every file that failed above. The config sets `NEXT_PUBLIC_BASE_URL: '{origin}'`; no rallly file changed. One mailpit is shared by all workers (an unmanaged service: "isolation incomplete"). The protocol is labelled reduced because it runs a subset. Source: `data/results/rallly/experiment-a.json` (31 runs).

| Arm | Valid rounds | Median test phase [min-max] | Speedup vs isolated@1 |
|---|---:|---:|---:|
| baseline@1 | 5/5 | 135.3 s [134.7-141.3] | — |
| isolated@1 | 5/5 | 139.7 s [133.6-146.6] | 1.00 |
| isolated@2 | 4/5 | 91.0 s [87.9-95.3] | **1.54** (scheduling ceiling 2.00, resource ceiling 1.83) |
| isolated@4 | **0/5** | (98.3 s over all 5 runs, none valid) | n/a |

- **At N=4 every round had 1-4 failing tests (median 3), all timeouts, each passing when rerun alone.** Up to 15 serial siblings were skipped after a failure, so 2-16 outcomes differed from baseline@1 per round. Five tests failed in at least 2 of the 5 rounds (one in 3, four in 2). The harness kept the rule's absolute threshold of 2 when it added rounds, so they count as isolation failures. All are in specs that call `deleteAllMessages()` in `beforeEach` or wait for an email login code in a mailpit shared by the four workers.
- **Control: one mailpit per worker**, a config-only change: `SMTP_PORT: '323{i}'` for apps, `MAILPIT_API_URL: 'http://127.0.0.1:324{i}/api'` for tests. Source: `data/results/rallly/control-per-worker-mailpit/`, 3 rounds, each started below load 1.0.
  - Failing tests per round went from 1-4 (median 3) with the shared mailpit to 2, 1 and 0. The email-login tests all passed.
  - The remaining failures (`login verify page`, a 5 s wait; `create a new poll`, a 30 s timeout) happened at 89-95% CPU: timeouts under load.
  - Median test phase 88.7 s, **1.58x** against isolated@1, over 3 rounds. Under the protocol's outcome rule only the clean round would be valid, and alone it gives 1.65x. This is a control with n = 3, not a protocol measurement.
- **The wider picture.** Harness effect 0.97; hooks and fixtures are 25% of test time. One worker slot uses 2.18 cores, so this machine cannot fit more than about 1.8 slots of rallly. Peak memory at N=4 was 3.9 GB.

**documenso** was not measured: its `api` project alone takes 939 s at workers 1, over the protocol's 5-minute limit, and CI's rate-limit bypass variable was refused in this sandbox. See HANDOFF.md.

### After the sprint: `just compare` against each repo's own setup (not part of the pre-registered protocol)

`just compare <repo>` times the repo's own Playwright setup ("theirs": its config and worker count, one app, one database, `CI=true`) against `isolate run --workers N`. These numbers are exploratory. Each is one round on the 4-vCPU sandbox, some with other work running on the machine, so they do not count toward Claim A's verdict.

| Repo (commit) | Scope | Theirs | isolate@4 | Wall speedup | Test-phase speedup |
|---|---|---|---|---|---|
| evershop (18e0202) | 164 tests; their config: 1 worker, "Shared DB" | 5m 41.6s, 132 passed, 15 failed | 2m 43.8s, 137 passed, 12 failed | 2.09x | 2.41x |
| documenso (a1d4bec) | `e2e/api/v1`, 44 tests; their config: 10 workers | 1m 04.8s, 43 passed, 1 failed | 58.4s, 44 passed, 0 failed | 1.11x | 1.46x |

- **evershop** is the first real repo above 2x. It is a single noisy round: documenso's install and build ran on the same machine during part of it. The failures differ between arms and between runs:
  - 7 tests failed only in their setup, mostly drag-and-drop page-builder specs.
  - 4 tests failed only under isolate, all with HTTP 429 from EverShop's own in-memory rate limiter (120 API requests per minute per IP, per app process). That limit is per app, so it is not state leaking between workers.
  - Details: `data/results/evershop/compare-sandbox-2026-09-28.txt`.
- **Making evershop run needed two isolate features** (DECISIONS D-015, D-016):
  - its globalSetup creates an admin session in the database, which now runs once and is copied to every worker;
  - its suite expects a running server, which `--baseline --app` provides for the comparison.
- **documenso's** `api` project already runs 10 workers against one app, so the headroom is small. Their one failure was a connection reset under that load.
- **documenso on an Apple M5 Pro (18 cores), same subset, run by the user** (`data/results/documenso/compare-mac-2026-09-28-api-v1.txt`): theirs@10 13.0 s; isolate@2 22.2 s, @4 16.3 s, @8 18.6 s. All arms passed 44/44. isolate lost on wall time, for four reasons (LOG.md 21:22):
  - The suite is parallel already, and nothing shared holds it back.
  - compare's default arms (2, 4, 8) all ran fewer workers than theirs.
  - The test phase is 5 s, so fixed cost decides: isolate@8 spent 13.5 s outside it against 8.0 s for theirs.
  - The reporter counted skipped tests as the start of the test phase. Corrected, isolate@8's test phase (5.07 s) ties theirs@10 (5.01 s) with 20% fewer workers.
  
  DECISIONS D-017 cuts isolate's fixed cost: database copies about 12x faster, teardown about 5x faster. compare now picks its arms from their worker count and says when a suite is already parallel. A 5-second suite that is already parallel is still not one isolate can win.

## Experiment B: impact map

Protocol: PLAN.md §5 (v3), reviewed in `reviews/experiment-b-protocol.md` before running. Deviations: Experiment B on the fixture ran before Experiment A, at N=4, not at "the best N from Experiment A" (LOG.md 10:35), and without the load gate. B measures which tests fail, not time, but load can still change which tests time out, and it changes the umami maps (below).

### Fixture app

Source: `data/results/fixture-app/experiment-b.json`: N=4, seed 20260928, three mutant kinds (throw, top-level literal, wrong-value return), two unmutated reference runs (no failures to exclude).

- **Targets.** All 15 source files, of which 8 are in some test's set, 6 are global and 1 is absent (`src/locals.ts`, types only, so no control mutant is possible). 12 files were sampled; 10 of them could be mutated, giving 19 mutants.
- **Outcomes.**
  - 2 were not live: the `db.ts` mutants do not compile, because a leading `throw` makes TypeScript flag the next line.
  - 5 hit global files; 4 of those kept the app from starting at all, which counts as every test failing.
  - 2 top-level mutants broke nothing: a renamed session cookie, and a dead selector in `settings.js`.
  - 11 live, non-global mutants had failing tests, and all 11 were scored.
- **Recall.** With the default (function-level) global policy, **11 of 11 scored mutants had zero missed tests**, 95% Clopper-Pearson interval 0.715-1. Worst recall 1.0. No control could be made.
- **Selection.** Median over mutated files: 0.96 of tests by count and 0.97 by time (0.39 by time over the non-global files alone). Only five files let `affected` skip tests: `routes/items.ts` and `js/items.js` select 4/12, `routes/settings.ts` and `js/settings.js` select 3/12, and `routes/home.ts` selects 11/12. Every test signs in through `auth.ts` and renders through `views.ts`, so those select everything.
- **Stability.** The N=4 and N=2 maps are identical, as expected for a deterministic app.
- **Strict policy.** Every bootLoaded file selects all tests, so 10 of the 11 scored mutants answer `all`.
- **Non-JS edits.** A migration SQL edit gives `all` (a seed/migration input); a `tsconfig.json` edit gives `all` (a test-support/config rule).

By the pre-registered rule, the claim holds only if the interval's lower bound is ≥ 0.9, and it is falsified below 0.8. The fixture's 0.715 trips the falsification line on sample size alone: reaching 0.9 with zero misses needs about 36 scored mutants, and the fixture has too few source files to supply them. So the fixture shows the mechanism works (no miss), but it cannot establish Claim B. Its selection numbers also show the flip side: on an app where every test crosses the same core files, per-file selection saves little.

### Real repositories

**umami** (Next.js 16 production build, Playwright 1.63, traced through the version-independent auto-fixture hook; browser suite; N=4; throw mutants; 10 targets drawn with seed 20260928 from 1,126 source files). Source: `data/results/umami/experiment-b.json`, maps `map-w4.json` / `map-w2.json`, and `trace-map-w2.json` from a separate spike.

- **The map is lopsided.**
  - Server code source-maps back to `src/`. But 227 source files are global, because Next.js's `preloadEntriesOnStart` runs every route module at boot, so any edit to one of them selects every test.
  - 156 source files (pages and components rendered per request) have per-test sets.
  - Client code resolves to no source file: production builds ship no browser source maps, and 49-72 chunk URLs stay unresolved (49 in the N=2 map, 72 in the N=4 map).
- **The map is not stable.** Across the N=4 and N=2 builds, the per-file Jaccard of selecting tests has median 0.875 and minimum 0.5, over 215 files. Over the 155 non-global files that selection actually uses, the median is 0.5. The N=4 trace started at load 3.78 (right after the fresh checkout's build) and the N=2 trace at 0.7, so the instability is confounded with load. That is below the pre-registered 0.9, so, per the spec, the rest of this experiment is weaker. Per-test file sets are identical for most tests (median 1.0) but not all (minimum 0.157). This is consistent with async requests (prefetches, polling) crossing test boundaries: 3 between-test takes found code.
- **The mutation study says more about the suite than about the map.**
  - 9 mutants, 1 not live (a React hook mutant broke the build).
  - 7 of the 8 live mutants changed no test outcome. The 7 stale tests fail with or without the mutant, so they are excluded from F. For all 7, the harness found the mutated function was never executed by any test, which says the 38-test suite does not reach those pages.
  - One mutant (`websites/[websiteId]/layout.tsx`) broke 3 tests, all 3 predicted (4 selected).
  - Headline 1/1, 95% CI 0.025-1: nothing can be concluded from it.
  - The 2 live controls (files in no test's set) broke nothing.
- **rallly (Playwright 1.58.1) and documenso** were not traced: time went to making rallly isolate at all (the shared-origin mode) and to its full Experiment A. rallly is a Next.js/Turbopack production build, so we expect, but did not verify, that the same boot-time preloading and missing client source maps apply.

Tracing produced a usable map on one real repo, not three. **That is the Experiment B result on real repos:** on a Next.js production build, file-level impact maps are lopsided and unstable. Most route code is global, client code is invisible, and attribution differed between two traces taken at different N and load. The fixture, a plain Express app compiled with `tsc` with source maps, is the only place where the map was both stable and precise.

## What I would build next

1. **Setup before cloning.** Run `globalSetup` and Playwright "setup" projects once against an app on `seed`, then clone, so auth sessions and seed files exist in every copy. umami's API suite needed exactly this; I built it there by hand in config.
2. **Detect baked origins and turn on the shared origin automatically.** Scan built chunks for `localhost:<port>`. Without this, rallly fails at N=1.
3. **Per-worker side services.** Start one SMTP catcher per worker, and give each worker its own Redis logical database or key prefix. rallly's shared mailpit is still a collision source; Redis blocks 55 of the 96 harvested repos.
4. **Split long serial files where the file ceiling binds.** Test-level scheduling for files that do not use `describe.serial`. None of the measured real repos showed this cleanly: umami's long file is three stale tests timing out, and rallly is bound by CPU (resource ceiling 1.83). The fixture is bound by its file layout (2.29).
5. **Tracing bundled servers.** Treat bundler module factories as top level, so Next.js's boot-time preloading does not make every route global. Also generate production source maps for trace builds.
6. **`--baseline --app`** for configs without `webServer`, and reruns at the same N, so failures caused by load are not relabelled "flaky".
7. **PSS instead of RSS** for memory, so Postgres shared buffers are not counted once per backend.
