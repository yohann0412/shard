import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runSteps } from './checkout.js';
import type { ImpactMap } from './impact-map.js';
import { countMarkers } from './liveness.js';
import { makeMutant, type Mutant, type MutantKind, type NoMutant } from './mutants.js';
import { assertClean, nonJsEdits, referenceRuns, runMutant, type LoopContext, type MutantRecord, type NonJsEdit, type Reference } from './mutation-runs.js';
import { mulberry32 } from './prng.js';
import { say } from './provenance.js';
import { drawSample, sourceFiles, stratify, type Stratum, type Target } from './targets.js';

/** How to sample and mutate. */
export interface StudyOptions {
  seed: number;
  kinds: MutantKind[];
  maxTargets: number | null;
}

/** Everything the mutation study observed, before scoring. */
export interface Study {
  reference: Reference;
  sourceFiles: number;
  byStratum: Record<Stratum, number>;
  sample: Target[];
  noMutant: NoMutant[];
  mutants: MutantRecord[];
  nonJsEdits: NonJsEdit[];
}

/** Number of files in each stratum. */
function countStrata(targets: Target[]): Record<Stratum, number> {
  const counts: Record<Stratum, number> = { inTests: 0, bootLoadedOnly: 0, global: 0, absent: 0 };
  for (const target of targets) counts[target.stratum]++;
  return counts;
}

/** A mutant's outcome for the progress line. */
function outcomeLine(record: MutantRecord): string {
  if (record.failing !== null) return `live, ${record.failing.length} failing`;
  if (!record.live) return `not live${record.buildError ? ` (${record.buildError})` : ''}, suite not run`;
  return `live, no results (${record.run?.error ?? `exit code ${record.run?.exitCode}`})`;
}

/**
 * The mutation part of Experiment B (PLAN §5, B.2-B.4): two unmutated reference runs, a seeded stratified sample of
 * source files, every requested mutant of each, one suite run per live mutant, and the non-JS edits. The checkout
 * must be clean and built; it is rebuilt clean at the end.
 */
export async function mutationStudy(context: LoopContext, map: ImpactMap, options: StudyOptions): Promise<Study> {
  await assertClean(context);
  say(`reference runs at ${context.workers} workers`);
  const reference = await referenceRuns(context);

  const random = mulberry32(options.seed);
  const targets = stratify(await sourceFiles(context.checkout.appDir, context.recipe.sourceDirs, map), map);
  const sample = drawSample(targets, random, options.maxTargets);
  const planned: { target: Target; mutant: Mutant }[] = [];
  const noMutant: NoMutant[] = [];
  for (const target of sample) {
    const source = readFileSync(path.join(context.checkout.appDir, target.file), 'utf8');
    for (const kind of options.kinds) {
      const made = makeMutant(target.file, source, kind);
      if ('skipped' in made) noMutant.push(made);
      else planned.push({ target, mutant: made });
    }
  }

  const markers = [...new Set(planned.map(({ mutant }) => mutant.marker))];
  const cleanCounts = countMarkers(context.checkout.appDir, context.recipe.servedOutput, markers);
  const mutants: MutantRecord[] = [];
  for (const [index, { target, mutant }] of planned.entries()) {
    const id = `m${String(index + 1).padStart(2, '0')}-${mutant.kind}`;
    say(`${id} (${index + 1}/${planned.length}): ${mutant.file} [${target.stratum}], ${mutant.description}`);
    const record = await runMutant(context, id, target, mutant, cleanCounts[mutant.marker]!);
    mutants.push(record);
    say(`${id}: ${outcomeLine(record)}`);
  }

  const edits = await nonJsEdits(context, random);
  await runSteps(context.recipe.build, context.checkout.root, context.recipe, path.join(context.outDir, 'final-build.log'), 'clean rebuild');
  return { reference, sourceFiles: targets.length, byStratum: countStrata(targets), sample, noMutant, mutants, nonJsEdits: edits };
}
