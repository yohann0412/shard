import { git } from './checkout.js';
import { harnessRoot } from './paths.js';

/** Where a result came from: when, which harness revision, and the exact harness command. */
export interface Provenance {
  createdAt: string;
  harnessCommit: string;
  /** True if the harness had uncommitted changes when it ran. */
  harnessDirty: boolean;
  command: string[];
}

/** Describes this harness invocation for the top of a results file. */
export async function provenance(): Promise<Provenance> {
  return {
    createdAt: new Date().toISOString(),
    harnessCommit: await git(harnessRoot, ['rev-parse', 'HEAD']),
    harnessDirty: (await git(harnessRoot, ['status', '--porcelain'])) !== '',
    command: ['node', ...process.argv.slice(1)],
  };
}

/** Prints one progress line of the harness to stderr. */
export function say(message: string): void {
  process.stderr.write(`[harness] ${message}\n`);
}
