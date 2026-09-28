# isolate: every command a human needs. Run `just --list` to see them all.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Install dependencies for the tool and the fixture app.
install:
    pnpm install

# Compile the tool.
build:
    pnpm build
