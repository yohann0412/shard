import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { CONFIG_FILE } from '../../src/config/load.js';
import { readTail } from '../../src/proc/tail.js';
import { recipeEnv, type RunnableRecipe } from './recipe.js';
import { harnessRoot, reposDir } from './paths.js';

/** A prepared checkout: its root (where install and build run) and the directory isolate runs in. */
export interface Checkout {
  root: string;
  appDir: string;
  /** Commit checked out: the recipe's pinned commit, or the scratch commit of a local copy. */
  commit: string;
}

/** Directories never copied from a local source (build output, dependencies, isolate's and Playwright's own output). */
const NOT_COPIED = /[/\\](node_modules|dist|\.isolate|test-results|playwright-report)([/\\]|$)/;

/** Ignored in a local copy's scratch repository, as this repository's own .gitignore ignores them. */
const LOCAL_IGNORES = ['node_modules', 'dist/', 'test-results/', 'playwright-report/', '*.log'];

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'isolate-harness',
  GIT_AUTHOR_EMAIL: 'harness@example.com',
  GIT_COMMITTER_NAME: 'isolate-harness',
  GIT_COMMITTER_EMAIL: 'harness@example.com',
};

/** Runs git in `cwd` and returns its trimmed stdout; throws on a non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd, env: GIT_IDENTITY });
  return result.stdout.trim();
}

/**
 * Runs shell lines as one bash script (so `export` and `cd` carry over between lines) in `cwd`, with the recipe's
 * environment, appending the output to `logFile`; throws with the log's tail if the script fails.
 */
export async function runSteps(steps: string[], cwd: string, recipe: RunnableRecipe, logFile: string, what: string): Promise<void> {
  if (steps.length === 0) return;
  appendFileSync(logFile, `\n$ ${what}:\n${steps.join('\n')}\n`);
  const script = ['set -euo pipefail', ...steps].join('\n');
  const result = await execa('bash', ['-c', script], {
    cwd,
    env: recipeEnv(recipe),
    stdout: { file: logFile, append: true },
    stderr: { file: logFile, append: true },
    reject: false,
  });
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit code ${result.exitCode}). Last lines of ${logFile}:\n${readTail(logFile)}`);
}

/** Copies a directory of this repository like e2e's copyFixture, links its node_modules back, and commits it as a scratch repo. */
async function copyLocal(recipe: RunnableRecipe, dir: string): Promise<void> {
  const source = path.join(harnessRoot, recipe.workdir);
  cpSync(source, dir, { recursive: true, filter: (file) => !NOT_COPIED.test(file.slice(source.length)) });
  if (existsSync(path.join(source, 'node_modules'))) symlinkSync(path.join(source, 'node_modules'), path.join(dir, 'node_modules'));
  writeConfig(recipe, dir);
  await git(dir, ['init', '--quiet']);
  appendFileSync(path.join(dir, '.git', 'info', 'exclude'), `${LOCAL_IGNORES.join('\n')}\n`);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', `scratch copy of ${recipe.workdir}`]);
}

/** Fetches exactly the pinned commit of a git recipe into `dir` and checks it out. */
async function cloneAtCommit(recipe: RunnableRecipe, dir: string): Promise<void> {
  await git(dir, ['init', '--quiet']);
  await git(dir, ['remote', 'add', 'origin', recipe.url!]);
  await git(dir, ['fetch', '--quiet', '--depth', '1', 'origin', recipe.commit!]);
  await git(dir, ['checkout', '--quiet', 'FETCH_HEAD']);
}

/** Writes the recipe's isolate config as the checkout's isolate.config.ts. */
export function writeConfig(recipe: RunnableRecipe, appDir: string): void {
  writeFileSync(path.join(appDir, CONFIG_FILE), `// Written by the experiment harness from experiments/recipes/${recipe.name}.json.\nexport default ${JSON.stringify(recipe.isolateConfig, null, 2)};\n`);
}

/** Written at the checkout root once install and build succeeded: what they were run with. */
const READY_FILE = '.harness-ready.json';

/** What a prepared checkout depends on; a reusable checkout must match it exactly. */
function fingerprint(recipe: RunnableRecipe): string {
  const { source, url, commit, workdir, install, build, env, toolchain, pathPrefix } = recipe;
  return JSON.stringify({ source, url, commit, workdir, install, build, env, toolchain, pathPrefix });
}

/**
 * Prepares a fresh checkout in work/repos/<name> (untimed): a git recipe is fetched at its pinned commit, a local one
 * is copied and committed into a scratch repository of its own. Then install and build run at the checkout root and
 * isolate.config.ts is written into the workdir. The generated config and isolate's .isolate/ directory are excluded
 * from git, so `git status` and `isolate affected` see only real edits. With `reuse`, a checkout that an earlier call
 * prepared from the same recipe fields is kept as it is (only isolate.config.ts is rewritten).
 */
export async function prepareCheckout(recipe: RunnableRecipe, logFile: string, options: { reuse?: boolean } = {}): Promise<Checkout> {
  const root = path.join(reposDir, recipe.name);
  const appDir = recipe.source === 'local' ? root : path.join(root, recipe.workdir);
  const ready = path.join(root, READY_FILE);
  if (options.reuse && existsSync(ready) && readFileSync(ready, 'utf8') === fingerprint(recipe)) {
    writeConfig(recipe, appDir);
    return { root, appDir, commit: await git(root, ['rev-parse', 'HEAD']) };
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(logFile, '');

  if (recipe.source === 'local') {
    await copyLocal(recipe, root);
  } else {
    await cloneAtCommit(recipe, root);
    writeConfig(recipe, appDir);
  }
  const workdir = path.relative(root, appDir).split(path.sep).join('/');
  const prefix = workdir === '' ? '' : `/${workdir}`;
  appendFileSync(path.join(root, '.git', 'info', 'exclude'), `${prefix}/${CONFIG_FILE}\n${prefix}/.isolate/\n/${READY_FILE}\n`);

  await runSteps(recipe.install, root, recipe, logFile, 'install');
  await runSteps(recipe.build, root, recipe, logFile, 'build');
  writeFileSync(ready, fingerprint(recipe));
  return { root, appDir, commit: await git(root, ['rev-parse', 'HEAD']) };
}
