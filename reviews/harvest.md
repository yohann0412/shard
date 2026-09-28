# Review: Phase 3 harvester

Subagent report: 998 repos scanned (23 seed + 975 from awesome-selfhosted-data after filters), 96 qualified (target 100, pool exhausted), classes A 1 / B 36 / C 59; 5 hand spot-checks, 2 detector bugs fixed. Lead read the classifier and summary, ran a 30-repo smoke run (`--limit 30`: 30 scanned, 17 qualified, then restored the committed data), and cross-checked the records of the three repos the scout actually ran.

## What could be wrong

- **The static classes disagree with reality.** rallly, umami and documenso are class B here (Redis, S3, queues, Stripe detected from dependencies and `.env` examples), yet the scout ran all three suites with none of those services (rallly needed only an SMTP catcher). Dependencies and env keys over-detect: code that supports an optional service looks like code that needs it. So "1 class A" understates runnability. RESULTS.md must present the static class as a static heuristic and the scout's outcome as the observed one, side by side, and not as the same thing.
- **Pool bias.** Only self-hosted apps (awesome-selfhosted) plus the seed list: no SaaS monorepos, no libraries, no internal tools. Star counts come from one daily snapshot; four seed repos have unknown stars.
- **"Qualified" depends on a crude database test** (a `.prisma` file, a drizzle config, a compose file mentioning postgres, or `DATABASE_URL` in an env example). Ghost (MySQL via compose) is correctly excluded under that rule; an app using Postgres through a differently named variable would be wrongly excluded.
- **The configured-workers figures are text, not resolved values.** "1 on CI" is read from the expression `process.env.CI ? 1 : ...`, not from running the config.

## What was not tested

- Every one of the 96 records by hand (5 spot-checks + ~15 targeted reviews).
- Repos outside GitHub (awesome-selfhosted non-GitHub URLs were filtered out: 224).
- The whole 998-repo run by the lead (the smoke run covered 30).

## What was assumed

- That HEAD commit date is a fair proxy for "pushed in the last 12 months".
- That a Playwright config anywhere (including example/fixture directories) counts for qualification, per the spec's "anywhere"; the detectors ignore those directories when reading settings.

## Premise check from this data (configured `workers` expression across the 96 candidates)

| Configured workers | Candidates |
|---|---:|
| literal `1` | 24 |
| `1` on CI, more locally (`process.env.CI ? 1 : ...`) | 23 |
| other expression | 21 |
| more than 1 on CI (CI-conditional) | 12 |
| not set (Playwright default: half the cores) | 10 |
| fixed > 1 | 6 |

47 of 96 (49%) run a single worker in CI by their own configuration. "Most suites run with `workers: 1`" is therefore roughly half, in this pool, by static reading.

Verdict: accepted, with the classification caveat carried into RESULTS.md.
