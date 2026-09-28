# Big Playwright suites: where isolate could matter

Scanned 2026-09-28: the 96 repos from `data/repos.json` plus 21 well-known apps (`repos.txt`), 117 in all. Each was shallow-cloned and scanned with `scan-suite.mjs`, which counts Playwright spec files and `test(` calls and reads CI workflows for shard counts and `timeout-minutes`. Raw output is in `scan.json`.

**What this can't tell you:**
- **Real CI run times.** GitHub's API and Actions pages were blocked from the sandbox. Suite size, shard counts, CI time limits and the projects' own comments stand in for them.
- **Exact test counts.** They come from a regex, so they're approximate. Parameterized tests count once, and repos with unusual layouts come out low: misskey and linkwarden show 0, and ever-gauzy's BDD scenarios aren't counted.

## Projects that say a shared database or server limits their workers

These are quoted from their Playwright configs. It's exactly the problem isolate targets.

| Repo | Stars | DB | Tests (approx.) | What their config says |
|---|---:|---|---:|---|
| ever-co/ever-gauzy | 8k | Postgres (TypeORM) | 82 BDD scenarios | `workers: 1` always: "This suite is built around ONE accumulating database… Serial execution roughly doubles local wall-clock (~47min -> ~90min); running this suite in parallel needs per-worker accounts/organizations". CI jobs have 180–360 min timeouts. **Caveat:** "specs create data other specs consume", so per-worker databases would break those specs unless each worker runs a self-contained chain. |
| evershopcommerce/evershop | 10k | Postgres | 145 in 48 files | `fullyParallel: false, // Shared DB`, `workers` defaults to 1 |
| documenso/documenso | 15k | Postgres (Prisma) | ~1,180 in 135 files | API project: `workers: 10, // Limited by DB connections before it gets flakey`; another project: `workers: 1, // Must run serially since they share a license file`. The API project alone took 939 s at 1 worker in this sprint. A recipe exists: `experiments/recipes/documenso.json`. |
| n8n-io/n8n | 206k | Postgres or SQLite | ~1,200 in 289 files | "limited to 6 as higher causes instability in the local server"; CI splits into up to 20 duration-weighted shards; some workflows allow 240 min |
| twentyhq/twenty | 58k | Postgres + Redis | 13 in 6 files (small today) | `workers: 1, // 1 worker = 1 test at the time, tests can't be parallelized` |
| lukevella/rallly | 5k | Postgres | 144 in 36 files | `workers: 1`. Already measured here: 1.5x at 4 workers (RESULTS.md) |
| misskey-dev/misskey | 11k | Postgres + Redis | not counted | `fullyParallel: false`, `workers: 1`; a CI job allows 90 min |

## Largest suites overall, whatever their DB

| Repo | Tests (approx.) | Files | CI shards | Longest CI timeout (min) | Workers on CI | Fit for isolate V1 (Postgres only) |
|---|---:|---:|---:|---:|---|---|
| snapotter-hq/SnapOtter | 2,023 | 91 | 4 | 120 | 1–2 | Postgres, but also Redis, S3, BullMQ |
| payloadcms/payload | 1,923 | 126 | per-suite jobs | 45 | 16 | Default DB is MongoDB; Postgres adapter exists |
| toeverything/AFFiNE | 1,507 | 226 | 5 | 40 | 1 (cloud tests) | Postgres + Redis |
| n8n-io/n8n | 1,210 | 289 | up to 20 | 240 | 6 max | see above |
| documenso/documenso | 1,184 | 135 | 1 | 60 | 1–10 | see above |
| TryGhost/Ghost | 1,116 | 113 | 10 | 30 | ⅓ of cores | MySQL/SQLite. **Ghost already gives each worker its own Ghost instance** (comment in `e2e/playwright.config.mjs`): prior art for the same idea |
| penpot/penpot | 532 | 65 | 1 | 40 | 1 | Clojure backend + Postgres + Redis |
| RocketChat/Rocket.Chat | 458 | 68 | yes | — | 1 | MongoDB: not supported |
| calcom/cal.com | 287 | 59 | 8 | 20 | all cores | Already parallel (per-test fixtures); little to gain |
| strapi/strapi | 280 | 100 | 4 per edition | 60 | 1 | e2e uses SQLite (`.tmp/data.db`): not supported by V1 |

## Where to try it first

1. **evershop.** Postgres-only, a plain Node server, a stated shared-DB limit and 145 tests. The simplest real test of the claim.
2. **documenso.** The biggest Postgres suite with a stated DB limit. A recipe already exists, and it wants ≥ 8 cores (see HANDOFF.md).
3. **ever-gauzy.** The longest stated serial time (~90 min), but a likely *failure* case, because its specs depend on each other's data. Worth running to see how isolate reports that.

## Reproduce

```bash
cd data/big-suites
./scan-one.sh evershopcommerce/evershop      # results/evershopcommerce__evershop.json
xargs -P 6 -n 1 ./scan-one.sh < repos.txt    # all 117, about 10 minutes
```
