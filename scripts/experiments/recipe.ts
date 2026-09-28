import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configSchema, type IsolateConfig } from '../../src/config/schema.js';
import { harnessRoot, recipesDir, workDir } from './paths.js';

/** Directories Experiment B draws mutation targets from when a recipe names none. */
const DEFAULT_SOURCE_DIRS = ['src', 'app', 'lib', 'server', 'public'];

/** Directories whose files the app serves, searched for the mutant marker by Experiment B's liveness check. */
const DEFAULT_SERVED_OUTPUT = ['dist', 'build', '.next', 'public'];

/** Isolate's per-worker placeholders; they belong in isolateConfig, never in the environment the harness exports. */
const WORKER_PLACEHOLDER = /\{(i|port|url|db)\}/;

/**
 * Schema of experiments/recipes/<name>.json. It accepts the scout's JSON as-is (its free-text fields such as `notes`,
 * `baseline` and `appStart` are kept untouched) and adds the fields the harness needs to run a repo unattended.
 */
export const recipeSchema = z.looseObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** `git`: clone `url` at `commit`. `local`: copy the directory `workdir` of this repository. */
  source: z.enum(['local', 'git']).default('git'),
  url: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  /** Only `works` recipes run; the scout also writes `blocked`, and `just repo` writes `draft`. */
  status: z.string(),
  blocker: z.string().nullable().default(null),
  /** `git`: the checkout's subdirectory where Playwright and isolate run. `local`: the directory to copy. */
  workdir: z.string().default('.'),
  /** Shell lines run as one bash script at the checkout root before anything is timed. */
  install: z.array(z.string()).default([]),
  /** Shell lines run as one bash script at the checkout root after install, and again after every mutant. */
  build: z.array(z.string()).default([]),
  /** Exported to install, build and every isolate command; `$NAME` and `${NAME}` expand from the harness's environment. */
  env: z.record(z.string(), z.string()).default({}),
  /** Directories prepended to PATH for every command of this repo, including the apps and Playwright isolate starts; missing ones are skipped. */
  pathPrefix: z.array(z.string()).default([]),
  /**
   * npm packages that provide the tools this repo needs, by version, e.g. { "node": "24", "pnpm": "12.3.4" }. They are
   * installed once into work/toolchain/ (the `node` package ships the Node binary) and put first on PATH.
   */
  toolchain: z.record(z.string(), z.string()).default({}),
  /** Services the harness starts before the runs and stops after: `smtp-sink` accepts and discards mail on `port`. */
  services: z.array(z.object({ kind: z.literal('smtp-sink'), port: z.number().int().positive() })).default([]),
  /** Their setup starts no server of its own (no webServer): the baseline arm runs `isolate run --baseline --app`. */
  baselineApp: z.boolean().default(false),
  /** Stop a run that takes longer than this many minutes (default 45). */
  runCapMin: z.number().positive().optional(),
  /** How `playwright test` is launched, e.g. with `env NODE_OPTIONS=...` in front when the repo's test script sets variables. */
  playwrightCommand: z.array(z.string()).default(['npx', 'playwright', 'test']),
  /** Appended to every `playwright test` command, e.g. `--project=api` for a subset. */
  playwrightArgs: z.array(z.string()).default([]),
  /** Ports the repo's own webServer binds in the baseline arms; each baseline run waits until they are free. */
  baselinePorts: z.array(z.number().int().positive()).default([]),
  /** `reduced`: fewer rounds or a subset of the suite; the output is labelled with it. */
  protocol: z.enum(['full', 'reduced']).default('full'),
  /** Rounds for Experiment A (the `--rounds` flag still wins). */
  rounds: z.number().int().min(1).max(5).optional(),
  /** What part of the suite runs, when not all of it. */
  subsetNote: z.string().nullable().default(null),
  sourceDirs: z.array(z.string()).default(DEFAULT_SOURCE_DIRS),
  servedOutput: z.array(z.string()).default(DEFAULT_SERVED_OUTPUT),
  /** Experiment B's mutant kinds: `throw` only, or also `toplevel` and `wrongvalue`. */
  mutantKinds: z.enum(['throw', 'all']).default('throw'),
  /** The contents of isolate.config.ts, validated by isolate's own config schema. */
  isolateConfig: configSchema.optional(),
});

/** A parsed recipe. */
export type Recipe = z.infer<typeof recipeSchema>;

/** A recipe the harness can run: it works and carries an isolate config. */
export type RunnableRecipe = Recipe & { isolateConfig: IsolateConfig };

/** Reasons a recipe cannot run unattended, each naming the field to fix (empty when it can run). */
export function recipeProblems(recipe: Recipe): string[] {
  const found: string[] = [];
  if (recipe.status !== 'works') found.push(`status is "${recipe.status}"${recipe.blocker ? ` (${recipe.blocker})` : ''}; only "works" recipes run`);
  if (recipe.isolateConfig === undefined) found.push('isolateConfig is missing: add the contents of isolate.config.ts as an inline object');
  if (recipe.source === 'git' && (recipe.url === null || recipe.commit === null)) found.push('a git recipe needs both url and commit');
  if (recipe.source === 'local' && !existsSync(path.join(harnessRoot, recipe.workdir))) found.push(`workdir ${recipe.workdir} does not exist in this repository`);
  for (const line of [...recipe.install, ...recipe.build]) {
    if (/^\s*git clone\b/.test(line)) found.push(`the harness clones the recipe's url at its commit itself; remove the step "${line}"`);
  }
  for (const [name, value] of Object.entries(recipe.env)) {
    if (WORKER_PLACEHOLDER.test(value)) found.push(`env.${name} uses a per-worker placeholder; put it in isolateConfig.app.env or playwright.env`);
    else if (value.includes(' (')) found.push(`env.${name} looks like a value followed by a note: "${value}"`);
  }
  return found;
}

/** Loads experiments/recipes/<name>.json and checks that it can run; throws a message listing every problem. */
export function loadRecipe(name: string): RunnableRecipe {
  const file = path.join(recipesDir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`No recipe ${file}`);
  const parsed = recipeSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid recipe ${file}:\n${z.prettifyError(parsed.error)}`);
  const found = recipeProblems(parsed.data);
  if (found.length > 0) throw new Error(`Recipe ${file} cannot run:\n${found.map((line) => `  - ${line}`).join('\n')}`);
  return parsed.data as RunnableRecipe;
}

/** Replaces `$NAME` and `${NAME}` with the harness's own environment (empty when unset). */
function expand(value: string): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced: string | undefined, bare: string | undefined) => process.env[braced ?? bare ?? ''] ?? '');
}

/**
 * The variables every experiment run of a recipe gets: the recipe's own, then `CI=true` (Playwright only needs a truthy
 * value, but some configs test `CI === "true"`), no HTML report opening, and the browsers every arm shares.
 */
export function armEnv(recipe: Recipe, browsersPath: string): Record<string, string> {
  return { ...recipeEnv(recipe), CI: 'true', PLAYWRIGHT_HTML_OPEN: 'never', PLAYWRIGHT_BROWSERS_PATH: browsersPath };
}

/** Where a recipe's toolchain is installed: one npm prefix per distinct set of packages. */
export function toolchainDir(recipe: Recipe): string | null {
  const entries = Object.entries(recipe.toolchain).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  const key = entries.map(([name, version]) => `${name}@${version}`).join('+').replace(/[^\w.@+-]/g, '_');
  return path.join(workDir, 'toolchain', key);
}

/** The variables a recipe adds for every command it runs: its env (expanded), then its toolchain and existing PATH prefixes first on PATH. */
export function recipeEnv(recipe: Recipe): Record<string, string> {
  const env = Object.fromEntries(Object.entries(recipe.env).map(([name, value]) => [name, expand(value)]));
  const toolchain = toolchainDir(recipe);
  const prefixes = [...(toolchain === null ? [] : [path.join(toolchain, 'node_modules', '.bin')]), ...recipe.pathPrefix.filter((dir) => existsSync(dir))];
  if (prefixes.length === 0) return env;
  const inheritedPath = env.PATH ?? process.env.PATH ?? '';
  return { ...env, PATH: [...prefixes, inheritedPath].join(path.delimiter) };
}
