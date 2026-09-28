# Review: experiment harness (`scripts/experiments/`)

Subagent report: 29 small modules; Experiment A shakedown on the fixture (1 round) and a separate `--oversubscribe` run; Experiment B exercised without a real map (trace was not in its tree) plus hand-checked statistics (Clopper-Pearson against reference values); `just report` and `just demo` green. Lead integrated it (5ca24fb), read the arms, validity, scoring and mutation loop, and made two changes (below).

## What could be wrong

- **The shakedown numbers are not results.** Load average 2-7 from other agents throughout; every timed run waited the full 3-minute load gate and still started above 1.0. The real runs happen with no subagent active.
- **One bad baseline round poisons the reference.** In the oversubscribed shakedown, baseline@1's single timed round hit a test timeout at load ~7, so the reference outcome was "failed" and every other run was marked invalid. With ≥ 3 rounds the most-frequent-outcome reference absorbs one bad round; with 1 round it cannot. Real runs use 3 rounds.
- **"Re-time on the common passing subset" (PLAN §5 step 5) is not implemented.** Runs whose outcomes differ from the reference are excluded rather than re-timed. If a repo has tests that pass at baseline but fail under isolation in every round, all isolated runs are excluded and the repo gets no speedup. That is honest (no number) but loses information; RESULTS.md must say it for any such repo, and give the per-test comparison instead.
- **A mutant that breaks app startup produced "no results"**, which would have been scored as unscorable. Lead changed it: `isolate` stopping with "w<i> exited before it was ready" or "was not ready within" now counts as every test failing (`bootFailure: true`), which is what such a change does to a real suite.
- **Mutant runs paid for reruns.** `isolate run` reran every failed test twice on fresh apps; for mutants that is pure cost. Lead added `isolate run --no-rerun`, and mutant and reference runs use it. Experiment A arms still rerun (the tool's own classification is part of its output).
- **Liveness for wrong-value mutants** looks for the literal `return undefined` in the served output; a minifier could rewrite it. The fixture is not minified; on real bundled apps a non-live verdict could be a false negative of the check, and is reported as such.
- **Isolated arms rebuild each run** (the build step belongs to `isolate run`); the verdict metric (test phase) is unaffected, and the end-to-end number subtracts build and reruns.
- **No controls possible on the fixture.** With a real map, the only file no test executes is `src/locals.ts`, which holds types only, so no control mutant exists. Reported as a limit of the fixture.

## What was not tested

- The 45-minute cap path, and the "add a round when max/min > 1.10" path.
- A full Experiment B with a real map (trace landed on main after the harness was built; the lead runs it).
- Recipe services such as mailpit (the harness does not start them; rallly's onboarding does it by hand).

## What was assumed

- That the most frequent baseline@1 outcome per test is the right reference. Alternatives (the first round, or "passed in all rounds") would change which runs count as valid when the baseline is flaky.
- That `affected --json`'s `all` means "every test in the reference runs".
