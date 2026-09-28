#!/usr/bin/env node
import { log } from './log.js';

const USAGE = `isolate: one app process and one database copy per Playwright worker.

Usage:
  isolate init [--allow-unmanaged]           Inspect the repo and write isolate.config.ts
  isolate db up --workers N                  Start Postgres with N template copies of the seeded database
  isolate app up --workers N                 Start Postgres and N app processes
  isolate run [--workers N] -- <cmd...>      Run a Playwright command with one app and database per worker
  isolate snapshot                           Build, migrate and seed, then cache the result
  isolate trace [--workers N] -- <cmd...>    Like run, and record which files each test executes
  isolate affected --base <ref>              Print the tests affected by changes since <ref>, or "all"
  isolate report --check <file>              Validate a report.json against the schema
`;

const COMMANDS = ['init', 'db', 'app', 'run', 'snapshot', 'trace', 'affected', 'report'];

/** A CLI command: takes the arguments after its name, returns the process exit code. */
export interface Command {
  main(args: string[]): Promise<number>;
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(name)) {
    process.stderr.write(`Unknown command: ${name}\n\n${USAGE}`);
    return 2;
  }
  const command = (await import(`./commands/${name}.js`)) as Command;
  return command.main(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
