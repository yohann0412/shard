# How to run it locally

Exact commands for a laptop, macOS or Linux. Durations were measured on the 4 vCPU cloud VM this sprint used (Xeon @ 2.8 GHz, 15 GB RAM); a recent laptop is usually faster.

## Prerequisites (once)

```bash
# Node >= 22.18 and pnpm 10
node --version            # v22.18+ (v24 also works)
corepack enable           # provides pnpm
# just (the command runner): pick one
brew install just         # macOS
cargo install just        # anywhere with Rust
npm i -g rust-just        # anywhere with npm

git clone https://github.com/yohann0412/shard.git isolate && cd isolate
git checkout claude/isolate-playwright-research-pbmgnl
pnpm install              # ~30 s; downloads Postgres binaries for your platform via embedded-postgres
pnpm --dir examples/fixture-app exec playwright install chromium   # ~1 min, once (skip if Chromium for Playwright 1.56 is already installed)
```

Postgres runs from npm-provided binaries, so no Docker and no system Postgres are needed. On Linux, data lives in `/dev/shm`. On macOS it lives in a temp directory on disk, and the tool logs "database is on disk, not RAM".

If you run as root on Linux, Postgres runs as the `postgres` system user through `setpriv`. When that user cannot read the checkout (a clone under `/root`, say), isolate copies the Postgres binaries once into `/tmp/isolate-postgres-<key>` and runs them from there. The fixture's own `test:baseline` and `test:collide` scripts do not do this, so as root, clone into a directory other users can read.

## (a) The fixture demo: ~2 minutes

```bash
just demo
```

It builds the tool and the fixture, then runs the fixture's 12 Playwright tests at 4 workers against one shared app. That run fails, because tests collide on item counts and on a global maintenance-mode setting. It then runs `isolate run --workers 4`, which gives one app and one database copy per worker, and passes. Both wall times are printed.

The acceptance tests take ~6-8 minutes and run every feature for real (Postgres, Chromium, no mocks):

```bash
just e2e
```

## (b) Experiment A on one repo of your choosing: 20 minutes to 2 hours

For the fixture (about 20 minutes: warm-up plus 3 rounds of 6 arms):

```bash
just experiment-a fixture-app
just report          # data/results/speedup-vs-workers.{svg,png} and data/results/summary.md
```

For a real repo:

```bash
just repo https://github.com/<owner>/<repo>
#   clones into work/repos/<repo>, runs `isolate init --allow-unmanaged`, writes a draft recipe
#   experiments/recipes/<repo>.json and prints what is left to fill in.
# Fill in the recipe: install and build steps, env, the Playwright command. Use umami.json as a worked example.
just experiment-a <repo>
just report
```

Duration is about 12 × (the suite's time at 1 worker) plus install and build. Protocol and validity rules are in PLAN.md §5. Results go to `data/results/<repo>/experiment-a.json`, with every raw run under `runs/`.

Repos that work with the committed recipes:

- `umami`: the browser suite. It needs pnpm 12. The recipe's `pathPrefix` points at the sandbox's copy under `work/pnpm12`, so change it to wherever pnpm 12 lives on your machine, or drop it if `pnpm --version` already prints 12.x.
- `rallly`: subset L (16 files, 70 tests), with the shared-origin mode. It needs Node 24: change `pathPrefix` (the sandbox's is `work/node24/bin`). It also needs an SMTP catcher running before the experiment, e.g. `mailpit --smtp 127.0.0.1:3225 --listen 127.0.0.1:3226`, because the harness does not start it (see `experiments/recipes/SCOUT_LOG.md`).

Both recipes pin the commit that was measured.

## (c) The harvest and both experiments, unattended: about 4-6 hours on 4 cores

```bash
just harvest                      # ~4 min: scans ~1000 repos (shallow clones), writes data/repos.json
just experiment-a fixture-app     # ~20 min
just experiment-a umami           # ~60-90 min
just experiment-b fixture-app     # ~40 min (25 targets × up to 3 mutant kinds × one suite run)
just experiment-b umami           # ~2-3 h (throw mutants only)
just report
```

Run nothing else on the machine meanwhile. The harness records the load average at the start of every timed run and waits for it to drop below 1.0 (up to 3 minutes). Runs that started under load are marked in the raw data.

## Where things end up

- `data/results/<repo>/experiment-{a,b}.json`: aggregated results with every raw run next to them.
- `data/results/summary.md`, `data/results/speedup-vs-workers.png`: what RESULTS.md quotes.
- `.isolate/` inside each repo: the last run's `report.json`, logs, cache and map.
