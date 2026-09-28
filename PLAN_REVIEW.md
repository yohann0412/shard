# Plan review

A hostile read of PLAN.md v1. Written by the lead, with three independent reviewer passes run as subagents, each given a different lens: measurement validity, technical mechanism, and process/honesty. Each item says what changed in PLAN.md v2. Items that do not change the plan say why.

## The questions the spec requires

**Which assumption, if wrong, kills the whole sprint? Is its verification first?**
The assumption is that a worker can be pointed at its own app with zero test edits. Everything else in Claim A depends on it. It was verified first, before any feature code, by the throwaway experiment in LOG.md (08:10). That experiment falsified the spec's literal mechanism: a preload reads `TEST_PARALLEL_INDEX` as `undefined`. It confirmed a working one: a generated config that Playwright re-evaluates in each worker after the index is set. The second sprint-killer is whether any real repo can run at all in a 4 vCPU sandbox with no Docker-managed services and no GitHub search. That is checked early by starting the harvest in parallel with Phase 1 rather than after Phase 2. PLAN §6 now schedules it that way.

**How does a worker get a different `baseURL` with zero test edits? Is it confirmed that Playwright re-evaluates the config in each worker and that `TEST_PARALLEL_INDEX` is set first?**
Confirmed from Playwright 1.56.1 source (`workerMain.js`: the constructor sets the env var, `_loadIfNeeded` loads the config afterwards) and by experiment (12/12 tests on the right server, CJS and ESM, 3 and 4 workers). The mechanism is D-001. The check is not assumed to hold for other Playwright versions. Every real-repo run verifies routing from outside the test process (per-worker database activity from `pg_stat_database`, and per-app request counts in the app logs). A run where some used worker's app saw no traffic is marked invalid.

**Where does time go in a Playwright suite (setup vs test vs teardown), and how is it measured per repo rather than assumed?**
v1 said "JSON reporter". That does not work: the JSON reporter drops hook and fixture steps. v2: the `isolate` timing reporter runs in **every** arm, including the baseline, through a pass-through wrapper that keeps the repo's `webServer`, `workers` and env unchanged (measurement review, finding 1). It records on a monotonic clock: config load → first test begin (pre-test: webServer boot, globalSetup, worker and browser start), first test begin → last test end (test phase), last test end → end (teardown), and per test the time in `hook`/`fixture` steps vs the rest.

**What confounds could make the speedup look better than it is? How does the protocol control each?**

| Confound | Control in v2 |
|---|---|
| Baseline's Playwright wall time includes webServer boot (often a build) while isolated arms boot apps outside Playwright | The **test phase** (first test begin → last test end) is the same span in every arm. Pre-test and teardown are reported separately. |
| Warm caches in later arms (page cache, `.next/cache`, V8 compile cache, first Chromium launch) | One discarded warm-up run per arm, then **3 rounds** in an interleaved order rotated each round. Median and min-max reported; a 4th round is added if max/min > 1.10. |
| Build/snapshot savings counted as isolation speedup | The build runs once before timing, in no arm's number. The F5 cache effect is its own number (isolated cold vs warm), never part of a speedup. |
| Different database in baseline (disk, fsync on) vs isolated (RAM, fsync off) | Baseline runs against a fresh copy of `seed` on the same isolate-managed Postgres server with the same settings. The "harness effect" is reported as baseline@1 / isolated N=1; a repo outside 0.85-1.15 is flagged and its vs-baseline speedup is not quoted. |
| Verdict denominator ambiguous | Claim A's verdict is the **median across repos of test-phase(isolated N=1) / test-phase(isolated N=4)**. The baseline speedup is context. |
| Requested N is not the concurrency achieved (`fullyParallel: false`, few files, a `--workers` flag in an npm script) | The reporter records resolved workers, distinct parallel indexes and the maximum number of tests running at once. Experiments call `playwright test` directly. A run labelled N=k whose observed concurrency is below k is labelled with what it achieved. The scheduling ceiling T1 / max(T1/N, longest file) is reported next to the speedup. |
| CPU contention / SMT / noisy neighbours | `lscpu` threads per core, and CPU busy and steal per run from `/proc/stat`, recorded. Per-test inflation (sum of test durations at N / at N=1) reported as the direct contention measure. N > cores labelled oversubscribed. |
| A flaky or failing baseline finishes early; fail-fast tests under isolation finish early | All timing arms use `--retries=0` and `PLAYWRIGHT_HTML_OPEN=never`. A timed run counts only if its per-test outcomes match the reference baseline's; otherwise every arm is re-timed on the common passing subset. |

**What confounds could make the impact map look more complete than it is? How does the protocol control each?**

| Confound | Control in v2 |
|---|---|
| Mutation targets drawn from the map itself, so files the tracer never sees can never be targets | Targets drawn from the repo's full source set (`git ls-files` minus tests), seeded, stratified by map status (in a test set / bootLoaded only / global / absent). Recall reported per stratum. |
| Controls that are dead code can never fail | Controls are the "absent" stratum. A control is reported as live or not live, and only live controls count. |
| Throw-in-function mutants fire only where the tracer already recorded execution, so recall ≈ 1 by construction | The throw mutant is kept as a check on the plumbing. v2 adds **top-level** mutants (a module-scope literal) and **wrong-value** mutants (early return of a plausible wrong value) on the fixture, and on real repos where time allows. |
| Mutant not live (not in the build, tree-shaken, stale cache) counted as "suite weakness" | A liveness check: the mutant string must appear in the built output served during the run. Non-live mutants are reported separately. |
| Flaky tests counted as hits or misses | F = tests failing with the mutant, minus tests failing in 2 unmutated reference runs at the same N. |
| Global-file mutants score recall 1 for free | Reported separately and excluded from headline recall. |
| Small n | Headline = fraction of live, non-global mutants with zero missed tests, with n and a 95% Clopper-Pearson interval; the claim is judged on the lower bound. |
| Jaccard over per-test file sets is dominated by files every test runs | Stability is measured per file: the Jaccard of the set of tests that select it across two builds, over files selected by < 50% of tests. The second build uses a different N, so misattribution to neighbouring tests shows up. |
| Selection ratio treats tests as equal cost | A time-weighted selection ratio is reported next to the count ratio. "Useless" is defined as a time-weighted ratio ≥ 0.8 for the median mutated file. |
| Client coverage resets on navigation | `startJSCoverage({ resetOnNavigation: false })`. |

**Redis, S3, queues, third-party APIs?**
Out of scope for V1, in writing (PLAN §1 scope note, README "what it does not do"). `isolate init` detects them from dependencies, `.env` example keys and compose files. It refuses to write a config without `--allow-unmanaged`, and records the services in the config so every report shows them. Harvest classifies repos that need them as B (fakeable) or C (real credentials). Under `--allow-unmanaged` all N apps share the real service, so any collisions through it are the user's; failures of that kind are categorized "unmanaged service".

**Can a subagent report success without the acceptance test actually passing?**
Yes, in four ways. Each is closed:
1. It edits the acceptance test. Closed: the lead writes and commits the tests first. Subagents may not touch `e2e/`, and the lead diffs `e2e/` on every review.
2. It reports a run that did not happen, or a stale one. Closed: the lead re-runs every acceptance test from a clean build (`pnpm build` then `just e2e-one <name>`) in the main tree, after merging, before committing.
3. It passes by special-casing the fixture (e.g. hardcoding `w0`). Closed: the review reads the full diff for fixture-specific strings. The final `just e2e` runs the tests against copies of the fixture made with `copyFixture()`, and F2's test regenerates the config from scratch.
4. The test itself is too weak. Closed partially: each review file has a "what was not tested" section, and the fixture's collisions must fail 5/5 and pass 5/5 serially.

## Other findings and what changed

- **Setup projects and `globalSetup` write auth state into one worker's database** (lead). Other workers then reuse a `storageState` whose session is not in their database. v2: the run prints a warning when the config has `globalSetup` or project `dependencies`, and failures of this kind get their own category. This is also the most likely real-world failure mode, so RESULTS.md must report it prominently.
- **Build cache keyed only on lockfile + migrations + seed + config would restore a stale build after a source edit** (lead). v2: split keys (D-009).
- **Top-level module code at boot makes "global" swallow every route file** (lead). v2: D-011 (function-level global; `--strict` for the file-level policy). Both policies are scored.
- **Fixture design must make the F7 acceptance meaningful** (lead). Sign-in must not redirect to the items page, or every test executes the listing handler. The fixture spec forbids non-item tests from touching items routes.
- **Time budget** (process). One session is not two weeks. The cut order stands. Real-repo Experiment A is limited to repos whose baseline takes ≤ 5 min at workers=1 in this sandbox. Longer suites get a HANDOFF entry with exact commands.

## Items not adopted

- *Run each arm's build inside the timing too.* Not adopted: build time is not what Claim A is about. It is reported once per repo instead.
- *Linux network namespaces as the primary mechanism.* Not needed; D-001 works. Namespaces stay as the fallback in RISKS R1.

## Addendum: mechanism and process reviews (arrived after v2; PLAN.md is now v3)

Two more reviewers finished after v2 was committed. Their findings and what changed:

| Finding | Severity | Change |
|---|---|---|
| Postgres refuses to run as root, and this sandbox is root; `pg_ctl start` calls `setsid()` and escapes process-group kills | kills F1 | F1 runs `initdb`/`postgres` through `setpriv` as the `postgres` system user (or a created `isolate-pg`) when uid is 0, starts the postmaster directly (never `pg_ctl`), marks every spawned tree with `ISOLATE_RUN_ID`, and sweeps `/proc/*/environ` for survivors on teardown and in the reaper (R17). Sent to the F1/F3 subagent before it reached acceptance. |
| Nothing checks early that any real repo runs here | kills sprint | A real-repo scout subagent started at 08:35, in parallel with F1/F3, attempting baselines for up to 12 candidates. Gate at 10:00: if fewer than 2 repos are green, feature work beyond F1-F4/F6 stops and the time goes to repo onboarding. |
| Budget ends after the 12:00 UTC no-resume cutoff; cut order wrong | kills sprint | Clock checkpoints (PLAN §6). New cut order: F5 first, then F2 auto-detection (keep the unmanaged scan), then F7 client coverage, then Experiment B scope. |
| Acceptance tests could pass on stale state or by comparing the tool with itself | major | Tests hardened (commit ca4ad31): f4 deletes `.isolate/` first and adds an invalid-routing case (apps forced onto `w0`, as a `.env` override would do) that must exit non-zero with `routingValid: false`; f5 counts build/migrate/seed side effects outside the tool; f6 measures wall time outside the tool and rejects unknown phase keys; f7 adds a negative control (an unused file selects nothing). The lead diffs `e2e/` on every review. |
| Verdict not pre-registered; hardware may decide it | major | PLAN §1 is the pre-registration (timestamped in LOG.md, 08:40). With fewer than 3 real repos Claim A is reported per repo and labelled "inconclusive"; the fixture is never pooled with real repos. The resource ceiling min(N, cores/d), where d is the CPU demand of one worker slot measured at N = 1 from `/proc/stat`, is reported next to each speedup. |
| `CI` and retries differ between arms | major | Every timed arm runs with `CI=1` and `--retries=0` on the command line; the repo's resolved workers/retries are recorded. |
| No written V1 scope for unmanaged services | major | D-012 and PLAN §1 "Scope". Detection also runs at the start of every `isolate run` and is written into report.json; runs with a stateful unmanaged service are labelled "isolation incomplete" and kept out of the Claim A median. |
| Honesty rules never written | major | PLAN §8. |
| Parallel subagents distort timings | major | Timed experiment runs happen only when no subagent is running; each run records load average at start and is redone if the 1-min load average is above 1.0. |
| globalSetup / setup projects write auth into one database | kills Claim A on real repos | Kept as a measured failure category for V1. A two-phase run (setup against `seed`, then clone) is designed in RISKS R9 and will be built only if the scout shows candidate repos depend on it; otherwise it goes to "what I would build next". |
| Isolated apps not started like `webServer` (env, cwd); N Next.js processes share `.next` (dev lock, ISR cache) | major | `init` derives the start command and env from the resolved `webServer` (via a probe config loaded by Playwright). Next.js `.next` sharing is R18, verified per repo. |
| Pinned ports, self-URLs, baked `NEXT_PUBLIC_*` URLs | major | `init` scans for `localhost:<port>` and `-p <port>` and templates them with `{port}`/`{url}`. Port virtualization with Chromium `--host-resolver-rules` stays a documented fallback (R11), not built unless a real repo needs it. |
| Routing check is weak on real apps | major | Kept: per-worker database activity (now tested by the invalid-routing e2e case). Added: the listener on P_i must belong to app i's process group. The limits of the check are stated in RESULTS.md. |
| Next.js bundles defeat source maps and the function-level global rule | major | R19. Experiment B on a Next.js repo starts with a 30-minute spike; if maps are missing, the trace build uses a generated config with server source maps, labelled "trace build modified", or Experiment B is limited to unbundled servers plus the fixture. |
| Coverage takes via Runtime.evaluate re-enter the inspector, are large, and misattribute in-flight requests | major | D-013: the app preload takes coverage in-process on request over a local socket, filters to repo files, and waits (up to 2 s) for in-flight HTTP requests to finish. The worker hook awaits both takes. |
| `max_connections` too low for N apps with Prisma pools | minor | 50 + 40*N; "too many clients" in postgres.log invalidates a run. |
