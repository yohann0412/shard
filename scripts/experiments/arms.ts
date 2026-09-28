import type { LoadWait } from './machine.js';
import type { PortWait } from './ports.js';
import type { LoadedRun } from './suite-run.js';

/** Worker counts of the isolated arms (PLAN §5). */
const WORKER_COUNTS = [1, 2, 4, 8];

/** One arm of Experiment A: a way of running the suite. */
export interface Arm {
  /** `baseline@configured`, `baseline@1` or `isolated@N`. */
  name: string;
  kind: 'baseline' | 'isolated';
  /** Workers asked for; null for baseline@configured, which keeps the repo's own. */
  workers: number | null;
  /** More workers than cores (run only with --oversubscribe). */
  oversubscribed: boolean;
  /** Arguments of the isolate CLI. */
  args: string[];
}

/** An arm that was not run, and why. */
export interface SkippedArm {
  name: string;
  reason: string;
}

/** `cold`: the one run before everything on a fresh .isolate/. `warmup`: discarded. A number: a timed round. */
export type Round = 'cold' | 'warmup' | number;

/** One run of one arm, with what the harness waited for before it. */
export interface ArmRun extends LoadedRun {
  arm: string;
  round: Round;
  loadWait: LoadWait | null;
  portWait: PortWait | null;
}

/**
 * The arms for a machine with `cores` cores: baseline@configured and baseline@1 through `isolate run --baseline`, and
 * isolated@N for N in 1, 2, 4, 8. N > cores is skipped (and recorded), or run and labelled with --oversubscribe.
 */
export function planArms(cores: number, oversubscribe: boolean, playwrightArgs: string[]): { arms: Arm[]; skipped: SkippedArm[] } {
  const playwright = ['npx', 'playwright', 'test', '--retries=0', ...playwrightArgs];
  const arms: Arm[] = [
    { name: 'baseline@configured', kind: 'baseline', workers: null, oversubscribed: false, args: ['run', '--baseline', '--', ...playwright] },
    { name: 'baseline@1', kind: 'baseline', workers: 1, oversubscribed: false, args: ['run', '--baseline', '--', ...playwright, '--workers=1'] },
  ];
  const skipped: SkippedArm[] = [];
  for (const workers of WORKER_COUNTS) {
    const name = `isolated@${workers}`;
    if (workers > cores && !oversubscribe) {
      skipped.push({ name, reason: `${workers} workers > ${cores} cores (pass --oversubscribe to run it)` });
      continue;
    }
    arms.push({ name, kind: 'isolated', workers, oversubscribed: workers > cores, args: ['run', '--workers', String(workers), '--', ...playwright] });
  }
  return { arms, skipped };
}

/** The arms in the order of round `round` (1-based): rotated left by round - 1. */
export function rotation(arms: Arm[], round: number): Arm[] {
  const shift = (round - 1) % arms.length;
  return [...arms.slice(shift), ...arms.slice(0, shift)];
}

/** True for a run of one of the timed rounds (not the cold run, not a warm-up). */
export function isTimed(run: ArmRun): boolean {
  return typeof run.round === 'number';
}
