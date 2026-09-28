import path from 'node:path';
import { z } from 'zod';

const DependencyMap = z.record(z.string(), z.string()).optional().catch(undefined);

/** The package.json fields the harvest reads; anything malformed is dropped rather than failing the repo. */
const PackageJsonSchema = z.object({
  name: z.string().optional().catch(undefined),
  scripts: z.record(z.string(), z.string()).optional().catch(undefined),
  dependencies: DependencyMap,
  devDependencies: DependencyMap,
  peerDependencies: DependencyMap,
  optionalDependencies: DependencyMap,
  catalog: DependencyMap,
  workspaces: z.object({ catalog: DependencyMap }).passthrough().optional().catch(undefined),
  nx: z.unknown().optional(),
});
export type PackageJson = z.infer<typeof PackageJsonSchema>;

const EXAMPLE_WORD = '(examples?|templates?|fixtures?|demos?|playgrounds?|sandbox|samples?|starters?)';
const EXAMPLE_DIR = new RegExp(`(^|/)(__fixtures__|${EXAMPLE_WORD}([-_.][\\w.-]*)?|[\\w.-]*[-_]${EXAMPLE_WORD})/`, 'i');

/** True for paths under example, template, fixture, demo or playground directories. */
export function isExampleLike(filePath: string): boolean {
  return EXAMPLE_DIR.test(filePath);
}

/** Number of path segments (`a/b/c.json` is 3). */
export function depth(filePath: string): number {
  return filePath.split('/').length;
}

/** Directory of a repo-relative path, `''` for the root. */
export function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '' : dir;
}

/** `dir` and each of its ancestors up to the repository root (`''`). */
export function selfAndAncestors(dir: string): string[] {
  const dirs = [dir];
  let current = dir;
  while (current !== '') {
    current = dirOf(current);
    dirs.push(current);
  }
  return dirs;
}

/** Joins a repo-relative directory and a file name. */
export function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Resolves `.` and `..` segments of a repo-relative path. */
export function normalize(filePath: string): string {
  const parts: string[] = [];
  for (const part of filePath.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

/** A repository's HEAD tree listing plus the contents of the files fetched for it. */
export class RepoSnapshot {
  private readonly pathSet: Set<string>;
  private readonly packages = new Map<string, PackageJson | null>();

  constructor(
    readonly paths: string[],
    private readonly contents: Map<string, string>,
  ) {
    this.pathSet = new Set(paths);
  }

  /** True when the path exists in the tree. */
  has(filePath: string): boolean {
    return this.pathSet.has(filePath);
  }

  /** Fetched contents of a file, or undefined if it was not fetched. */
  text(filePath: string): string | undefined {
    return this.contents.get(filePath);
  }

  /** Every fetched file whose path matches `pattern`. */
  fetched(pattern: RegExp): Array<[string, string]> {
    return [...this.contents].filter(([filePath]) => pattern.test(filePath));
  }

  /** Parsed package.json at `filePath`, or null if it is missing or not valid JSON. */
  packageJson(filePath: string): PackageJson | null {
    if (!this.packages.has(filePath)) {
      const raw = this.contents.get(filePath);
      let parsed: PackageJson | null = null;
      if (raw !== undefined) {
        try {
          parsed = PackageJsonSchema.parse(JSON.parse(raw));
        } catch {
          parsed = null;
        }
      }
      this.packages.set(filePath, parsed);
    }
    return this.packages.get(filePath) ?? null;
  }

  /** Every fetched package.json that parsed, as `[path, manifest]`. */
  packageJsons(): Array<[string, PackageJson]> {
    return this.fetched(/(^|\/)package\.json$/)
      .map(([filePath]) => [filePath, this.packageJson(filePath)] as const)
      .filter((entry): entry is [string, PackageJson] => entry[1] !== null);
  }

  /** The first existing `name` walking up from `dir` to the root. */
  nearestUp(dir: string, name: string): string | null {
    return selfAndAncestors(dir).map((d) => join(d, name)).find((candidate) => this.has(candidate)) ?? null;
  }
}
