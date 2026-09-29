# How to run it locally

Checked on 2026-09-28 from a fresh clone: `pnpm install`, `just demo` (~1 min) and `just e2e` (9/9, ~4.5 min) as written. The experiment commands in (b) and (c) were run in the development checkout, which has the same code at the same commit.

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

## (b) Their setup against isolate, on a real repo: `just compare`

```bash
just compare-list                          # repos with a ready recipe
just compare evershop                      # 3 rounds: their setup, then shared@N and isolate@N at 2, 4 and 8 workers
just compare evershop --rounds 1 --workers 4   # quickest useful run: theirs, shared@4, isolate@4
just compare evershop --no-shared          # skip shared@N, time only theirs against isolate
just compare documenso --rounds 1 -- e2e/api/v1   # anything after -- goes to every `playwright test` command (a subset here)
just compare-report work/compare/evershop/<timestamp>   # print an earlier run's report again (older runs too)
```

What it does, all unattended:

1. Clones the repo at the commit the recipe pins into `work/repos/<name>`, installs it and builds it (first time only; `--fresh` redoes it). If the recipe pins a Node, npm or pnpm version, that version is installed into `work/toolchain/` from npm and used for this repo only.
2. Downloads the Chromium the repo's Playwright version expects (`playwright install chromium`).
3. Starts any service the recipe needs (documenso: a local SMTP sink that accepts and discards mail).
4. Runs two untimed warm-ups: their setup first, which tells it their worker count W, then the largest isolate arm. Then it runs R rounds in rotating order of:
   - **theirs**: the repo's own Playwright config as their CI runs it (`CI=true`, its worker count, one app, one database), through `isolate run --baseline` (and `--app` when their config expects an already-running server);
   - **shared@N**: the same, with `--workers=N` added: N workers against their one app and one database. This is what the repo could do without isolate, just by raising its worker count. It is skipped for N = W (that is theirs) and with `--no-shared`;
   - **isolate@N**: `isolate run --workers N`, one app and database copy per worker. By default N is 2, 4 and 8 when W is 1, the case isolate is for. When their setup already runs W workers, N is W (same parallelism, so only the isolation differs) and 2W. N never exceeds your cores.
5. Prints per arm:
   - median wall time;
   - Playwright's test phase;
   - the overhead outside it;
   - pass and fail counts;
   - **new fails**: tests that passed in every run of theirs and failed in this arm;
   - the speedup over theirs.

   Then one line per arm on its failures: how many are rate limits (HTTP 429), timeouts or other, how many are new, and how much of the test time the failed tests took. Notes follow: what shared@N says about isolate, isolate breaking tests, their setup being already parallel, or the suite being too short for a fair wall-clock comparison. `new-failures.txt` lists every new failure by test with its error. Raw logs and reports go to `work/compare/<name>/<timestamp>/`.

**Reading shared@N against isolate@N:** this is the question that decides whether isolate is needed at all.

- shared@N has no new fails: the suite can already run N workers on one database. isolate is only worth it where it is faster than shared@N, and usually it is not.
- shared@N has new fails and isolate@N has none: N workers on shared state break the suite, and isolate gives that parallelism back. This is isolate's case.
- Both have new fails: read `new-failures.txt`. The tests may be flaky, or they may share state isolate does not copy, such as the app's memory. evershop's rate limiter is an example: it counts requests per app process.
- A shared@N run that fails tests is not a fair speed comparison, either way. Failures that wait out a timeout slow it down. Serial groups that stop at a failure speed it up.

**Which repos are worth it:** suites whose own config holds them to one or a few workers because tests share a database (evershop: `workers: 1`, "Shared DB"). A suite that already runs many workers against one app (documenso's API tests: 10) has nothing for isolate to unlock. There, the best case is a tie on the test phase, plus isolate's start-up cost.

Every arm runs with `--retries=0` and the same database snapshot, so they do the same work. Compare the pass/fail columns too: a faster arm that fails more tests is not a win.

| Recipe | Suite | First prepare | One round (4 cores, sandbox) |
|---|---|---|---|
| `evershop` | 164 tests; their config: 1 worker, "Shared DB" | ~3 min | theirs 5m 42s, isolate@4 2m 44s (so ~30 min for `--rounds 1` with the default arms, which add shared@2 and shared@4; `--workers 4` is about half that) |
| `documenso` | ~1,200 tests; their config: api project at 10 workers, ui at min(6, (cores-2)/2) | ~11 min (Node 24 and npm 11 are fetched) | `-- e2e/api/v1` (44 tests): theirs 1m 05s, isolate@4 58s; the full suite is much longer |
| `umami-passing`, `rallly`, `fixture-app` | from the sprint | | |

Disk: each repo takes 1–3 GB under `work/`; `rm -rf work/repos/<name>` removes one.

## (c) Experiment A on one repo of your choosing: 20 minutes to 2 hours

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

## (d) The harvest and both experiments, unattended: about 4-6 hours on 4 cores

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
