# Contributing

Thanks for helping. The bar is small, boring, readable code that a stranger can review in one sitting.

## Setup

```bash
pnpm install          # Node >= 22.18, pnpm 10
just build            # tsc → dist/
just e2e              # every acceptance test: real Postgres, real Chromium
```

`just --list` shows every command.

## Rules

- **TypeScript strict, ESM.** One job per module. Every exported function has a one-line doc comment saying what it does.
- **No unit tests, no mocks.** Every test runs the built CLI against a real Postgres and a real browser and asserts only on what a user could observe: exit codes, files, stdout, database contents, the process table. One minimal end-to-end test per feature, in `e2e/`.
- **Dependencies:** `execa`, `pg`, `pino`, `zod`, `embedded-postgres` (binaries only). Adding one needs a line in `DECISIONS.md` saying why Node's standard library was not enough.
- **No dead code, no commented-out code, no TODOs.** Open an issue instead.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), one logical change per commit.
- **Decisions** that are not obvious from the code go into `DECISIONS.md` as a short record: problem, options, choice, reason.

## Experiments

Experiment results are data: never edit a file under `data/results/` by hand. Re-run the harness (`just experiment-a <name>`, `just experiment-b <name>`, `just report`) and commit what it writes, together with the command you ran.
