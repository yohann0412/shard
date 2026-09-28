import path from 'node:path';

/** Root of the harness repository (this file compiles to dist/scripts/experiments/). */
export const harnessRoot = path.resolve(import.meta.dirname, '..', '..', '..');

/** The compiled isolate CLI every experiment runs. */
export const cliPath = path.join(harnessRoot, 'dist', 'src', 'cli.js');

/** Where recipes live: experiments/recipes/<name>.json. */
export const recipesDir = path.join(harnessRoot, 'experiments', 'recipes');

/** Scratch space for checkouts and browser shims (gitignored). */
export const workDir = path.join(harnessRoot, 'work');

/** Where checkouts go: work/repos/<name>. */
export const reposDir = path.join(workDir, 'repos');

/** Root of every experiment's committed output. */
export const resultsRoot = path.join(harnessRoot, 'data', 'results');

/** Every path one repo's results use under data/results/<name>/. */
export function resultPaths(name: string) {
  const dir = path.join(resultsRoot, name);
  return {
    dir,
    /** Experiment A's raw runs: <arm>-<round>.json (report), .pw-results.json, .log. */
    runs: path.join(dir, 'runs'),
    /** Experiment B's raw runs: traces, reference runs and one set of files per mutant. */
    mutants: path.join(dir, 'mutants'),
    experimentA: path.join(dir, 'experiment-a.json'),
    experimentB: path.join(dir, 'experiment-b.json'),
    map: (workers: number) => path.join(dir, `map-w${workers}.json`),
  };
}
