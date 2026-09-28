import { z } from 'zod';
import { dirOf, isExampleLike, join, normalize, selfAndAncestors, type RepoSnapshot } from './repo.js';
import type { Candidate, E2EScript } from './schema.js';

const RUNS_PLAYWRIGHT = /\bplaywright\s+test\b/;
const INTERACTIVE_COMMAND = /--ui\b|--debug\b|--headed\b|PWDEBUG=|codegen|show-report|--list\b|--update-snapshots\b|\s-u\b/;
const INTERACTIVE_NAME = /(^|[:_-])(debug|headed|headful|codegen|report|update|snapshots?|install|watch)([:_-]|$)/i;
const E2E_NAME = /(^|[:_-])(e2e|playwright)([:_-]|$)/i;
const WRAPPER_NAME = /^(test[:_-]?)?(e2e|playwright)([:_-](test|run|ci|all|local|headless))?$/i;
const RUNS_E2E_FILE = /(^|[\s/])(e2e|playwright)[\w-]*\/[\w./-]*\.(sh|[cm]?[jt]s)\b/;
const INDIRECT = /--filter|\bworkspace\b|\s-w\s|--workspace|--prefix|--cwd|\s-C\s/;
const DOC_FILE = /(^|\/)(readme|contributing|testing|development|developing)(\.[\w-]+)?\.(md|mdx|rst|txt)$/i;
const DOC_MENTION = /playwright|\be2e\b|end-to-end|end to end/i;
const DOC_COMMAND = /\b(npx|pnpm|yarn|npm|bun|bunx|nx|turbo|just|make|docker compose)\s+[\w:@./-]+|playwright\s+test/;
const MAX_DOC_EVIDENCE = 3;

/** A runnable command and the directory it runs in. */
interface Script {
  file: string;
  name: string;
  command: string;
  cwd: string;
}

function script(file: string, name: string, command: string, dir: string): Script {
  const cd = /^\s*cd\s+['"]?([^\s'"&;]+)['"]?\s*&&/.exec(command)?.[1];
  return { file, name, command, cwd: cd === undefined ? dir : normalize(join(dir, cd)) };
}

const NxCommand = z.union([z.string(), z.object({ command: z.string() })]);
const NxProjectSchema = z.object({
  targets: z.record(
    z.string(),
    z.object({
      options: z
        .object({ command: z.string().optional(), commands: z.array(NxCommand).optional(), cwd: z.string().optional() })
        .optional(),
    }),
  ),
});

/** Commands of the targets of an Nx project (run from the workspace root unless `cwd` is set). */
function nxScripts(file: string, project: unknown): Script[] {
  const parsed = NxProjectSchema.safeParse(project);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.targets).flatMap(([name, target]) => {
    const commands = [target.options?.command, ...(target.options?.commands ?? [])];
    return commands
      .map((command) => (typeof command === 'object' ? command.command : command))
      .filter((command): command is string => command !== undefined)
      .map((command) => script(file, name, command, normalize(target.options?.cwd ?? '')));
  });
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

/** Scripts of a package.json (plus its inline `nx` targets), or the targets of an Nx project.json. */
function scriptsIn(repo: RepoSnapshot, file: string): Script[] {
  if (file.endsWith('project.json')) return nxScripts(file, parseJson(repo.text(file)));
  const manifest = repo.packageJson(file);
  const scripts = Object.entries(manifest?.scripts ?? {}).map(([name, command]) => script(file, name, command, dirOf(file)));
  return [...scripts, ...nxScripts(file, manifest?.nx)];
}

function interactive(candidate: Script): boolean {
  return INTERACTIVE_COMMAND.test(candidate.command) || INTERACTIVE_NAME.test(candidate.name);
}

/** True when a `playwright test` command runs this config: its `--config` points at it, or it runs in the config's directory. */
function runsConfig(candidate: Script, configPath: string): boolean {
  const config = /(?:--config[=\s]+|\s-c\s+)['"]?([^\s'"]+)/.exec(candidate.command)?.[1];
  if (config !== undefined) return normalize(join(candidate.cwd, config)) === configPath;
  return candidate.cwd === dirOf(configPath) || INDIRECT.test(candidate.command);
}

/**
 * The script that runs this config's `playwright test` (non-interactive), searching the package.json and Nx project.json
 * files from the config's directory up to the root, then everywhere else; e2e-named scripts first. When none runs
 * Playwright directly, a wrapper (named like `e2e` or `test:e2e`, or running a script file under an e2e/playwright
 * directory) is returned with `direct: false`.
 */
export function findE2EScript(repo: RepoSnapshot, configPath: string): E2EScript | null {
  const chain = selfAndAncestors(dirOf(configPath)).flatMap((dir) => [join(dir, 'package.json'), join(dir, 'project.json')]);
  const others = repo.packageJsons().map(([file]) => file).filter((file) => !chain.includes(file) && !isExampleLike(file));
  const scripts = [...chain, ...others].flatMap((file) => scriptsIn(repo, file)).filter((s) => !interactive(s));
  const e2eFirst = (list: Script[]) => [...list.filter((s) => E2E_NAME.test(s.name)), ...list.filter((s) => !E2E_NAME.test(s.name))];
  const direct = e2eFirst(scripts.filter((s) => RUNS_PLAYWRIGHT.test(s.command) && runsConfig(s, configPath)))[0];
  if (direct) return { file: direct.file, name: direct.name, command: direct.command, direct: true };
  const wrapper = scripts.find((s) => (WRAPPER_NAME.test(s.name) || RUNS_E2E_FILE.test(s.command)) && !RUNS_PLAYWRIGHT.test(s.command));
  return wrapper ? { file: wrapper.file, name: wrapper.name, command: wrapper.command, direct: false } : null;
}

/** Whether README/CONTRIBUTING-style docs mention how to run the e2e suite, or an e2e script exists. */
export function documentedE2E(repo: RepoSnapshot, script: E2EScript | null): Candidate['documentedE2E'] {
  const evidence: string[] = [];
  for (const [file, text] of repo.fetched(DOC_FILE)) {
    for (const line of text.split('\n')) {
      if (evidence.length >= MAX_DOC_EVIDENCE) break;
      if (DOC_MENTION.test(line) && DOC_COMMAND.test(line)) evidence.push(`${file}: ${line.trim().slice(0, 140)}`);
    }
  }
  if (script) evidence.push(`${script.file}: script "${script.name}" runs \`${script.command.slice(0, 120)}\``);
  return { value: evidence.length > 0, evidence };
}

/** Repo paths of docs worth reading for e2e instructions: .github and docs/ top-level files, and the config's directory chain. */
export function docPaths(paths: string[], configPath: string): string[] {
  const configDirs = new Set(selfAndAncestors(dirOf(configPath)));
  return paths.filter((filePath) => {
    if (!DOC_FILE.test(filePath)) return false;
    const dir = dirOf(filePath);
    return configDirs.has(dir) || dir === '.github' || dir === 'docs';
  });
}
