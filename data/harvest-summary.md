# Harvest summary

- Harvested: 2026-09-28T09:28:28.179Z
- Seed list: 23 repos.
- awesome-selfhosted-data @ 84c8617 (snapshot 2026-09-28T01:46:55+00:00, the date of every star count): 1351 entries, 975 in the pool after filters (not a GitHub repository URL: 224, stars < 200: 127, updated_at older than 12 months: 7, already in seed list: 17, no star count: 1).
- Criteria: playwright.config.(ts|js|mjs|cjs) anywhere outside node_modules; >= 200 stars (unknown allowed for seed-list repos); HEAD commit after 2025-09-28T09:28:28.179Z; database evidence: schema.prisma (or any .prisma file under prisma/), drizzle.config.*, docker-compose*.y*ml / compose*.y*ml mentioning postgres, DATABASE_URL in an .env example/sample/template.
- Order: seed list, then awesome-selfhosted Nodejs/Javascript/Deno entries by stars, then the rest by stars.

Scanned 998 repos; **96 qualified** (target 100). Fewer than the target of 100 qualified: the whole pool of 998 repos was scanned and only 96 met the criteria.

## Classes of qualified candidates

| Class | Candidates |
|---|---:|
| A | 1 |
| B | 36 |
| C | 59 |

## Why scanned repos did not qualify

| Reason | Repos |
|---|---:|
| no playwright config | 828 |
| no DB evidence | 74 |

## Top 15 blockers among qualified candidates

A candidate can have several blockers; C-level ones are backend, database and e2e credentials.

| Blocker | Candidates |
|---|---:|
| service: redis | 55 |
| service: smtp/mail | 50 |
| service: s3/minio | 41 |
| third-party: stripe | 24 |
| third-party: openai | 22 |
| third-party: anthropic | 19 |
| backend: python | 16 |
| third-party: aws | 15 |
| service: queue: bullmq | 14 |
| service: mongodb | 11 |
| service: clickhouse | 9 |
| third-party: google oauth | 9 |
| backend: go | 8 |
| backend: php | 8 |
| no documented e2e | 8 |

## Class A candidates

| Repository | Stars | e2e script | Playwright config |
|---|---:|---|---|
| johanohly/AirTrail | 1602 | `test:e2e` in package.json: `start-server-and-test "DISABLE_RATE_LIMITS=true OAUTH_ENABLED=true OAUTH_ALLOW_INSECURE_HTTP=true OAUTH_ISSUER_URL=http://127.0.0.1:3001/.well-known/openid-configuration OAUTH_CLIENT_ID=airtrail-e2e OAUTH_CLIENT_SECRET=airtrail-e2e OAUTH_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_basic OAUTH_PROMPT=select_account bun run preview --port 3000" http://localhost:3000 "bunx playwright test"` | playwright.config.ts |
