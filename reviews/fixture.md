# Review: Phase 1 fixture app

Subagent report: 12-test suite, baseline 5/5 green (on the previous test order), collide 5/5 failing on the final code, `p1-fixture` green. Lead re-ran `p1-fixture` and 3 baselines on the merged code (results at the end).

## What could be wrong

- **Collisions depend on timing, not on logic alone.** The two count races (`items.spec` vs `bulk-items.spec`) need both files to be in the first batch of 4 files, which they are only because of alphabetical file order and `fullyParallel: false`. A faster machine, a different file ordering (Playwright sorts files), or sharding could make collide pass sometimes. This is realistic (real collisions are also timing-dependent) but it means "collide fails" is a probability, measured at 5/5 here, not a guarantee.
- **The dashboard "no banner" test never collided at 4 workers** (maintenance.spec starts after it). So the global-setting collision is only exercised through the items form. At N = 2 it may show up; not a defect, but the README should not claim that every file collides.
- **`with-db.mjs` drops every extra `--`** after the first. A command that legitimately needs a literal `--` argument would break. Acceptable for a fixture script; documented in the file.
- **`reuseExistingServer: !process.env.CI`**: if something else listens on :3000, the baseline silently reuses it. That is how real repos write it, which is the point, but it is a way for a baseline to test the wrong app. The experiment harness runs the baseline through `isolate run --baseline`, which gives it a fresh database, but it cannot stop Playwright from reusing a stray server on :3000; the harness should check the port is free before a baseline run.
- **Session cookies are not port-scoped.** Under isolation, all workers' apps are on 127.0.0.1 with different ports; a cookie set by app 1 is also sent to app 2 by the same browser context. Contexts are per test, so it does not matter here, but a test that opens two apps in one context would share cookies.

## What was not tested

- A non-root or macOS run of `with-db.mjs` (`createPostgresUser` is false there; the package's non-root path is untested by us).
- The final `items.spec.ts` order under 5 consecutive baselines (the subagent's permission checks stalled). The lead ran 3 more.
- Playwright versions other than 1.56.1.

## What was assumed

- That the embedded-postgres JS API with `createPostgresUser` is an acceptable stand-in for "the repo's own Postgres" (a real repo would use docker compose). It only affects the fixture's own baseline/collide scripts; the experiments use isolate's own Postgres for every arm.
- That `/health` passing through the maintenance and session middleware at boot is realistic. It is (many apps put health behind global middleware), and it is what makes those middleware files "global" in the impact map.
