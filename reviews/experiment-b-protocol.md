# Adversarial review: Experiment B protocol (before running it)

Every way the impact-map numbers could come out wrong in the thesis's favour, and what the protocol does about each. The protocol is PLAN.md §5 (v3).

| # | Way recall or selectivity could be flattered | Control | Residual risk |
|---|---|---|---|
| 1 | Mutation targets drawn from the map itself: files the tracer never sees can never be targets | Targets drawn from `git ls-files` source files, seeded PRNG (seed reported), stratified by map status (in a test set / bootLoaded only / global / absent) | Stratum sizes on the fixture are tiny (≈ 20 source files in total), so the fixture's recall is close to a census, not a sample |
| 2 | The throw-in-function mutant only fires where the tracer already recorded execution, so recall ≈ 1 by construction | Two more mutant kinds on the fixture: top-level literal (probes D-011's known hole) and wrong-value early return (failures can surface in other tests through database state) | Wrong-value mutants that crash nothing are "no test failed", not misses; the suite's own strength limits what can be seen |
| 3 | Non-live mutants (not in the build that is served) counted as "suite did not notice" | Liveness check: the marker must be in the served build output; non-live mutants reported, not scored | Client files served as-is (`public/`) are live by construction |
| 4 | Flaky tests counted as detections or misses | F = failing tests minus tests failing in two unmutated reference runs at the same N | A test flaky at a rate below 1 in 2 can still slip in; reported per miss |
| 5 | Global-file mutants score recall 1 for free (P = all) | Reported separately, excluded from headline recall | None |
| 6 | Headline recall from a handful of mutants reads as certainty | Headline = fraction of live non-global mutants with zero misses, with n and a Clopper-Pearson 95% interval; the claim is judged on the lower bound | With n ≈ 15 on the fixture, even 15/15 gives a lower bound near 0.78, which by the pre-registered rule is "falsified" territory; that is the honest reading of a small n |
| 7 | Map stability measured on files every test runs | Per-file Jaccard of the selecting-test sets, over files selected by < 50% of tests, across two builds at different N (4 and 2) | The fixture is deterministic; stability on real apps is only measured where tracing works |
| 8 | Selection ratio treats tests as equal cost | Time-weighted ratio next to the count ratio | Tests in the same file share setup; file-level expansion not modelled |
| 9 | Controls that are dead code can never fail | Controls come from the "absent" stratum and are liveness-checked; a live control that fails is a miss of a different kind (executed but not traced) | Dead-code controls still count as "no failure"; reported as such |
| 10 | Test-side code (helpers, fixtures) never mutated, although edits there select nothing | Non-JS and test-support edits are reported for what `affected` does with them; the follow-up rule (test-support file → all) is scored if it lands | Mutating test helpers is not part of the spec's protocol; noted as a gap |
| 11 | Tracing only works on Playwright ≤ 1.58 (1.60+ bundles the worker), so real repos that can be traced are few | Reported as a result: the number of real repos where tracing works is itself the answer to "does B hold on real repos" | If fewer than 3 repos, the spec's rule applies: report that as the result |
| 12 | The same N and the same test order in reference and mutant runs can hide order-dependent failures | Mutant runs use the best N from Experiment A, same as the references; Playwright's scheduling is deterministic for a fixed file set | Order effects across workers are not probed |

What the lead will do if a control could not be applied: say so next to the number in RESULTS.md.
