import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Files an app serves or runs as code; source maps are left out because they can quote the source verbatim. */
const SERVED_FILE = /\.(js|mjs|cjs|html|css)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'cache']);

/** Every served file under `dir`, recursively. */
function servedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : servedFiles(full);
    return entry.isFile() && SERVED_FILE.test(entry.name) ? [full] : [];
  });
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How often each marker occurs, as a whole token, in the served output: the files under `servedDirs` (relative to the
 * checkout). A mutant is live when its marker's count is higher after its build than in the clean build.
 */
export function countMarkers(appDir: string, servedDirs: string[], markers: string[]): Record<string, number> {
  const texts = servedDirs.flatMap((dir) => servedFiles(path.join(appDir, dir))).map((file) => readFileSync(file, 'utf8'));
  return Object.fromEntries(
    markers.map((marker) => {
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(marker)}(?![\\w$])`, 'g');
      return [marker, texts.reduce((sum, text) => sum + (text.match(pattern)?.length ?? 0), 0)];
    }),
  );
}
