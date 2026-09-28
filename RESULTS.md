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

_pending_

## Experiment B: impact map

_pending_

## What I would build next

_pending_
