import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { relativeFile } from './test-id.js';
import { ENV_MODULE, WRAPPER_CONFIG } from './wrapper.js';

const SKIPPED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.isolate', '.next', '.nuxt', '.output', '.svelte-kit',
  '.turbo', '.cache', '.vercel', 'test-results', 'playwright-report', 'blob-report',
]);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?![\w.-])/i;
const TEST_DIR_OPTION = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/g;
const MAX_LINE = 160;

/** Every source file below `dir`, skipping dependency, build output and report directories. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) files.push(...sourceFiles(full));
    if (entry.isFile() && SOURCE_FILE.test(entry.name) && entry.name !== WRAPPER_CONFIG && entry.name !== ENV_MODULE) files.push(full);
  }
  return files;
}

/** Directories the config names as `testDir`, or the config's own directory when it names none. */
function testRoots(configFile: string, configText: string): string[] {
  const configDir = path.dirname(configFile);
  const named = [...configText.matchAll(TEST_DIR_OPTION)].map((match) => path.resolve(configDir, match[1]!));
  const roots = named.filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
  return roots.length > 0 ? [...new Set(roots)] : [configDir];
}

/**
 * Test files, plus helper files: every source file in a directory tree that holds test files.
 * Application code next to the tests' directories is not included.
 */
function testAndHelperFiles(configFile: string, configText: string): string[] {
  const all = [...new Set(testRoots(configFile, configText).flatMap(sourceFiles))];
  const testDirs = [...new Set(all.filter((file) => TEST_FILE.test(file)).map((file) => path.dirname(file)))];
  return all.filter((file) => testDirs.some((dir) => file.startsWith(`${dir}${path.sep}`)));
}

/** `file:line: text` for every line with an absolute local URL. */
function hardcodedUrls(files: string[], repoDir: string): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!LOCAL_URL.test(line)) return;
        const text = line.trim();
        hits.push(`${relativeFile(repoDir, file)}:${index + 1}: ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text}`);
      });
  }
  return hits;
}

/**
 * Looks for what isolation cannot fix without test edits: absolute local URLs in test and helper files,
 * and shared auth state from globalSetup or setup projects (RISKS R2, R9). Returns one warning per finding kind.
 */
export function scanForHazards(configFile: string, repoDir: string): string[] {
  const configText = readFileSync(configFile, 'utf8');
  const warnings: string[] = [];
  const urls = hardcodedUrls(testAndHelperFiles(configFile, configText), repoDir);
  if (urls.length > 0) {
    warnings.push(['hardcoded URL(s) in test files: these requests are not redirected to the per-worker app', ...urls.map((hit) => `  ${hit}`)].join('\n'));
  }
  if (/\bglobalSetup\b/.test(configText)) {
    warnings.push("the Playwright config uses globalSetup: whatever it writes to the database (e.g. a signed-in session) lands in worker 0's database only");
  }
  if (/\bdependencies\s*:/.test(configText)) {
    warnings.push("the Playwright config has project dependencies: a setup project's database writes (e.g. a signed-in session) land in one worker's database only");
  }
  return warnings;
}
