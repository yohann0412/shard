import path from 'node:path';
import { isFile, relPath, type PackageJson } from './files.js';

/** The package managers isolate knows how to run scripts with. */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** The command that runs a package.json script with this package manager, e.g. `pnpm build` or `npm run build`. */
export function scriptCommand(packageManager: PackageManager, script: string): string {
  return packageManager === 'npm' || packageManager === 'bun' ? `${packageManager} run ${script}` : `${packageManager} ${script}`;
}

/** Prefixes `cd <dir> && ` when a command must run in a directory other than the repo directory. */
export function inDir(repoDir: string, dir: string, command: string): string {
  const rel = relPath(repoDir, dir);
  return rel === '.' ? command : `cd ${rel} && ${command}`;
}

/** The body of the package.json script a command runs (`pnpm start`, `npm run start`, `yarn start`), or null. */
export function scriptBody(command: string, pkg: PackageJson | null): string | null {
  const match = /^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)$/.exec(command.trim());
  return match ? (pkg?.scripts?.[match[1]!] ?? null) : null;
}

/** Files (absolute) a shell command run in `dir` names as arguments, e.g. `scripts/seed.mjs` in `node scripts/seed.mjs`. */
export function filesInCommand(dir: string, command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .filter((token) => /[/.]/.test(token) && !token.startsWith('-'))
    .map((token) => path.resolve(dir, token))
    .filter(isFile);
}
