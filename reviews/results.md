# Adversarial review: RESULTS.md

Three independent hostile reviewers read RESULTS.md against the raw data (`data/results/**`), PLAN.md §1 (the pre-registered verdict rules) and LOG.md: one for numbers, one for whether the verdicts follow from the rules, one as a skeptic of the method. Their full output is in the workflow journal of the session. Below: what they found, what changed, and what still stands against the report.

## Is the verdict supported by the data?

**Before the review, partly not.** RESULTS.md called Claim A "not supported", a label the pre-registration does not define. It also backed that verdict with evidence the rules exclude: the fixture, an N=2 arm, and a control with invalid rounds. It kept umami in the median while dropping rallly for "isolation incomplete", although umami's own reports carry that same label.

**After the review:**
- **Claim A is "inconclusive"**, the label the addendum defines for fewer than 3 repos. Every measurement is below the 2x falsification line. The report now states that umami is counted by a post-hoc override (LOG.md 17:18).
- **Claim B is "falsified by the pre-registered rule"**, because all three triggers fire:
  - the CI lower bound is below 0.8 on both apps;
  - umami's stability is 0.875, below 0.9;
  - the median time-weighted selection is 0.97 on the fixture, at or above 0.8.
  The report also says that the recall trigger fires because of small n, not because of an observed miss.

## What a skeptic would say (and whether the report now says it)

| Objection | Addressed? |
|---|---|
| umami's 1.30x mostly measures three stale tests waiting out 30 s timeouts: 90 of 111 s of serial test time. The protocol's "re-time on the common passing subset" was skipped. | Yes. It is re-timed on the 4 files whose 23 tests pass in every baseline round (`data/results/umami-passing/`), and both numbers are reported. |
| umami is kept in the median despite its own "isolation incomplete" label. | Yes, disclosed as a post-hoc override (LOG.md 17:18). |
| No repo could have reached 3x: the N=4 ceilings (2.14 fixture, 1.23 umami, 1.83 rallly) were below the bar before any timing. So the experiment cannot separate "isolation does not scale" from "these suites on 4 cores cannot scale". | Yes, added as a verdict bullet. This is the strongest objection and it stands: **this sprint's hardware and repos could not have confirmed Claim A.** |
| rallly's subset was chosen after onboarding and weighted toward files that failed. rallly's full suite is also over the 5-minute limit. | Yes, disclosed as a deviation. |
| The rallly per-worker-mailpit control (1.58x) has no warm-up, a spread over the limit, and only 1 of 3 rounds valid by the outcome rule. | Yes, labelled "indicative only" with those caveats. |
| rallly's 5 isolation failures are still `"uninvestigated"` in the JSON. | Partly. RESULTS.md categorizes them from the error messages and the spec source: timeouts in specs that call `deleteAllMessages()` or wait for an email code in the shared mailpit (unmanaged service), plus timeouts under load at ~95% CPU. The harness JSON is not hand-edited (CONTRIBUTING). |
| "Isolation held" was too broad. | Yes, rewritten. It held on the fixture and umami's browser suite. umami's API suite needed a hand-written seed step. rallly needed the shared-origin proxy and per-worker mail catchers, and still had one test fail in 2 of 3 control rounds under load. |
| umami's map instability is confounded with load: the N=4 trace started at load 3.78, the N=2 trace at 0.7. | Yes, stated. |
| Experiment B ran before A at N=4, without the load gate. | Yes, stated as a deviation. |
| The selection-ratio "most important number" for umami came from a non-live mutant's file. | Yes. Now reported as 0.21 by count; 0.96 by time only with that file; 0.66 without it. The fixture's non-global median, 0.39, is reported next to its 0.97. |
| Small miscounts: 4 vs 5 files, 49 vs 72 unresolved URLs, 12 sampled vs 10 mutated files, scout 12 vs 9 examined, the fixture's end-to-end explanation. | Yes, all corrected. |

## The weakest number

**umami's 1.30x on the full browser suite**, the only real-repo N=4 number that passed the validity checks. It is dominated by stale tests timing out. Its replacement, the passing-subset re-timing, rests on 23 tests in 4 files: 21 are request-level API tests and 3 are UI tests in one file. It is therefore a weak test of browser-heavy isolation too. Claim A's evidence on real repos is thin, and the report says so.

## What the report still does not do

- Test Claim A on hardware and suites where the ceilings allow more than 3x (≥ 8 cores, a suite with many short files). HANDOFF.md lists the exact commands.
- Score enough mutants (≥ 36) to put Claim B's recall interval above 0.9 on any app.
- Trace rallly or documenso.
