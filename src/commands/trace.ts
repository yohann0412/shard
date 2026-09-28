import os from 'node:os';
import { parseArgs } from 'node:util';
import { runSession } from '../session.js';
import { parseWorkers } from '../stack.js';

const USAGE = `Usage: isolate trace [--workers N] [--tag-requests] [--shared-origin URL] -- <playwright test command...>

  Runs exactly like \`isolate run\`, and also records which server and client files every test executes in
  .isolate/map.json, for \`isolate affected\`.

  --workers N       apps, databases and Playwright workers (default: number of CPUs)
  --tag-requests    send an x-isolate-worker header with every request, so app logs show which worker sent it
  --shared-origin URL
                    serve every app on this one origin (the one the app's build baked in, e.g. http://localhost:3201)
                    through a proxy that routes by the x-isolate-worker header; turns on --tag-requests. Default:
                    playwright.sharedOrigin in the config, if set
`;

/** `isolate trace`: `isolate run` that also writes the impact map. */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { workers: { type: 'string' }, 'tag-requests': { type: 'boolean', default: false }, 'shared-origin': { type: 'string' } },
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
    sharedOrigin: values['shared-origin'],
    noRerun: false,
  });
}
