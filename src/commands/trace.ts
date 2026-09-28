import os from 'node:os';
import { parseArgs } from 'node:util';
import { runSession } from '../session.js';
import { parseWorkers } from '../stack.js';

const USAGE = `Usage: isolate trace [--workers N] [--tag-requests] -- <playwright test command...>

  Runs exactly like \`isolate run\`, and also records which server and client files every test executes in
  .isolate/map.json, for \`isolate affected\`.

  --workers N       apps, databases and Playwright workers (default: number of CPUs)
  --tag-requests    send an x-isolate-worker header with every request, so app logs show which worker sent it
`;

/** `isolate trace`: `isolate run` that also writes the impact map. */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { workers: { type: 'string' }, 'tag-requests': { type: 'boolean', default: false } },
  });
  if (positionals.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  return runSession({
    repoDir: process.cwd(),
    command: positionals,
    mode: 'trace',
    workers: values.workers === undefined ? os.availableParallelism() : parseWorkers(values.workers),
    tagRequests: values['tag-requests'],
    noRerun: false,
  });
}
