import path from 'node:path';
import { isDir, readPackageJson, readText, relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';
import { inDir, scriptCommand, type PackageManager } from '../scripts.js';
import { isNextApp } from './framework.js';

/** The build command and the directories it writes. */
export interface BuildFinding {
  command: Finding<string>;
  outputs: Finding<string[]>;
}

/** The build command: the step split off webServer.command, else the `build` script of the app or the repo. */
function buildCommand(repoDir: string, appDir: string, packageManager: PackageManager, split: Finding<string> | null): Finding<string> | null {
  if (split !== null) return split;
  const dir = [...new Set([appDir, repoDir])].find((d) => readPackageJson(d)?.scripts?.build !== undefined);
  if (dir === undefined) return null;
  return found(inDir(repoDir, dir, scriptCommand(packageManager, 'build')), `"build" script in ${relPath(repoDir, path.join(dir, 'package.json'))}`);
}

/** What the build writes, relative to the repo: .next for Next.js, else tsconfig's outDir, else an existing dist/ or build/. */
function buildOutputs(repoDir: string, appDir: string): Finding<string[]> {
  const rel = (dir: string) => relPath(repoDir, path.join(appDir, dir));
  if (isNextApp(appDir)) return found([rel('.next')], 'next dependency');
  const tsconfig = path.join(appDir, 'tsconfig.json');
  const outDir = /"outDir"\s*:\s*"([^"]+)"/.exec(readText(tsconfig) ?? '')?.[1];
  if (outDir !== undefined) return found([rel(outDir.replace(/^\.\//, ''))], `outDir in ${relPath(repoDir, tsconfig)}`);
  const existing = ['dist', 'build'].find((dir) => isDir(path.join(appDir, dir)));
  if (existing !== undefined) return found([rel(existing)], `existing ${rel(existing)}/ directory`);
  return guess([rel('dist')], 'no Next.js dependency, tsconfig outDir, dist/ or build/');
}

/** The build step, or null if the webServer command has no build step and there is no build script. */
export function detectBuild(repoDir: string, appDir: string, packageManager: PackageManager, split: Finding<string> | null): BuildFinding | null {
  const command = buildCommand(repoDir, appDir, packageManager, split);
  return command === null ? null : { command, outputs: buildOutputs(repoDir, appDir) };
}
