import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isolatePaths } from '../../src/paths.js';
import { aggregateA } from './aggregate-a.js';
import { isTimed, planArms, rotation, type Arm, type ArmRun, type Round } from './arms.js';
import { browsersFor } from './browsers.js';
import { prepareCheckout } from './checkout.js';
import { machineFacts, waitForLowLoad } from './machine.js';
import { harnessRoot, resultPaths } from './paths.js';
import { waitForFreePorts } from './ports.js';
import { provenance, say } from './provenance.js';
import { armEnv, loadRecipe } from './recipe.js';
import { round } from './stats.js';
import { runSuite, type Invocation } from './suite-run.js';

const USAGE = `Usage: node dist/scripts/experiments/experiment-a.js <recipe> [--rounds R] [--oversubscribe] [--load-wait SECONDS]

  --rounds R         timed rounds (default: the recipe's rounds, else 3); a round is added (up to 5) while an arm's
                     max/min test phase is above 1.10
  --oversubscribe    also run isolated@N for N > cores, labelled oversubscribed (the fixture only)
  --load-wait S      before each timed run, wait up to S seconds for the 1-min load average to drop below 1.0 (default 180)
`;

const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 5;
const SPREAD_LIMIT = 1.1;
const PORT_WAIT_MS = 15 * 60_000;

/** Parses an integer flag value of at least `min`. */
function integerFlag(flag: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${flag} needs an integer >= ${min} (got ${value})`);
  return parsed;
}

/** Arms whose timed test phases so far vary by more than 10% (max/min). */
function unstableArms(arms: Arm[], runs: ArmRun[]): string[] {
  return arms
    .filter((arm) => {
      const phases = runs.filter((run) => run.arm === arm.name && isTimed(run)).flatMap((run) => (run.report?.playwright ? [run.report.playwright.testPhaseMs] : []));
      return phases.length > 1 && Math.max(...phases) / Math.min(...phases) > SPREAD_LIMIT;
    })
    .map((arm) => arm.name);
}

/** Runs Experiment A on one recipe and writes data/results/<name>/experiment-a.json; returns the exit code. */
async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { rounds: { type: 'string' }, oversubscribe: { type: 'boolean', default: false }, 'load-wait': { type: 'string', default: '180' } },
  });
  const name = positionals[0];
  if (name === undefined || positionals.length > 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const recipe = loadRecipe(name);
  const rounds = values.rounds === undefined ? (recipe.rounds ?? DEFAULT_ROUNDS) : integerFlag('--rounds', values.rounds, 1);
  const loadWaitMs = integerFlag('--load-wait', values['load-wait'], 0) * 1000;
  const out = resultPaths(name);
  const origin = await provenance();
  rmSync(out.runs, { recursive: true, force: true });
  mkdirSync(out.runs, { recursive: true });

  say(`${name}: preparing a fresh checkout (untimed)`);
  const checkout = await prepareCheckout(recipe, path.join(out.runs, 'checkout.log'));
  const browsers = browsersFor(checkout.appDir);
  const machine = machineFacts(checkout.appDir);
  const invocation: Invocation = {
    cwd: checkout.appDir,
    env: armEnv(recipe, browsers.path),
  };
  const { arms, skipped } = planArms(machine.cores, values.oversubscribe, recipe.playwrightArgs);
  for (const arm of skipped) say(`skipping ${arm.name}: ${arm.reason}`);

  const runs: ArmRun[] = [];
  const runArm = async (arm: Arm, round: Round) => {
    const loadWait = round === 'warmup' ? null : await waitForLowLoad(loadWaitMs);
    const portWait = arm.kind === 'baseline' && recipe.baselinePorts.length > 0 ? await waitForFreePorts(recipe.baselinePorts, PORT_WAIT_MS) : null;
    const loaded = await runSuite(`${arm.name}-${round}`, arm.args, invocation, out.runs);
    runs.push({ arm: arm.name, round, loadWait, portWait, ...loaded });
    const phase = loaded.report?.playwright?.testPhaseMs;
    const waits = [loadWait && loadWait.waitedMs > 0 ? `waited ${Math.round(loadWait.waitedMs / 1000)} s for load` : '', portWait && portWait.waitedMs > 1000 ? `waited ${Math.round(portWait.waitedMs / 1000)} s for ports` : '']
      .filter(Boolean)
      .join(', ');
    say(`${arm.name} ${round}: exit ${loaded.run.exitCode}, test phase ${phase === undefined ? `n/a (${loaded.run.error ?? 'no results'})` : `${(phase / 1000).toFixed(1)} s`}, load ${loaded.run.loadAvg1AtStart}${waits ? ` (${waits})` : ''}`);
  };

  say('cold run: isolated@1 on a fresh .isolate/');
  rmSync(isolatePaths(checkout.appDir).root, { recursive: true, force: true });
  await runArm(arms.find((arm) => arm.name === 'isolated@1')!, 'cold');
  for (const arm of arms) await runArm(arm, 'warmup');
  const extraRounds: { round: number; unstable: string[] }[] = [];
  let done = 0;
  while (done < rounds || (done < MAX_ROUNDS && unstableArms(arms, runs).length > 0)) {
    done++;
    if (done > rounds) extraRounds.push({ round: done, unstable: unstableArms(arms, runs) });
    for (const arm of rotation(arms, done)) await runArm(arm, done);
  }

  machine.postgres = runs.find((run) => run.report !== null)?.report?.machine.postgres ?? null;
  const reduced = recipe.protocol === 'reduced' || done < DEFAULT_ROUNDS;
  const result = {
    version: 1,
    experiment: 'A',
    name,
    ...origin,
    protocol: {
      label: reduced ? 'reduced' : 'full',
      recipeProtocol: recipe.protocol,
      subsetNote: recipe.subsetNote,
      roundsPlanned: rounds,
      roundsRun: done,
      extraRounds,
      loadWaitS: loadWaitMs / 1000,
      oversubscribe: values.oversubscribe,
    },
    recipe,
    checkout: { root: path.relative(harnessRoot, checkout.root), appDir: path.relative(harnessRoot, checkout.appDir), commit: checkout.commit },
    browsers,
    machine,
    arms,
    skippedArms: skipped,
    runs: runs.map(({ arm, round: runRound, loadWait, portWait, run }) => ({ arm, round: runRound, loadWait, portWait, ...run })),
    aggregate: aggregateA(arms, runs, machine.cores),
  };
  writeFileSync(out.experimentA, `${JSON.stringify(result, null, 2)}\n`);
  const verdict = result.aggregate.speedups.verdict.value;
  say(`wrote ${path.relative(harnessRoot, out.experimentA)}: ${runs.length} runs; ${result.aggregate.speedups.verdict.metric} = ${verdict === null ? 'n/a' : round(verdict, 2)}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
