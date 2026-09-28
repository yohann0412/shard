import path from 'node:path';
import { readPackageJson, relPath } from '../files.js';
import { found } from '../finding.js';
import { filesInCommand, inDir } from '../scripts.js';
import { scriptStep, type DbStep, type StepContext } from './migrate.js';
import type { PrismaSchema } from './prisma.js';

const SEED_SCRIPTS = ['seed', 'db:seed'];

/** The seed command: Prisma's configured seed, else a `seed` or `db:seed` script of the app or the repo. Null if none. */
export function detectSeed(ctx: StepContext, prisma: PrismaSchema | null): DbStep | null {
  if (prisma?.seed) {
    const command = found(inDir(ctx.repoDir, prisma.packageDir, 'npx prisma db seed'), `Prisma seed \`${prisma.seed}\``);
    return { command, inputs: filesInCommand(prisma.packageDir, prisma.seed) };
  }
  for (const dir of new Set([ctx.appDir, ctx.repoDir])) {
    const script = SEED_SCRIPTS.find((name) => readPackageJson(dir)?.scripts?.[name] !== undefined);
    if (script !== undefined) return scriptStep(ctx, dir, script, `"${script}" script in ${relPath(ctx.repoDir, path.join(dir, 'package.json'))}`);
  }
  return null;
}
