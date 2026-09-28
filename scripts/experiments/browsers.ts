import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { workDir } from './paths.js';

/** Where the sandbox's pre-installed browsers are. */
const INSTALLED_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';

/** Marker files Playwright checks before it trusts a browser directory. */
const MARKERS = ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED'];

/** The browsers every arm of one repo runs with (DECISIONS D-010). */
export interface Browsers {
  /** Value of PLAYWRIGHT_BROWSERS_PATH for every arm. */
  path: string;
  /** Revisions the checkout's Playwright expects. */
  expected: { chromium: string; headlessShell: string; ffmpeg: string };
  /** Revisions installed in the sandbox. */
  installed: { chromium: string; headlessShell: string; ffmpeg: string };
  /** True when `path` is a shim exposing the installed Chromium under the expected revision. */
  shim: boolean;
}

/** Resolves `name/package.json` from `fromFile`'s location, the way Node would from inside that package. */
function packageJson(fromFile: string, name: string): string {
  return createRequire(fromFile).resolve(`${name}/package.json`);
}

/** Revisions from the browsers.json of the playwright-core that the checkout's @playwright/test uses. */
function expectedRevisions(appDir: string): Browsers['expected'] {
  const test = packageJson(path.join(appDir, 'package.json'), '@playwright/test');
  const core = packageJson(packageJson(test, 'playwright'), 'playwright-core');
  const { browsers } = JSON.parse(readFileSync(path.join(path.dirname(core), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
  const revision = (name: string) => {
    const found = browsers.find((browser) => browser.name === name);
    if (found === undefined) throw new Error(`${core}/../browsers.json lists no ${name}`);
    return found.revision;
  };
  return { chromium: revision('chromium'), headlessShell: revision('chromium-headless-shell'), ffmpeg: revision('ffmpeg') };
}

/** Revisions of the installed browser directories, e.g. chromium-1194 → 1194. */
function installedRevisions(): Browsers['installed'] {
  const entries = readdirSync(INSTALLED_DIR);
  const revision = (prefix: string) => {
    const found = entries.find((entry) => new RegExp(`^${prefix}-\\d+$`).test(entry));
    if (found === undefined) throw new Error(`no ${prefix}-<revision> in ${INSTALLED_DIR}`);
    return found.slice(prefix.length + 1);
  };
  return { chromium: revision('chromium'), headlessShell: revision('chromium_headless_shell'), ffmpeg: revision('ffmpeg') };
}

/**
 * Makes `<dir>/<name>-<expected>` expose an installed browser whose files live in `<installed>/chrome-linux`. Playwright
 * up to 1.56 looks in `chrome-linux/`, 1.57 and later in `<newLayout>/` under different executable names, so plain
 * directory symlinks are not enough (scout, experiments/recipes/SCOUT_LOG.md): the new layout is a real directory of
 * per-file symlinks plus a link under the new executable name.
 */
function shimBrowser(dir: string, name: string, expected: string, installed: string, newLayout: string, renamed: [string, string] | null): void {
  const target = path.join(dir, `${name}-${expected}`);
  const files = path.join(INSTALLED_DIR, `${name}-${installed}`, 'chrome-linux');
  mkdirSync(path.join(target, newLayout), { recursive: true });
  symlinkSync(files, path.join(target, 'chrome-linux'));
  for (const file of readdirSync(files)) symlinkSync(path.join(files, file), path.join(target, newLayout, file));
  if (renamed !== null) symlinkSync(path.join(files, renamed[0]), path.join(target, newLayout, renamed[1]));
  for (const marker of MARKERS) writeFileSync(path.join(target, marker), '');
}

/**
 * The PLAYWRIGHT_BROWSERS_PATH for a checkout: the installed directory when its Playwright expects the installed
 * Chromium revision, otherwise a freshly built shim in work/pw-browsers/r<revision> that exposes the installed
 * Chromium, headless shell and ffmpeg under the revisions the checkout expects. Every arm of the repo uses it.
 */
export function browsersFor(appDir: string): Browsers {
  const expected = expectedRevisions(appDir);
  const installed = installedRevisions();
  if (expected.chromium === installed.chromium && expected.headlessShell === installed.headlessShell) {
    return { path: INSTALLED_DIR, expected, installed, shim: false };
  }
  const dir = path.join(workDir, 'pw-browsers', `r${expected.chromium}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  shimBrowser(dir, 'chromium', expected.chromium, installed.chromium, 'chrome-linux64', null);
  shimBrowser(dir, 'chromium_headless_shell', expected.headlessShell, installed.headlessShell, 'chrome-headless-shell-linux64', ['headless_shell', 'chrome-headless-shell']);
  symlinkSync(path.join(INSTALLED_DIR, `ffmpeg-${installed.ffmpeg}`), path.join(dir, `ffmpeg-${expected.ffmpeg}`));
  return { path: dir, expected, installed, shim: true };
}
