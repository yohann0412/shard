import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { jaccard, median, round } from './stats.js';

/** A file selected by at least this share of tests in both maps is left out of the per-file stability (PLAN §5, B.1). */
const COMMON_FILE_SHARE = 0.5;

/** The parts of `.isolate/map.json` (written by `isolate trace`) that Experiment B reads. */
const impactMapSchema = z.looseObject({
  version: z.literal(1),
  workers: z.number(),
  global: z.array(z.string()),
  bootLoaded: z.array(z.string()),
  tests: z.record(z.string(), z.looseObject({ title: z.string(), file: z.string(), server: z.array(z.string()), client: z.array(z.string()) })),
  executedFunctions: z.record(z.string(), z.array(z.string())),
});

/** An impact map: per test, the server and client files it executed, plus the boot-time sets. */
export type ImpactMap = z.infer<typeof impactMapSchema>;

/** Stability of the map across two builds at different N. */
export interface Stability {
  perFile: { files: number; median: number | null; min: number | null; leftOutAsCommon: number };
  perTest: { tests: number; median: number | null; min: number | null; inOneMapOnly: number };
}

/** Reads and validates a map.json. */
export function readImpactMap(file: string): ImpactMap {
  return impactMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** The files one test executed, server and client. */
function filesOf(map: ImpactMap, testId: string): Set<string> {
  const entry = map.tests[testId];
  return new Set(entry === undefined ? [] : [...entry.server, ...entry.client]);
}

/** For every file, the tests that executed it. */
export function testsByFile(map: ImpactMap): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const testId of Object.keys(map.tests)) {
    for (const file of filesOf(map, testId)) byFile.set(file, (byFile.get(file) ?? new Set()).add(testId));
  }
  return byFile;
}

/** Median and min of a sample rounded, or nulls for an empty one. */
function summary(values: number[]): { median: number | null; min: number | null } {
  return values.length === 0 ? { median: null, min: null } : { median: round(median(values)), min: round(Math.min(...values)) };
}

/**
 * Per file, the Jaccard of the sets of tests that selected it in map `a` and in map `b`, over files selected by fewer
 * than 50% of the tests in at least one of the two maps; per test, the Jaccard of its file sets (for comparison).
 */
export function mapStability(a: ImpactMap, b: ImpactMap): Stability {
  const byFileA = testsByFile(a);
  const byFileB = testsByFile(b);
  const testsA = Object.keys(a.tests).length;
  const testsB = Object.keys(b.tests).length;
  const files = [...new Set([...byFileA.keys(), ...byFileB.keys()])];
  const common = (file: string) =>
    (byFileA.get(file)?.size ?? 0) >= COMMON_FILE_SHARE * testsA && (byFileB.get(file)?.size ?? 0) >= COMMON_FILE_SHARE * testsB;
  const kept = files.filter((file) => !common(file));
  const perFile = kept.map((file) => jaccard(byFileA.get(file) ?? new Set(), byFileB.get(file) ?? new Set())!);

  const ids = new Set([...Object.keys(a.tests), ...Object.keys(b.tests)]);
  const inBoth = [...ids].filter((id) => id in a.tests && id in b.tests);
  const perTest = inBoth.flatMap((id) => {
    const value = jaccard(filesOf(a, id), filesOf(b, id));
    return value === null ? [] : [value];
  });
  return {
    perFile: { files: kept.length, ...summary(perFile), leftOutAsCommon: files.length - kept.length },
    perTest: { tests: perTest.length, ...summary(perTest), inOneMapOnly: ids.size - inBoth.length },
  };
}
