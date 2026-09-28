# isolate: every command a human needs. Run `just --list` to see them all.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Install dependencies for the tool and the fixture app.
install:
    pnpm install

# Compile the tool.
build:
    pnpm build

# Run every acceptance e2e test (real Postgres, real Chromium), one at a time.
e2e: build
    node --test --test-concurrency=1 --test-reporter=spec "dist/e2e/*.test.js"

# Run one acceptance test file, e.g. `just e2e-one f1-db`.
e2e-one name: build
    node --test --test-reporter=spec dist/e2e/{{name}}.test.js

# Fixture suite at workers 1 against one shared app (passes).
fixture-baseline:
    pnpm --dir examples/fixture-app run test:baseline

# Fixture suite at workers 4 against one shared app (collides and fails).
fixture-collide:
    pnpm --dir examples/fixture-app run test:collide

# Find candidate repositories and classify them into data/repos.json.
harvest: build
    node dist/scripts/harvest.js --target 100

# Experiment A (isolation speedup) on one recipe; flags: --rounds R, --oversubscribe (fixture only), --load-wait S.
experiment-a name='fixture-app' *args: build
    node dist/scripts/experiments/experiment-a.js {{name}} {{args}}

# Experiment B (impact map) on one recipe; flags: --workers N, --max-targets K, --kinds throw|all, --seed S.
experiment-b name='fixture-app' *args: build
    node dist/scripts/experiments/experiment-b.js {{name}} {{args}}

# Plot speedup vs workers (SVG and PNG) and write data/results/summary.md from every experiment result.
report: build
    node dist/scripts/experiments/plot.js
    node dist/scripts/experiments/summary.js

# Onboard a repo: clone it into work/repos, run `isolate init --allow-unmanaged`, write a draft recipe, print next steps.
repo url: build
    node dist/scripts/experiments/new-repo.js {{url}}

# Fixture demo: 4 workers on one shared app fail, then `isolate run --workers 4` passes; prints both wall times.
demo: build
    #!/usr/bin/env bash
    set -uo pipefail
    now_ms() { node -e 'console.log(Date.now())'; }
    seconds() { printf '%d.%01d s' $(( $1 / 1000 )) $(( $1 % 1000 / 100 )); }
    node dist/scripts/experiments/wait-port.js 3000
    echo "== 1/2: 4 Playwright workers against ONE shared app and database (pnpm run test:collide)"
    start=$(now_ms)
    pnpm --dir examples/fixture-app run test:collide
    shared_exit=$?
    shared_ms=$(( $(now_ms) - start ))
    echo "== 2/2: isolate run --workers 4: one app and one database copy per worker"
    start=$(now_ms)
    (cd examples/fixture-app && node ../../dist/src/cli.js run --workers 4 -- npx playwright test)
    isolated_exit=$?
    isolated_ms=$(( $(now_ms) - start ))
    echo
    echo "shared app, 4 workers:         exit ${shared_exit}, wall $(seconds "${shared_ms}")"
    echo "isolate run, 4 isolated apps:  exit ${isolated_exit}, wall $(seconds "${isolated_ms}")"
    if [ "${shared_exit}" -eq 0 ]; then echo "(the shared run passed this time: its collisions depend on timing)"; fi
    exit "${isolated_exit}"

# Run `isolate run` many times per worker count and print the average speedup, e.g. `just bench 20 1,4`.
bench runs='20' workers='1,4' dir='examples/fixture-app': build
    node dist/scripts/bench.js --runs {{runs}} --workers {{workers}} --dir {{dir}}
