import { execa } from 'execa';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };

/** One blob in a repository's HEAD tree. */
export interface TreeEntry {
  path: string;
  oid: string;
}

async function git(cwd: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  const result = await execa('git', args, { cwd, env: GIT_ENV, cancelSignal: signal, input, stripFinalNewline: false });
  return result.stdout;
}

/** Shallow, blob-less, checkout-less clone of the default branch. */
export async function cloneTreeOnly(url: string, dir: string, signal: AbortSignal): Promise<void> {
  const args = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', url, dir];
  await execa('git', args, { env: GIT_ENV, cancelSignal: signal });
}

/** Full clone of a small repository's default branch (used for awesome-selfhosted-data). */
export async function cloneShallow(url: string, dir: string, signal: AbortSignal): Promise<void> {
  await execa('git', ['clone', '--quiet', '--depth', '1', '--single-branch', url, dir], { env: GIT_ENV, cancelSignal: signal });
}

/** HEAD commit hash and committer date (ISO 8601). */
export async function headCommit(dir: string, signal: AbortSignal): Promise<{ sha: string; date: string }> {
  const [sha = '', date = ''] = (await git(dir, ['log', '-1', '--format=%H%n%cI'], signal)).split('\n');
  return { sha, date };
}

/** Every blob path in HEAD with its object id (`git ls-tree -r`). */
export async function listTree(dir: string, signal: AbortSignal): Promise<TreeEntry[]> {
  const out = await git(dir, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], signal);
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(' ');
    if (type === 'blob' && oid !== undefined) entries.push({ path: record.slice(tab + 1), oid });
  }
  return entries;
}

/** Fetches the given blobs in one round trip, instead of one lazy fetch per `git show`. */
export async function prefetchBlobs(dir: string, oids: string[], signal: AbortSignal): Promise<void> {
  if (oids.length === 0) return;
  const args = ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head'];
  await git(dir, [...args, '--recurse-submodules=no', '--filter=blob:none', '--stdin', 'origin'], signal, oids.join('\n'));
}

/** Contents of one file at HEAD (`git show HEAD:<path>`). */
export async function showFile(dir: string, filePath: string, signal: AbortSignal): Promise<string> {
  return git(dir, ['show', `HEAD:${filePath}`], signal);
}

/** HEAD commit hash of a remote without cloning it. */
export async function remoteHead(url: string, signal: AbortSignal): Promise<string | null> {
  const result = await execa('git', ['ls-remote', url, 'HEAD'], { env: GIT_ENV, cancelSignal: signal, reject: false });
  if (result.exitCode !== 0) return null;
  return result.stdout.split('\t')[0] || null;
}
