# F4 mechanism spike (2026-09-28)

The throwaway experiment that decided DECISIONS D-001. It is kept so the result can be reproduced; it is not part of the tool.

Four tiny HTTP servers answer on ports 4100-4103 with their own port. A "repo" config reads `process.env.BASE_URL` and has a `webServer` that would exit 1 if started. `playwright.isolate.config.ts` imports `.isolate-env.ts` first (which maps `TEST_PARALLEL_INDEX` to a URL) and then the repo config. `preload.cjs` is loaded with `NODE_OPTIONS=--require` and patches `WorkerMain.prototype._runTest`.

```bash
cd spikes/f4-mechanism
npm install
node servers.cjs &
ISOLATE_WORKERS=4 ISOLATE_WORKER_URLS=http://127.0.0.1:4100,http://127.0.0.1:4101,http://127.0.0.1:4102,http://127.0.0.1:4103 \
  NODE_OPTIONS="--require $PWD/preload.cjs" npx playwright test -c playwright.isolate.config.ts --reporter=line
cat results.jsonl hooks.log
```

Expected (observed on Playwright 1.56.1): every test's `h1` equals `server-(4100 + parallelIndex)`, the preload logs `TEST_PARALLEL_INDEX at preload time=undefined`, and `hooks.log` has a begin/end pair per test. Results are in LOG.md, 08:10.
