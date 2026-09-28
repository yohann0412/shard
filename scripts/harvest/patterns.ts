import { isExampleLike, type PackageJson, type RepoSnapshot } from './repo.js';

/** Playwright config files, anywhere outside node_modules. */
export const PLAYWRIGHT_CONFIG = /(^|\/)playwright\.config\.(ts|js|mjs|cjs)$/;
/** `.env.example`, `.env.sample`, `.env.template` and variants such as `.env.test.example`. */
export const ENV_EXAMPLE = /(^|\/)\.env(\.[\w-]+)*?\.(example|sample|template)(\.[\w-]+)?$/;
/** `docker-compose*.y(a)ml` and `compose*.y(a)ml`. */
export const COMPOSE_FILE = /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i;
/** `schema.prisma` anywhere, or any `.prisma` file under a `prisma/` directory. */
export const PRISMA_SCHEMA = /(^|\/)schema\.prisma$|(^|\/)prisma\/(.+\/)?[^/]+\.prisma$/;
/** `drizzle.config.*`. */
export const DRIZZLE_CONFIG = /(^|\/)drizzle\.config\.[cm]?[jt]s$/;
/** package.json files. */
export const PACKAGE_JSON = /(^|\/)package\.json$/;

const DOCS_DIR = /(^|\/)docs?\//i;
const MAX_EVIDENCE = 5;

/** Deduplicated evidence, cut to a few entries plus a count of the rest. */
export function capped(evidence: string[]): string[] {
  const unique = [...new Set(evidence)];
  return unique.length <= MAX_EVIDENCE ? unique : [...unique.slice(0, MAX_EVIDENCE), `(+${unique.length - MAX_EVIDENCE} more)`];
}

/** Uncommented `KEY=value` lines of an env file. */
export function envKeys(text: string): Array<{ key: string; value: string }> {
  const keys: Array<{ key: string; value: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) keys.push({ key: match[1], value: (match[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2') });
  }
  return keys;
}

/** `image:` values of a compose file. */
export function composeImages(text: string): string[] {
  return [...text.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((match) => match[1] ?? '');
}

/** Dependency names of a manifest (runtime and optional, plus dev unless excluded). */
export function dependencies(manifest: PackageJson, includeDev = true): string[] {
  const maps = [manifest.dependencies, manifest.optionalDependencies, includeDev ? manifest.devDependencies : undefined];
  return maps.flatMap((map) => Object.keys(map ?? {}));
}

/** True for paths that describe the app itself, not examples, templates, fixtures or docs. */
export function isAppPath(filePath: string): boolean {
  return !isExampleLike(filePath) && !DOCS_DIR.test(filePath);
}

/** Fetched app files (see isAppPath) that match `pattern`. */
export function appFiles(repo: RepoSnapshot, pattern: RegExp): Array<[string, string]> {
  return repo.fetched(pattern).filter(([filePath]) => isAppPath(filePath));
}

/** Parsed app package.json files (see isAppPath). */
export function appPackages(repo: RepoSnapshot): Array<[string, PackageJson]> {
  return repo.packageJsons().filter(([filePath]) => isAppPath(filePath));
}
