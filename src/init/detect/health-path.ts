import path from 'node:path';
import { listFiles, readText, relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';

/** Health routes looked for in the server source, in order of preference. */
const CANDIDATES = ['/health', '/api/health', '/healthz'];

/** Directories of the app that hold server code. */
const SOURCE_DIRS = ['src', 'server', 'app', 'pages', 'routes', 'api', 'lib'];

const isSource = (name: string) => /\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(name);

/** True if a source file declares the route: a quoted literal, or a Next.js file route (app/<route>/route.ts, pages/<route>.ts). */
function declaresRoute(relFile: string, text: string, route: string): boolean {
  const escaped = route.replace(/[/.]/g, '\\$&');
  const fileRoute = new RegExp(`^(src/)?(app${escaped}/route|pages${escaped}(/index)?)\\.[cm]?[jt]sx?$`);
  return fileRoute.test(relFile) || new RegExp(`['"\`]${escaped}['"\`]`).test(text);
}

/** The health-check path: webServer.url's path, else a health route found in the server source, else `/`. */
export function detectHealthPath(repoDir: string, appDir: string, urlPath: string | null): Finding<string> {
  if (urlPath !== null) return found(urlPath, 'path of webServer.url');
  const files = [...listFiles(appDir, isSource, 0), ...SOURCE_DIRS.flatMap((dir) => listFiles(path.join(appDir, dir), isSource, 6))];
  const sources = files.map((file) => ({ file, rel: relPath(appDir, file), text: readText(file) ?? '' }));
  for (const route of CANDIDATES) {
    const hit = sources.find(({ rel, text }) => declaresRoute(rel, text, route));
    if (hit) return found(route, `route in ${relPath(repoDir, hit.file)}`);
  }
  return guess('/', `no path in webServer.url and no ${CANDIDATES.join(', ')} route in the server source`);
}
