import os from 'node:os';
import { parseArgs } from 'node:util';
import { runSession } from '../session.js';
import { parseWorkers } from '../stack.js';

const USAGE = `Usage:
  isolate run [--workers N] [--tag-requests] -- <playwright test command...>
  isolate run --baseline -- <playwright test command...>

  --workers N       apps, databases and Playwright workers (default: number of CPUs)
  --tag-requests    send an x-isolate-worker header with every request, so app logs show which worker sent it
  --baseline        the repo's own config (webServer, workers, env) against one fresh copy of seed, timed by the
                    isolate reporter: the baseline arm of the experiment
`;

/** `isolate run`: runs a Playwright command with one app and one database copy per worker, then reports timings. */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      workers: { type: 'string' },
      'tag-requests': { type: 'boolean', default: false },
      baseline: { type: 'boolean', default: false },
    },
  });
  if (positionals.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.baseline && (values.workers !== undefined || values['tag-requests'])) {
    process.stderr.write(`--baseline runs the repo's own worker count and apps; it cannot be combined with --workers or --tag-requests.\n\n${USAGE}`);
    return 2;
  }
  return runSession({
    repoDir: process.cwd(),
    command: positionals,
    mode: values.baseline ? 'baseline' : 'run',
    workers: values.workers === undefined ? os.availableParallelism() : parseWorkers(values.workers),
    tagRequests: values['tag-requests'],
  });
}
