import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { log } from '../log.js';
import { describeExit } from '../proc/group.js';
import { firstSignal } from '../proc/signals.js';
import { parseWorkers, startStack } from '../stack.js';

/**
 * `isolate app up --workers N`: builds (if configured), starts Postgres, seeds, clones, starts N healthy apps and prints
 * one `ready` JSON line on stdout. Runs until SIGINT/SIGTERM (exit 0) or until an app dies on its own (exit 1), then
 * stops everything and prints a `stopped` line with the peak RSS of every process tree.
 */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { workers: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'up') {
    log.error('usage: isolate app up --workers N');
    return 2;
  }
  const workers = parseWorkers(values.workers);
  const repoDir = process.cwd();
  const stack = await startStack({ repoDir, config: await loadConfig(repoDir), workers, apps: true });
  const ready = { event: 'ready', postgresPid: stack.postgres.pid, seedUrl: stack.seedUrl, databases: stack.databases, apps: stack.apps };
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  const outcome = await Promise.race([firstSignal().then((signal) => ({ signal })), stack.appExited.then((crash) => ({ crash }))]);
  let reason: string | undefined;
  if ('crash' in outcome) {
    reason = `app w${outcome.crash.index} exited on its own (${describeExit(outcome.crash)})`;
    log.error(`${reason}; stopping everything. Last lines of its log:\n${outcome.crash.logTail}`);
  } else {
    log.info(`${outcome.signal}: stopping`);
  }
  const { peakRssMb } = await stack.stop();
  process.stdout.write(`${JSON.stringify({ event: 'stopped', peakRssMb, reason })}\n`);
  return reason === undefined ? 0 : 1;
}
