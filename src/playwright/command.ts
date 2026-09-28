import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** A user's `playwright test` command, split so isolate can point it at the wrapper config. */
export interface PlaywrightCommand {
  /** Everything up to and including `test`, e.g. `npx playwright test`. */
  launcher: string[];
  /** The user's arguments after `test`, without `-c/--config` and `--reporter`. */
  args: string[];
  /** Absolute path of the Playwright config to wrap. */
  repoConfig: string;
  /** Reporters named by a `--reporter` flag (moved into the wrapper), or null. */
  cliReporters: string[] | null;
}

/** What parsing needs besides the command. */
export interface ParseOptions {
  repoDir: string;
  /** `config.playwright.config`, relative to the repo directory. */
  defaultConfig: string;
  /** The number of apps isolate starts, or null when the command's own worker count is kept. */
  workers: number | null;
}

const BUILTIN_REPORTERS = new Set(['list', 'line', 'dot', 'json', 'junit', 'html', 'blob', 'github', 'null']);
const CONFIG_NAMES = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((ext) => `playwright.config.${ext}`);

/** True if a token is a Playwright CLI entry point: `playwright`, a path to its bin or cli.js, or `@playwright/test`. */
function isPlaywrightBin(token: string): boolean {
  const name = path.basename(token).replace(/\.cmd$/, '');
  if (name === 'playwright' || name.startsWith('playwright@')) return true;
  if (token === '@playwright/test' || token.startsWith('@playwright/test@')) return true;
  return /(^|[/\\])(@playwright[/\\]test|playwright)[/\\]cli\.js$/.test(token);
}

/** Reads a flag at `args[index]` in its `--long value`, `--long=value`, `-s value` or `-svalue` form; null if it is another token. */
function flagValue(args: string[], index: number, long: string, short: string | null): { value: string; used: number } | null {
  const token = args[index]!;
  if (token === long || token === short) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    return { value, used: 2 };
  }
  if (token.startsWith(`${long}=`)) return { value: token.slice(long.length + 1), used: 1 };
  if (short !== null && token.startsWith(short) && token.length > short.length) return { value: token.slice(short.length), used: 1 };
  return null;
}

/** Resolves a config path the way Playwright does: a directory means the playwright.config.* inside it. */
function resolveConfig(repoDir: string, file: string): string {
  const resolved = path.resolve(repoDir, file);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const found = CONFIG_NAMES.map((name) => path.join(resolved, name)).find((candidate) => existsSync(candidate));
    if (found === undefined) throw new Error(`No playwright.config.* in ${resolved}`);
    return found;
  }
  if (!existsSync(resolved)) throw new Error(`Playwright config not found: ${resolved}`);
  return resolved;
}

/** Reporter names from the CLI; custom reporter paths are made absolute because the wrapper may live elsewhere. */
function resolveReporters(repoDir: string, value: string): string[] {
  return value
    .split(',')
    .filter(Boolean)
    .map((name) => (BUILTIN_REPORTERS.has(name) || !name.startsWith('.') ? name : path.resolve(repoDir, name)));
}

/** Parses the user's command; throws a message for the user when isolate cannot run it (DECISIONS D-003). */
export function parsePlaywrightCommand(command: string[], options: ParseOptions): PlaywrightCommand {
  const testIndex = command.findIndex((token, i) => i > 0 && token === 'test' && isPlaywrightBin(command[i - 1]!));
  if (testIndex === -1) {
    throw new Error(
      `isolate run needs a direct \`playwright test\` command, because it passes its own --config to Playwright ` +
        `(for example: isolate run -- npx playwright test). Got: ${command.join(' ')}. ` +
        'If you use a package.json script, put its Playwright arguments after `npx playwright test` instead.',
    );
  }
  let repoConfig = path.resolve(options.repoDir, options.defaultConfig);
  let cliReporters: string[] | null = null;
  const args: string[] = [];
  const rest = command.slice(testIndex + 1);
  let i = 0;
  while (i < rest.length) {
    const config = flagValue(rest, i, '--config', '-c');
    const reporter = flagValue(rest, i, '--reporter', null);
    const workers = flagValue(rest, i, '--workers', '-j');
    if (config) {
      repoConfig = resolveConfig(options.repoDir, config.value);
    } else if (reporter) {
      cliReporters = resolveReporters(options.repoDir, reporter.value);
    } else if (workers && options.workers !== null && workers.value !== String(options.workers)) {
      throw new Error(
        `The command asks Playwright for ${workers.value} workers, but isolate starts ${options.workers} apps. ` +
          `Use \`isolate run --workers ${workers.value}\` instead, or drop --workers from the command.`,
      );
    } else {
      args.push(...rest.slice(i, i + (workers?.used ?? 1)));
    }
    i += config?.used ?? reporter?.used ?? workers?.used ?? 1;
  }
  if (!existsSync(repoConfig)) throw new Error(`Playwright config not found: ${repoConfig}`);
  return { launcher: command.slice(0, testIndex + 1), args, repoConfig, cliReporters };
}

/** The full command for Playwright: the launcher, `--config <wrapper>` right after `test`, then the arguments. */
export function commandWithConfig(command: PlaywrightCommand, wrapperConfig: string, args: string[] = command.args): string[] {
  return [...command.launcher, '--config', wrapperConfig, ...args];
}
