import type { AffectedCall, Policy } from './affected.js';
import { clopperPearson } from './clopper-pearson.js';
import type { ImpactMap } from './impact-map.js';
import type { MutantRecord, Reference } from './mutation-runs.js';
import { median, round } from './stats.js';

/** One mutant scored under one global policy. */
export interface PolicyScore {
  policy: Policy;
  /** Why `affected` gave no answer, if it did not. */
  error: string | null;
  /** `affected` answered `all` (flagged, and left out of the headline). */
  all: boolean;
  /** |P|, counting only tests the reference runs saw. */
  selected: number;
  countRatio: number | null;
  timeRatio: number | null;
  /** |F ∩ P| / |F|, or null when F is empty or unknown. */
  recall: number | null;
  /** F \ P. */
  misses: string[];
}

/** A mutant's F and its scores under both policies. */
export interface MutantScore {
  /** Failing tests minus the reference failures; null when the mutant was not live or its run wrote no results. */
  F: string[] | null;
  /** For an empty F: was the mutated function (or, for a top-level edit, the module) ever executed in the map? */
  emptyF: 'never-executed' | 'executed-no-failure' | null;
  policies: PolicyScore[];
}

/** True if the map recorded the mutated function (or any function of the file, for a module-scope edit) as executed. */
function executed(record: MutantRecord, map: ImpactMap): boolean {
  const names = map.executedFunctions[record.file];
  if (names === undefined) return false;
  return record.functionName === '' || names.includes(record.functionName);
}

/** Recall, misses and selection ratios of one `affected` answer against F. */
function scorePolicy(F: string[] | null, call: AffectedCall, reference: Reference): PolicyScore {
  if (call.result === null) return { policy: call.policy, error: call.error, all: false, selected: 0, countRatio: null, timeRatio: null, recall: null, misses: [] };
  const P = new Set(call.result.all ? reference.allTests : call.result.tests);
  const selected = reference.allTests.filter((id) => P.has(id));
  const totalMs = reference.allTests.reduce((sum, id) => sum + (reference.durations[id] ?? 0), 0);
  const selectedMs = selected.reduce((sum, id) => sum + (reference.durations[id] ?? 0), 0);
  const failing = F ?? [];
  return {
    policy: call.policy,
    error: null,
    all: call.result.all,
    selected: selected.length,
    countRatio: reference.allTests.length === 0 ? null : round(selected.length / reference.allTests.length),
    timeRatio: totalMs === 0 ? null : round(selectedMs / totalMs),
    recall: failing.length === 0 ? null : round(failing.filter((id) => P.has(id)).length / failing.length),
    misses: failing.filter((id) => !P.has(id)),
  };
}

/** Scores one mutant (PLAN §5, B.5): F is its failing tests minus every test that failed in a reference run. */
export function scoreMutant(record: MutantRecord, reference: Reference, map: ImpactMap): MutantScore {
  const excluded = new Set(reference.excluded);
  const F = record.live && record.failing !== null ? record.failing.filter((id) => !excluded.has(id)) : null;
  const emptyF = F === null || F.length > 0 ? null : executed(record, map) ? 'executed-no-failure' : 'never-executed';
  return { F, emptyF, policies: record.affected.map((call) => scorePolicy(F, call, reference)) };
}

/** A mutant with its score. */
export interface Scored {
  record: MutantRecord;
  score: MutantScore;
}

/** The score of one policy, if `affected` ran for it. */
function under(entry: Scored, policy: Policy): PolicyScore | undefined {
  return entry.score.policies.find((score) => score.policy === policy);
}

/** Why a mutant is not in the headline under a policy, or null if it is. */
function leftOutBecause(entry: Scored, policy: Policy): string | null {
  const score = under(entry, policy);
  if (!entry.record.live) return 'not live';
  if (entry.score.F === null) return 'run wrote no results';
  if (entry.record.stratum === 'global') return 'global file';
  if (score === undefined || score.error !== null) return 'affected failed';
  if (score.all) return 'affected answered all';
  if (entry.score.F.length === 0) return entry.score.emptyF!;
  return null;
}

/**
 * The headline (PLAN §1, Claim B): among live, non-global mutants with a non-empty F and a selection other than `all`,
 * the fraction with zero misses, with n and a 95% Clopper-Pearson interval; plus why every other mutant is left out.
 */
export function headline(scored: Scored[], policy: Policy) {
  const counted = scored.filter((entry) => leftOutBecause(entry, policy) === null);
  const zeroMisses = counted.filter((entry) => under(entry, policy)!.misses.length === 0).length;
  const leftOut: Record<string, number> = {};
  for (const entry of scored) {
    const reason = leftOutBecause(entry, policy);
    if (reason !== null) leftOut[reason] = (leftOut[reason] ?? 0) + 1;
  }
  const interval = clopperPearson(zeroMisses, counted.length);
  return {
    policy,
    n: counted.length,
    zeroMisses,
    fraction: counted.length === 0 ? null : round(zeroMisses / counted.length),
    ci95: interval === null ? null : { lower: round(interval.lower), upper: round(interval.upper) },
    leftOut,
  };
}

/** Median and worst of a sample, or nulls. */
function medianAndWorst(values: number[]): { n: number; median: number | null; worst: number | null } {
  return { n: values.length, median: values.length === 0 ? null : round(median(values)), worst: values.length === 0 ? null : Math.min(...values) };
}

/** Recall over the headline's mutants, overall and per stratum. */
export function recallSummary(scored: Scored[], policy: Policy) {
  const counted = scored.filter((entry) => leftOutBecause(entry, policy) === null);
  const recalls = (entries: Scored[]) => entries.map((entry) => under(entry, policy)!.recall!);
  const strata = [...new Set(counted.map((entry) => entry.record.stratum))];
  return {
    policy,
    ...medianAndWorst(recalls(counted)),
    byStratum: Object.fromEntries(strata.map((stratum) => [stratum, medianAndWorst(recalls(counted.filter((entry) => entry.record.stratum === stratum)))])),
  };
}

/**
 * Selection ratios per mutated file (P depends only on the changed file): medians over the non-control files, where
 * `all` counts as 1. Controls are left out because an absent file selects nothing by construction.
 */
export function selectionSummary(scored: Scored[], policy: Policy) {
  const byFile = new Map<string, PolicyScore>();
  for (const entry of scored) {
    const score = under(entry, policy);
    if (entry.record.stratum !== 'absent' && score !== undefined && score.error === null && !byFile.has(entry.record.file)) byFile.set(entry.record.file, score);
  }
  const scores = [...byFile.values()];
  const medianOf = (values: (number | null)[]) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0 ? null : round(median(present));
  };
  return { policy, files: scores.length, medianCountRatio: medianOf(scores.map((score) => score.countRatio)), medianTimeRatio: medianOf(scores.map((score) => score.timeRatio)) };
}

/** Live controls (absent files) whose mutant made tests fail: misses of a different kind (PLAN §5, B.5). */
export function controlMisses(scored: Scored[]) {
  const controls = scored.filter((entry) => entry.record.stratum === 'absent' && entry.score.F !== null);
  const failing = controls.filter((entry) => entry.score.F!.length > 0);
  return { liveControls: controls.length, withFailures: failing.length, mutants: failing.map((entry) => ({ id: entry.record.id, file: entry.record.file, F: entry.score.F })) };
}
