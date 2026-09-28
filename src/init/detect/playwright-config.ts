import path from 'node:path';
import { isFile, searchableSubdirs } from '../files.js';

const NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];

/** The directories searched for a Playwright config, in order: the repo, e2e/, tests/, apps/*, packages/*. */
function candidateDirs(repoDir: string): string[] {
  return [
    repoDir,
    path.join(repoDir, 'e2e'),
    path.join(repoDir, 'tests'),
    ...searchableSubdirs(path.join(repoDir, 'apps')),
    ...searchableSubdirs(path.join(repoDir, 'packages')),
  ];
}

/** Every Playwright config file (absolute) in the repo directory and its usual subdirectories, first match first. */
export function findPlaywrightConfigs(repoDir: string): string[] {
  return candidateDirs(repoDir).flatMap((dir) => NAMES.map((name) => path.join(dir, name)).filter(isFile));
}
