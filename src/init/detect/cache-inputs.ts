import path from 'node:path';
import { CONFIG_FILE } from '../../config/load.js';
import { isFile, relPath } from '../files.js';

/** What the database cache key is made of (absolute paths). */
export interface CacheParts {
  lockfile: string | null;
  /** Directories whose package.json counts: the repo's, and those the database steps run in. */
  packageDirs: string[];
  /** Migration directories, schema, migrate and seed files. */
  stepInputs: string[];
}

/** cache.inputs, relative to the repo: the lockfile, package.json files, migration and seed inputs, and isolate.config.ts. */
export function cacheInputs(repoDir: string, parts: CacheParts): string[] {
  const packageJsons = parts.packageDirs.map((dir) => path.join(dir, 'package.json')).filter(isFile);
  const files = [...(parts.lockfile === null ? [] : [parts.lockfile]), ...packageJsons, ...parts.stepInputs, path.join(repoDir, CONFIG_FILE)];
  return [...new Set(files.map((file) => relPath(repoDir, file)))];
}
