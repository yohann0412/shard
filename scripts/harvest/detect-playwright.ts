import { isIdentifier, isStringLiteral, SourceFile } from './js-source.js';
import { dirOf, join, normalize, type RepoSnapshot } from './repo.js';
import type { Candidate } from './schema.js';

type ConfigFacts = Pick<
  Candidate,
  | 'configuredWorkers'
  | 'fullyParallel'
  | 'hasWebServer'
  | 'webServerCommand'
  | 'baseURLSource'
  | 'baseURLExpression'
  | 'globalSetup'
  | 'setupProjects'
>;

/** A located expression: which file, and where its text starts and ends. */
interface Located {
  file: SourceFile;
  start: number;
  end: number;
}

const ENV_READ = /process\.env|import\.meta\.env|Deno\.env/;
const IMPORT_EXTENSIONS = ['', '.ts', '.js', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.js'];
const MAX_RESOLVE_DEPTH = 3;

function textOf(located: Located): string {
  return located.file.text.slice(located.start, located.end).trim();
}

/** The expression's text on one line, for recording. */
function recorded(located: Located): string {
  return textOf(resolve(located)).replace(/\s*\n\s*/g, ' ');
}

/** Follows a bare identifier to its same-file `const` initializer, a few levels deep. */
function resolve(located: Located, depth = 0): Located {
  const text = textOf(located);
  if (!isIdentifier(text) || depth >= MAX_RESOLVE_DEPTH) return located;
  const start = located.file.declarationStart(text);
  if (start === null) return located;
  return resolve({ file: located.file, start, end: located.file.expressionEnd(start) }, depth + 1);
}

/** Start indexes of the arguments of the call whose `(` is at `open`. */
function callArguments(file: SourceFile, open: number): number[] {
  const starts: number[] = [];
  let i = open + 1;
  while (i < file.text.length) {
    const start = file.skipSpace(i);
    if (file.text[start] === ')') break;
    starts.push(start);
    const end = file.expressionEnd(start);
    if (file.text[end] !== ',') break;
    i = end + 1;
  }
  return starts;
}

/** Object literals that make up the value starting at `at`: `{...}`, an identifier bound to one, or `defineConfig(a, b)`. */
function objectsAt(file: SourceFile, at: number, depth = 0): number[] {
  const start = file.skipSpace(at);
  if (file.text[start] === '{') return [start];
  if (depth >= MAX_RESOLVE_DEPTH) return [];
  const resolved = resolve({ file, start, end: file.expressionEnd(start) });
  if (resolved.start !== start) return objectsAt(file, resolved.start, depth + 1);
  const call = /^[\w$.]+\s*(?:<[^>()]*>)?\s*\(/.exec(textOf(resolved));
  if (call === null) return [];
  const args = callArguments(file, start + call[0].length - 1);
  return args.reverse().flatMap((arg) => objectsAt(file, arg, depth + 1));
}

/** Object literals holding the file's exported Playwright config, most specific first. */
function configObjects(file: SourceFile): number[] {
  for (const pattern of [/\bexport\s+default\s+/g, /\bmodule\.exports\s*=\s*/g]) {
    for (const match of file.text.matchAll(pattern)) {
      if (file.isCode(match.index)) return objectsAt(file, match.index + match[0].length);
    }
  }
  return [];
}

/** Outermost object literals inside `[start, end)`, e.g. both branches of `cond ? {} : { webServer }`. */
function objectsWithin(file: SourceFile, start: number, end: number): number[] {
  const found: number[] = [];
  for (let i = start; i < end; i++) {
    if (!file.isCode(i) || file.text[i] !== '{') continue;
    found.push(i);
    i = file.matchingClose(i);
  }
  return found;
}

/** Finds a property in the given objects, following spreads of same-file identifiers and of conditional objects. */
function findProperty(file: SourceFile, objects: number[], key: string, depth = 0): Located | null {
  for (const open of objects) {
    const properties = file.properties(open);
    const direct = properties.find((property) => property.key === key);
    if (direct) return { file, start: direct.start, end: direct.end };
    if (depth >= MAX_RESOLVE_DEPTH) continue;
    for (const spread of properties.filter((property) => property.key === null)) {
      const resolved = objectsAt(file, spread.start);
      const spreadObjects = resolved.length > 0 ? resolved : objectsWithin(file, spread.start, spread.end);
      const found = findProperty(file, spreadObjects, key, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Looks a top-level config property up in the exported config objects of the config and its local imports; in a file
 * whose config object cannot be found statically, falls back to the property's first textual occurrence.
 */
function configProperty(files: SourceFile[], key: string): Located | null {
  const parsed = files.map((file) => ({ file, objects: configObjects(file) }));
  for (const { file, objects } of parsed) {
    const found = findProperty(file, objects, key);
    if (found) return found;
  }
  for (const { file, objects } of parsed) {
    const start = objects.length === 0 ? file.firstPropertyValue(key) : null;
    if (start !== null) return { file, start, end: file.expressionEnd(start) };
  }
  return null;
}

function identifiersIn(expression: string): string[] {
  return [...expression.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
}

/** Whether a baseURL expression reads the environment, is a literal, or cannot be judged statically. */
function baseURLSourceOf(located: Located): Candidate['baseURLSource'] {
  const expression = textOf(located);
  const related = identifiersIn(expression).map((name) => {
    const start = located.file.declarationStart(name);
    return start === null ? null : textOf(resolve({ file: located.file, start, end: located.file.expressionEnd(start) }));
  });
  if (ENV_READ.test(expression) || related.some((text) => text !== null && ENV_READ.test(text))) return 'env';
  if (isStringLiteral(expression)) return 'hardcoded';
  const literalParts = related.every((text) => text !== null && (isStringLiteral(text) || /^\d+$/.test(text)));
  if (expression.startsWith('`') && related.length > 0 && literalParts) return 'hardcoded';
  return 'unknown';
}

function baseURL(files: SourceFile[]): Located | null {
  const use = configProperty(files, 'use');
  if (use) {
    const resolved = resolve(use);
    const inUse = findProperty(resolved.file, objectsAt(resolved.file, resolved.start), 'baseURL');
    if (inUse) return inUse;
  }
  for (const file of files) {
    const start = file.firstPropertyValue('baseURL');
    if (start !== null) return { file, start, end: file.expressionEnd(start) };
  }
  return null;
}

function webServerCommand(webServer: Located): string | null {
  const { file, start, end } = resolve(webServer);
  for (const match of file.text.slice(start, end).matchAll(/\bcommand\s*:/g)) {
    const at = start + match.index;
    if (!file.isCode(at)) continue;
    const valueStart = file.skipSpace(at + match[0].length);
    return recorded({ file, start: valueStart, end: file.expressionEnd(valueStart) });
  }
  return null;
}

/** Repo paths of the relative modules a config imports, for the files that exist in the tree. */
export function localImports(repo: RepoSnapshot, configPath: string, source: string): string[] {
  const dir = dirOf(configPath);
  const found: string[] = [];
  for (const specifier of new SourceFile(source).relativeImports()) {
    const base = normalize(join(dir, specifier));
    const stem = base.replace(/\.(js|mjs|cjs)$/, '');
    const candidates = [...IMPORT_EXTENSIONS.map((ext) => base + ext), ...IMPORT_EXTENSIONS.map((ext) => stem + ext)];
    const hit = candidates.find((candidate) => repo.has(candidate) && /\.[cm]?[jt]s$/.test(candidate));
    if (hit !== undefined && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Extracts workers, fullyParallel, webServer, baseURL, globalSetup and setup projects from a config and its local imports. */
export function analyzeConfig(sources: string[]): ConfigFacts {
  const files = sources.map((text) => new SourceFile(text));
  const workers = configProperty(files, 'workers');
  const fullyParallel = configProperty(files, 'fullyParallel');
  const webServer = configProperty(files, 'webServer');
  const url = baseURL(files);
  return {
    configuredWorkers: workers ? recorded(workers) : null,
    fullyParallel: fullyParallel ? recorded(fullyParallel) : null,
    hasWebServer: webServer !== null,
    webServerCommand: webServer ? webServerCommand(webServer) : null,
    baseURLSource: url ? baseURLSourceOf(resolve(url)) : 'none',
    baseURLExpression: url ? recorded(url) : null,
    globalSetup: configProperty(files, 'globalSetup') !== null,
    setupProjects: files.some((file) => file.codeMatches(/\bdependencies\s*:/)),
  };
}

const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'];

function playwrightRange(repo: RepoSnapshot, packagePath: string) {
  const manifest = repo.packageJson(packagePath);
  if (manifest === null) return null;
  const maps = [manifest.devDependencies, manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies];
  for (const name of PLAYWRIGHT_PACKAGES) {
    const range = maps.map((map) => map?.[name]).find((value) => value !== undefined);
    if (range !== undefined) return { name, range };
  }
  return null;
}

/** Resolves a `catalog:` range from pnpm-workspace.yaml or the root package.json catalog. */
function catalogRange(repo: RepoSnapshot, name: string, range: string): string | null {
  const catalogName = range.slice('catalog:'.length).trim();
  const root = repo.packageJson('package.json');
  const fromPackage = root?.catalog?.[name] ?? root?.workspaces?.catalog?.[name];
  if (catalogName === '' && fromPackage !== undefined) return `${fromPackage} (package.json catalog)`;
  const yaml = repo.text('pnpm-workspace.yaml');
  if (yaml === undefined) return null;
  const escaped = name.replace(/[/@.-]/g, '\\$&');
  const lines = [...yaml.matchAll(new RegExp(`^\\s+['"]?${escaped}['"]?:\\s*['"]?([^'"\\s#]+)`, 'gm'))];
  const values = [...new Set(lines.map((match) => match[1]))];
  return values.length === 0 ? null : `${values.join(' | ')} (pnpm-workspace.yaml catalog${values.length > 1 ? 's' : ''})`;
}

/** The Playwright version range from the package.json nearest the config, then the root, then any other. */
export function playwrightVersion(repo: RepoSnapshot, configPath: string): Candidate['playwrightVersion'] {
  const nearest = repo.nearestUp(dirOf(configPath), 'package.json');
  const ordered = [nearest, 'package.json'].filter((p): p is string => p !== null);
  const others = repo.packageJsons().map(([p]) => p).filter((p) => !ordered.includes(p));
  for (const packagePath of [...ordered, ...others]) {
    const found = playwrightRange(repo, packagePath);
    if (found === null) continue;
    const notes: string[] = [];
    if (!ordered.includes(packagePath)) notes.push('not declared in the nearest or root package.json');
    if (found.range.startsWith('catalog:')) {
      const resolved = catalogRange(repo, found.name, found.range);
      notes.push(resolved === null ? 'catalog: ref, not resolved' : `catalog: ref resolves to ${resolved}`);
    }
    if (found.range.startsWith('workspace:')) notes.push('workspace: ref (Playwright built in this repository)');
    return { range: found.range, package: found.name, packageJson: packagePath, note: notes.length ? notes.join('; ') : null };
  }
  return { range: null, package: null, packageJson: null, note: 'no package.json declares @playwright/test or playwright' };
}
