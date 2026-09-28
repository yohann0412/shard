# Review: F7 (trace mode and `affected`)

Subagent report: app preload starts precise coverage in-process before app code and serves takes over a Unix socket; worker preload patches `WorkerMain.prototype._runTest` and Playwright's client `BrowserContext` for Chromium JS coverage; source maps via `node:module` `SourceMap`; `affected` with global / bootLoaded / always-all / test-file rules. It verified f7 three times, f4 and f6, on a `git archive` copy of main plus its files. Lead integrated (67cfaaf; one session hunk resolved by hand) and re-ran the acceptance on the main tree (results at the end).

## What could be wrong

- **Only Playwright ≤ 1.58 is traceable.** 1.60+ bundles the worker (`lib/worker/workerProcessEntry.js`, private `WorkerMain`), so the `_runTest` patch cannot apply; the preload stops with an R15 error. Checked by the lead from the npm tarballs: 1.57.0 and 1.58.1 have `lib/common/process.js` + `lib/worker/workerMain.js`; 1.60.0 and 1.63.0 do not. umami pins 1.63 → not traceable without the fallback. A version-independent hook (fixture injection at module load) was sent to a follow-up subagent.
- **Test-side code changes select nothing** (helpers, fixtures, page objects are not traced and are not any test's `file`). That is a false-negative hole in `affected`, exactly the kind Claim B is about. Sent to the follow-up: changes under the test directory that are not specs → `all`.
- **Always-all inputs outside the repo directory are invisible** to `git diff --relative` (the fixture's `../../pnpm-lock.yaml`). Sent to the follow-up.
- **Attribution between tests.** Takes are awaited by the patched `_runTest`, and each take waits for in-flight HTTP requests to finish (≤ 2 s). Work that outlives that window (timers, queued jobs, SSE) lands in the next test's take; it is attributed to the previous test (conservative) and counted as `betweenTestTakes` only when it found code. The fixture has none, so the fixture cannot show this effect.
- **`bootLoaded` swallows route files.** `items.ts` is `bootLoaded` because the server imports it at boot; with `--strict` any edit to it selects `all`. With the default policy an edit to its top-level code (a route path, a constant) selects only the tests that ran its functions, which is D-011's known hole. Experiment B's `toplevel` mutant is there to measure it.
- **The map is identical at 1 and 2 workers on the fixture** (subagent's check). That says the fixture is deterministic, not that real apps are.

## What was not tested

- Bundled server code (Next.js, Remix) and `webpack-internal://` URLs; client source maps fetched from a real bundled app; apps whose tree has several Node processes; `worker_threads`; non-Chromium browsers; popups not created through `newPage`.
- SIGKILL of the CLI during a trace (the socket directory is tracked by the reaper, not exercised).

## What was assumed

- That V8 precise-count coverage started by an in-process session and taken again in-process gives per-take deltas (counts reset on each take) and that keeping the session connected keeps precise mode on for the life of the process.
- That the reporter's test id and the worker preload's id are the same function (they are: the preload lazily loads `test-id.js`); the trace run warns when any reporter id is missing from the map.

## Lead's run on the main tree (09:56-10:01 UTC, and 10:23)

- `just e2e-one f7-trace`: pass twice (22.7 s, 23.1 s). `f4-run` (108.7 s), `f6-report` (45.9 s), `f5-snapshot` (32.6 s): pass after the session changes.
- `isolate trace --workers 2` in `examples/fixture-app`: 12 passed, routing valid, 12 tests mapped; global = db, logger, maintenance, session middleware, health route, server; bootLoaded = auth, home, items, settings routes and views; no between-test takes, timeouts, source-map failures or unresolved client URLs. Appending a comment to `src/routes/items.ts` → `affected --base HEAD --json` selects exactly the 4 item tests (3 in `items.spec`, 1 in `bulk-items.spec`).
- Verdict: accepted, with the three gaps above sent to a follow-up subagent.

## Follow-up: gaps closed (8118fdd)

- Playwright ≥ 1.60 is now traceable with no test edits: where `WorkerMain._runTest` is not reachable, the worker preload extends `test` from `playwright/test` with an automatic fixture (a getter on the original exports object, so ESM and CJS test files both see it). On a 1.63.0 copy of the fixture, the ESM and CJS maps matched the 1.56 map exactly (12 ids, 0 differing sets). Known gaps of that path: beforeAll/afterAll traffic lands in the boot set or the previous test; pages from `browser.newPage()`/popups get no client coverage; `import test from '@playwright/test'` (default import) sees the untraced object.
- Test-support files (a non-spec file next to specs, or under the Playwright config's directory outside the app's source directories) → `all`. Conservative: an edit to `README.md` next to the config also yields `all`.
- Always-all inputs above the repo directory (lockfiles, `cache.inputs` such as `../../pnpm-lock.yaml`) are diffed explicitly and yield `all`.
- Subagent ran f7 three times and f4 once on the final code; the lead's full `just e2e` run on main is recorded in LOG.md.
