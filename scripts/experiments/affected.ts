import { execa } from 'execa';
import { z } from 'zod';
import { cliPath } from './paths.js';
import type { Invocation } from './suite-run.js';

/** `isolate affected --json` output (F7's documented interface). */
const affectedSchema = z.object({ all: z.boolean(), reason: z.string().nullable(), tests: z.array(z.string()), changed: z.array(z.string()) });

/** The tests `affected` selects for the current edit, or `all`. */
export type Affected = z.infer<typeof affectedSchema>;

/** `default`: function-level global (D-011). `strict`: boot-loaded files also select everything. */
export type Policy = 'default' | 'strict';

/** One `affected` call: its selection, or why there is none. */
export interface AffectedCall {
  policy: Policy;
  argv: string[];
  result: Affected | null;
  error: string | null;
}

/** Runs `isolate affected --base HEAD --json` (plus `--strict` for the strict policy) in the checkout. */
export async function runAffected(invocation: Invocation, policy: Policy): Promise<AffectedCall> {
  const args = ['affected', '--base', 'HEAD', ...(policy === 'strict' ? ['--strict'] : []), '--json'];
  const argv = ['node', 'dist/src/cli.js', ...args];
  const run = await execa(process.execPath, [cliPath, ...args], { cwd: invocation.cwd, env: invocation.env, reject: false });
  if (run.exitCode !== 0) return { policy, argv, result: null, error: `exit code ${run.exitCode}: ${run.stderr.trim().split('\n').slice(-3).join(' | ')}` };
  let output: unknown;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    return { policy, argv, result: null, error: `output is not JSON: ${run.stdout.slice(0, 200)}` };
  }
  const parsed = affectedSchema.safeParse(output);
  return parsed.success ? { policy, argv, result: parsed.data, error: null } : { policy, argv, result: null, error: `unexpected output: ${z.prettifyError(parsed.error)}` };
}
