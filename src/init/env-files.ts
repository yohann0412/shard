import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isDir, readText, relPath } from './files.js';

/** One `KEY=value` line of a committed dotenv file. */
export interface EnvEntry {
  key: string;
  value: string;
  /** The file, relative to the repo directory. */
  file: string;
}

/**
 * Committed dotenv files in a directory (`.env.example`, `.env.test`, ...): every `.env.*` except `.env` itself and
 * `*.local` files, which hold a developer's own values.
 */
function envExampleFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith('.env.') && !name.endsWith('.local'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Parses `KEY=value` lines (an `export ` prefix, quotes and comments allowed). */
function parseEnv(text: string): Array<{ key: string; value: string }> {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return [];
    const raw = match[2]!.trim();
    const quoted = /^(['"])(.*)\1/.exec(raw);
    return [{ key: match[1]!, value: quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '') }];
  });
}

/** Every entry of the committed dotenv files in these directories, in directory order, with paths relative to repoDir. */
export function envExampleEntries(repoDir: string, dirs: string[]): EnvEntry[] {
  const files = [...new Set(dirs.flatMap(envExampleFiles))];
  return files.flatMap((file) => parseEnv(readText(file) ?? '').map((entry) => ({ ...entry, file: relPath(repoDir, file) })));
}
