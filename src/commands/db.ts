import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { log } from '../log.js';
import { firstSignal } from '../proc/signals.js';
import { parseWorkers, startStack } from '../stack.js';

/**
 * `isolate db up --workers N`: starts Postgres with the seeded `seed` database and N template copies, prints one
 * `ready` JSON line on stdout, then runs until SIGINT/SIGTERM, stops everything and prints a `stopped` line.
 */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { workers: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'up') {
    log.error('usage: isolate db up --workers N');
    return 2;
  }
  const workers = parseWorkers(values.workers);
  const repoDir = process.cwd();
  const stack = await startStack({ repoDir, config: await loadConfig(repoDir), workers, apps: false });
  const ready = { event: 'ready', postgresPid: stack.postgres.pid, seedUrl: stack.seedUrl, databases: stack.databases };
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  const signal = await firstSignal();
  log.info(`${signal}: stopping`);
  const { peakRssMb } = await stack.stop();
  process.stdout.write(`${JSON.stringify({ event: 'stopped', peakRssMb })}\n`);
  return 0;
}
