import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessRoot, resultPaths, resultsRoot } from './paths.js';
import { say } from './provenance.js';

/** A spread as experiment-a.json stores it. */
interface Spread {
  median: number;
}

/** The parts of experiment-a.json the summary reads. */
interface ExperimentA {
  protocol: { label: string };
  skippedArms: { name: string }[];
  aggregate: {
    perArm: { arm: string; testPhaseMs: Spread | null; excluded: unknown[]; startedAtLoadAboveOne: number; concurrency: { resolvedWorkers: number[] } }[];
    speedups: { verdict: { value: number | null }; harnessEffect: { value: number | null; flagged: boolean } };
    setupFraction: { isolated1: { setupShareOfTestTime: number | null } | null };
    failures: { tests: { isolationFailure: boolean }[] };
    bestWorkers: number | null;
  };
}

/** The headline under one policy, as experiment-b.json stores it. */
interface Headline {
  n: number;
  zeroMisses: number;
  fraction: number | null;
  ci95: { lower: number; upper: number } | null;
}

/** The parts of experiment-b.json the summary reads. */
interface ExperimentB {
  summary: {
    headline: { default: Headline; strict: Headline };
    recall: { default: { median: number | null; worst: number | null } };
    selection: { default: { medianCountRatio: number | null; medianTimeRatio: number | null } };
    controlMisses: { liveControls: number; withFailures: number };
    stability: { perFile: { median: number | null; min: number | null } };
  };
}

/** A number with fixed decimals, or n/a. */
function fixed(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

/** Milliseconds as seconds with one decimal, or n/a. */
function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`;
}

/** A Markdown table from a header row and body rows. */
function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

/** Reads a results file if it exists. */
function readIfPresent<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/** One row of the Experiment A table. */
function rowA(name: string, a: ExperimentA): string[] {
  const arm = (armName: string) => a.aggregate.perArm.find((entry) => entry.arm === armName);
  const configured = arm('baseline@configured');
  const best = a.aggregate.bestWorkers;
  const effect = a.aggregate.speedups.harnessEffect;
  const excluded = a.aggregate.perArm.reduce((sum, entry) => sum + entry.excluded.length, 0);
  const loaded = a.aggregate.perArm.reduce((sum, entry) => sum + entry.startedAtLoadAboveOne, 0);
  const notes = [
    `${a.protocol.label} protocol`,
    `${excluded} timed run(s) excluded`,
    `${loaded} started at load ≥ 1.0`,
    ...(effect.flagged ? ['harness effect outside 0.85-1.15: do not quote vs-baseline speedups'] : []),
    ...(a.skippedArms.length > 0 ? [`skipped ${a.skippedArms.map((skipped) => skipped.name).join(', ')}`] : []),
  ];
  const setup = a.aggregate.setupFraction.isolated1?.setupShareOfTestTime;
  return [
    name,
    seconds(configured?.testPhaseMs?.median),
    configured?.concurrency.resolvedWorkers.join(', ') || 'n/a',
    best === null ? 'n/a' : `${seconds(arm(`isolated@${best}`)?.testPhaseMs?.median)} (N=${best})`,
    a.aggregate.speedups.verdict.value === null ? 'n/a' : `${fixed(a.aggregate.speedups.verdict.value)}×`,
    String(a.aggregate.failures.tests.filter((test) => test.isolationFailure).length),
    setup === null || setup === undefined ? 'n/a' : `${Math.round(setup * 100)}%`,
    fixed(effect.value),
    notes.join('; '),
  ];
}

/** A headline as "fraction (x/n) [lower, upper]". */
function headlineCell(headline: Headline): string {
  if (headline.n === 0) return 'n/a (n = 0)';
  return `${fixed(headline.fraction)} (${headline.zeroMisses}/${headline.n}) [${fixed(headline.ci95?.lower)}, ${fixed(headline.ci95?.upper)}]`;
}

/** One row of the Experiment B table. */
function rowB(name: string, b: ExperimentB): string[] {
  const { summary } = b;
  return [
    name,
    fixed(summary.recall.default.median),
    fixed(summary.recall.default.worst),
    `${headlineCell(summary.headline.default)}; strict: ${headlineCell(summary.headline.strict)}`,
    `${fixed(summary.selection.default.medianCountRatio)} / ${fixed(summary.selection.default.medianTimeRatio)}`,
    `${summary.controlMisses.withFailures} of ${summary.controlMisses.liveControls} live`,
    `${fixed(summary.stability.perFile.median)} (min ${fixed(summary.stability.perFile.min)})`,
  ];
}

/** Writes data/results/summary.md: one table per experiment, one row per repo with results. */
function main(): number {
  const names = existsSync(resultsRoot)
    ? readdirSync(resultsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const rowsA = names.flatMap((name) => {
    const a = readIfPresent<ExperimentA>(resultPaths(name).experimentA);
    return a === null ? [] : [rowA(name, a)];
  });
  const rowsB = names.flatMap((name) => {
    const b = readIfPresent<ExperimentB>(resultPaths(name).experimentB);
    return b === null ? [] : [rowB(name, b)];
  });
  if (rowsA.length + rowsB.length === 0) throw new Error(`no ${path.relative(harnessRoot, resultsRoot)}/*/experiment-*.json to summarize`);
  const markdown = `# Experiment results

Generated by \`just report\` from \`data/results/*/experiment-*.json\`; do not edit by hand. Times are medians over valid
timed runs; each repo's JSON has the definitions, the raw runs and every excluded run with its reason.

## Experiment A: isolation

${rowsA.length === 0 ? 'No results yet.' : table(['repo', 'baseline test phase (configured)', 'baseline workers', 'isolated test phase at best N', 'speedup at N=4 (isolated@1 / isolated@4)', 'new failures (isolation)', 'setup fraction (isolated@1)', 'harness effect (baseline@1 / isolated@1)', 'validity notes'], rowsA)}

## Experiment B: impact map

${rowsB.length === 0 ? 'No results yet.' : table(['repo', 'median recall', 'worst recall', 'headline: zero-miss fraction (x/n) [95% CI]', 'median selection ratio count / time-weighted', 'control misses', 'map stability: per-file Jaccard median'], rowsB)}
`;
  const file = path.join(resultsRoot, 'summary.md');
  writeFileSync(file, markdown);
  say(`wrote ${path.relative(harnessRoot, file)} (${rowsA.length} repo(s) in A, ${rowsB.length} in B)`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  say(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
