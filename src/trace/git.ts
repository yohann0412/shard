import { execa } from 'execa';

/** Runs git in `repoDir` and returns its output split at `separator`; throws with git's message if it fails. */
async function git(repoDir: string, args: string[], separator = '\n'): Promise<string[]> {
  const result = await execa('git', args, { cwd: repoDir, reject: false, stripFinalNewline: false });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout.split(separator).filter((item) => item !== '');
}

/** The commit checked out in `repoDir`, or null outside a git repository or before the first commit. */
export async function headCommit(repoDir: string): Promise<string | null> {
  return git(repoDir, ['rev-parse', 'HEAD']).then(
    (lines) => lines[0] ?? null,
    () => null,
  );
}

/**
 * Files changed in the working tree since `base` (renames as a deletion plus an addition) and untracked files that are
 * not ignored, relative to `repoDir` with forward slashes, sorted.
 */
export async function changedFiles(repoDir: string, base: string): Promise<string[]> {
  const [changed, untracked] = await Promise.all([
    git(repoDir, ['diff', '--name-only', '-z', '--no-renames', '--relative', base, '--'], '\0'),
    git(repoDir, ['ls-files', '-z', '--others', '--exclude-standard'], '\0'),
  ]);
  return [...new Set([...changed, ...untracked])].sort();
}
