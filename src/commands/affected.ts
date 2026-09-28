import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { selectTests } from '../trace/affected.js';
import { changedFiles } from '../trace/git.js';
import { readMap } from '../trace/map.js';

const USAGE = `Usage: isolate affected --base <ref> [--strict] [--json]

  Prints the ids of the tests affected by the changes since <ref> (committed, staged, unstaged and untracked files),
  one per line, or "all", using the map written by \`isolate trace\`. Prints nothing if no test is affected.

  --strict   also run everything when a changed file is loaded at app boot, even if only its top level ran there
  --json     print { all, reason, tests, changed }
`;

/** isolate's own output directory, which is never a change to the code under test. */
const OUTPUT_DIR = '.isolate/';

/** `isolate affected --base <ref>`: prints the tests to run for the changes since <ref>, or `all`. */
export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { base: { type: 'string' }, strict: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  });
  if (values.base === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const repoDir = process.cwd();
  const map = readMap(isolatePaths(repoDir).map);
  const config = await loadConfig(repoDir);
  const changed = (await changedFiles(repoDir, values.base)).filter((file) => !file.startsWith(OUTPUT_DIR));
  const selection = selectTests(map, changed, config, values.strict);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  } else if (selection.all) {
    log.info(`all tests: ${selection.reason}`);
    process.stdout.write('all\n');
  } else if (selection.tests.length === 0) {
    log.info(`no test executes any of the ${changed.length} changed file(s)`);
  } else {
    process.stdout.write(`${selection.tests.join('\n')}\n`);
  }
  return 0;
}
