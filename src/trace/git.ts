import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/** Runs git in `repoDir` and returns its output split at `separator`; throws with git's message if it fails. */
async function git(repoDir: string, args: string[], separator = '\n'): Promise<string[]> {
  const result = await execa('git', args, { cwd: repoDir, reject: false, stripFinalNewline: false });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout.split(separator).filter((item) => item !== '');
}

/** True if the absolute path `file` is `dir` or lies inside it. */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/** Forward slashes on every platform. */
function posix(file: string): string {
  return file.split(path.sep).join('/');
}

/** The commit checked out in `repoDir`, or null outside a git repository or before the first commit. */
export async function headCommit(repoDir: string): Promise<string | null> {
  return git(repoDir, ['rev-parse', 'HEAD']).then(
    (lines) => lines[0] ?? null,
    () => null,
  );
}

/**
 * Which of `paths` (relative to `repoDir` as configured, like `../../pnpm-lock.yaml`) changed since `base`, for those
 * that lie outside `repoDir` but inside its git work tree, which `git diff --relative` does not show. Returned relative
 * to `repoDir`; a directory yields each changed file under it.
 */
async function changedOutside(repoDir: string, base: string, paths: string[]): Promise<string[]> {
  const realRepoDir = realpathSync(repoDir);
  const [topLevel] = await git(repoDir, ['rev-parse', '--show-toplevel']);
  if (topLevel === undefined) return [];
  const outside = paths.filter((entry) => {
    const full = path.resolve(realRepoDir, entry);
    return isWithin(topLevel, full) && !isWithin(realRepoDir, full);
  });
  if (outside.length === 0) return [];
  const changed = await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', base, '--', ...outside], '\0');
  return changed.map((file) => posix(path.relative(realRepoDir, path.join(topLevel, file))));
}

/**
 * Files changed in the working tree since `base` (renames as a deletion plus an addition) and untracked files that are
 * not ignored, relative to `repoDir` with forward slashes, sorted. `outside` names further paths, relative to
 * `repoDir`, to check even though they lie above it (a workspace lockfile, say).
 */
export async function changedFiles(repoDir: string, base: string, outside: string[]): Promise<string[]> {
  const [changed, untracked, above] = await Promise.all([
    git(repoDir, ['diff', '--name-only', '-z', '--no-renames', '--relative', base, '--'], '\0'),
    git(repoDir, ['ls-files', '-z', '--others', '--exclude-standard'], '\0'),
    changedOutside(repoDir, base, outside),
  ]);
  return [...new Set([...changed, ...untracked, ...above])].sort();
}
