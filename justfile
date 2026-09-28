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
    node --test --test-concurrency=1 --test-reporter=spec dist/e2e/

# Run one acceptance test file, e.g. `just e2e-one f1-db`.
e2e-one name: build
    node --test --test-reporter=spec dist/e2e/{{name}}.test.js
