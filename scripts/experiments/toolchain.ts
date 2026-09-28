import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { say } from './provenance.js';
import { toolchainDir, type Recipe } from './recipe.js';

/** Marker written once every package of a toolchain installed. */
const READY = '.ready';

/**
 * Installs a recipe's toolchain (e.g. node@24, pnpm@12.3.4) with npm into work/toolchain/<key> unless it is already
 * there; recipeEnv puts its node_modules/.bin first on PATH.
 */
export async function ensureToolchain(recipe: Recipe): Promise<void> {
  const dir = toolchainDir(recipe);
  if (dir === null || existsSync(path.join(dir, READY))) return;
  const packages = Object.entries(recipe.toolchain).map(([name, version]) => `${name}@${version}`);
  say(`installing ${packages.join(', ')} into ${path.relative(process.cwd(), dir)} (once)`);
  mkdirSync(dir, { recursive: true });
  await execa('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--no-save', ...packages], { stdio: 'inherit' });
  writeFileSync(path.join(dir, READY), `${packages.join('\n')}\n`);
}
