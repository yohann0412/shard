import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isDir, relPath, searchableSubdirs } from '../files.js';
import { found, type Finding } from '../finding.js';
import { isNextApp } from './framework.js';

/** A directory of client scripts served verbatim under a URL prefix. */
export interface ClientRoot {
  urlPrefix: string;
  dir: string;
}

const hasScripts = (dir: string) => readdirSync(dir).some((name) => /\.m?js$/.test(name));

/** The shallowest directories below `dir` (itself included) that contain scripts. */
function scriptDirs(dir: string): string[] {
  return hasScripts(dir) ? [dir] : searchableSubdirs(dir).flatMap(scriptDirs);
}

/**
 * Where client scripts live for tracing: the shallowest directories of public/ with scripts, each under the URL
 * path it is served at (public/ at `/`). Next.js apps get none: their client code is mapped through source maps.
 */
export function detectClientRoots(repoDir: string, appDir: string): Finding<ClientRoot[]> {
  if (isNextApp(appDir)) return found([], 'Next.js app: client code is mapped through source maps');
  const publicDir = path.join(appDir, 'public');
  if (!isDir(publicDir)) return found([], `no ${relPath(repoDir, publicDir)}/ directory`);
  const roots = scriptDirs(publicDir).map((dir) => {
    const urlPath = relPath(publicDir, dir);
    return { urlPrefix: urlPath === '.' ? '/' : `/${urlPath}/`, dir: relPath(repoDir, dir) };
  });
  return found(roots, `scripts under ${relPath(repoDir, publicDir)}/ (served at / by convention)`);
}
