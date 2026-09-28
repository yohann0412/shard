import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execaSync } from 'execa';

/** Runs a git command in `cwd` and returns its trimmed stdout, or null if it failed (for example, not a git repo). */
function git(args: string[], cwd: string): string | null {
  const result = execaSync('git', args, { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Lists files of `dir` in the repository's `.git/info/exclude` so a run never shows them as untracked.
 * Does nothing outside a git repository. Entries are anchored paths and are added once.
 */
export function excludeFromGit(dir: string, names: string[]): void {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  const excludePath = git(['rev-parse', '--git-path', 'info/exclude'], dir);
  if (top === null || excludePath === null) return;
  const excludeFile = path.resolve(dir, excludePath);
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const present = new Set(existing.split('\n'));
  const entries = names.map((name) => `/${path.relative(top, path.join(realpathSync(dir), name)).split(path.sep).join('/')}`);
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(excludeFile, `${separator}${missing.join('\n')}\n`);
}
