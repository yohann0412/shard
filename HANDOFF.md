# Handoff

This sprint ran in a 4 vCPU cloud sandbox. It had no Docker and no GitHub search API, only a pre-installed Chromium 141, and it ran as root. Some of the work could not be done there. This file lists what ran, what did not, and the exact steps a human can use to finish it on a laptop or a bigger machine. For expected durations, see [HOW_TO_RUN_LOCALLY.md](HOW_TO_RUN_LOCALLY.md).

## What ran here

- The tool, F1-F7, with every acceptance test green on the main branch (`just e2e`).
- The fixture demo and both experiments on the fixture.
- The harvest: 998 repos scanned, 96 qualified (`data/repos.json`).
- A real-repo scout that tried 12 candidates: 3 ran green at baseline and 6 were blocked (`experiments/recipes/SCOUT_LOG.md`).
- Experiment A on umami (browser suite) and on rallly (70-test subset, with the shared-origin mode), plus a per-worker mailpit control on rallly.
- Experiment B on umami (10 targets).

## What did not run here, and how to run it

| Item | Why not here | What to do |
|---|---|---|
| documenso, full Experiment A (a runnable recipe for `just compare documenso` now exists) | Its `api` project alone takes 939 s at workers 1, which is over the protocol's 5-minute limit for this sandbox. Its CI also sets `DANGEROUS_BYPASS_RATE_LIMITS=true`; the sandbox's permission checker refused that variable, so our documenso runs keep rate limiting on. | On a machine with ≥ 8 cores: follow `experiments/recipes/documenso.json` (install, build, env), set the bypass variable the way its CI does (both arms), then run `just experiment-a documenso`. Expect ~16 min per baseline@1 run and ~1 h for the whole protocol. |
| N = 8 on real repos | 4 vCPU; the protocol skips N > cores | Run the same `just experiment-a <name>` on an 8+ core machine. The harness adds N = 8 automatically when cores ≥ 8. |
| cal.com, formbricks, twenty, langfuse, infisical | Need Redis, ClickHouse, S3, pgvector, SpiceDB or real third-party credentials (details per repo in `experiments/recipes/*.json`) | Out of V1's scope (DECISIONS D-012). A V2 that manages Redis (one logical DB or key prefix per worker) would unlock twenty and part of cal.com. |
| llamenos-platform, postiz-app, payload | Not examined: the scout stopped after 3 green repos, as instructed | `just repo <git-url>` clones, runs `isolate init --allow-unmanaged` and writes a draft recipe. |
| johanohly/AirTrail (the harvest's only static class A) | The harvest finished after the scout had started from the seed list; not attempted | `just repo https://github.com/johanohly/AirTrail`, then fill in the recipe: it uses bun (`bunx playwright test`), SvelteKit and Prisma with Postgres, and its e2e script starts a fake OIDC server as the Playwright `webServer`, next to the app started by `start-server-and-test`. Expect a second `webServer` entry for isolate's `app` config to reproduce. |
| macOS | Sandbox is Linux | `just e2e` on a Mac. Postgres runs from a temp directory on disk and logs "database is on disk, not RAM". The root-only `setpriv` path is skipped. |
| Experiment B on rallly and documenso | Time went to making rallly isolate at all (the shared-origin mode) and to its full Experiment A. Each umami mutant also needs a ~3.5-minute Next.js rebuild. | `just experiment-b rallly` (Playwright 1.58.1, traceable through the `_runTest` patch; start mailpit first). Expect ~2-3 h for 20 targets because of the rebuild per mutant. |
| rallly's full suite (140 tests) under isolation | Protocol limit: ~8 min per run at workers 1; the subset L covers every file that failed during onboarding | Drop `playwrightArgs` from `experiments/recipes/rallly.json`, give each worker its own mailpit (see the control's `isolate.config.ts` under `data/results/rallly/control-per-worker-mailpit/`), and run `just experiment-a rallly` on ≥ 8 cores. |
| umami's API suite, timed | Its globalSetup seeds one server over HTTP and keys the seed file by host, which the fan-out (DECISIONS D-015) does not change | `isolate run --baseline --app` now exists (D-016); time the suite with the config-only seeding step from `experiments/recipes/umami.json` (`isolateConfigApiSuite`). |
