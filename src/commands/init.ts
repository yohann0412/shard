import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import { detectConfig, type ConfigInput, type Note } from '../init/detect.js';
import { readPackageJson } from '../init/files.js';
import { renderConfig } from '../init/render.js';
import { formatReport, formatUnmanaged, UNMANAGED_REFUSAL } from '../init/report.js';
import { scanUnmanaged, type UnmanagedService } from '../init/unmanaged.js';
import { log } from '../log.js';

/** Exit code when unmanaged services were found and --allow-unmanaged was not given. */
const EXIT_UNMANAGED = 3;

/** Comment lines for the rendered config: the reason above every guessed value, and what `unmanaged` means. */
function configComments(notes: Note[], unmanaged: UnmanagedService[]): Map<string, string> {
  const comments = new Map(notes.filter((note) => note.guessed).map((note) => [note.key, `guessed: ${note.source}`]));
  if (unmanaged.length > 0) comments.set('unmanaged', 'Not isolated (D-012): every worker\'s app shares one real instance of each of these.');
  return comments;
}

/** The config with the unmanaged services recorded as allowed. */
function withUnmanaged(config: ConfigInput, unmanaged: UnmanagedService[]): ConfigInput {
  if (unmanaged.length === 0) return config;
  return { ...config, unmanaged: { allow: true, services: unmanaged.map((service) => service.service) } };
}

/** Writes the config and loads it back the way `run` will, removing it again if it does not validate. */
async function writeConfig(repoDir: string, source: string): Promise<void> {
  const file = path.join(repoDir, CONFIG_FILE);
  writeFileSync(file, source);
  try {
    await loadConfig(repoDir);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

/** `isolate init [--allow-unmanaged] [--force]`: inspects the repo in the current directory and writes isolate.config.ts. */
export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'allow-unmanaged': { type: 'boolean', default: false }, force: { type: 'boolean', default: false } },
  });
  const repoDir = process.cwd();
  if (existsSync(path.join(repoDir, CONFIG_FILE)) && !values.force) {
    log.error(`${CONFIG_FILE} already exists in ${repoDir}; run isolate init --force to overwrite it`);
    return 1;
  }

  const detection = await detectConfig(repoDir);
  const unmanaged = scanUnmanaged(repoDir);
  process.stdout.write(formatReport(repoDir, detection));
  if (unmanaged.length > 0) process.stdout.write(formatUnmanaged(unmanaged));
  if (unmanaged.length > 0 && !values['allow-unmanaged']) {
    process.stdout.write(UNMANAGED_REFUSAL);
    return EXIT_UNMANAGED;
  }
  if (detection.config === null) {
    process.stdout.write('No config written.\n');
    return 1;
  }

  const esm = readPackageJson(repoDir)?.type === 'module';
  await writeConfig(repoDir, renderConfig(withUnmanaged(detection.config, unmanaged), configComments(detection.notes, unmanaged), esm));
  process.stdout.write(`Wrote ${CONFIG_FILE}. Check the guessed values, then run: isolate run -- npx playwright test\n`);
  return 0;
}
