# Provenance — Pomodoro focus timer

This project is the deliverable of a single AgentWeave run. It is published
unedited (including its defects) so the landing-page case study can be
checked against the real artifact.

## The run

- **Workstream:** `92f987fd-8f75-4b1b-ae59-d04ba7dcd5e9` — status: completed
- **Date:** 2026-10-23
- **Goal (verbatim):** "Build a single-page Pomodoro focus timer web app: a
  large, clear countdown timer with 25-minute focus sessions and 5-minute
  breaks, start/pause/reset controls, automatic switching between focus and
  break with a clear mode indicator, a counter of completed focus sessions,
  and a daily session history kept in the browser. Include automated tests
  and a README."
- **Team:** six agents — PM, PE, frontend, backend, devops, QA — all on
  Codex (`gpt-5.6-luna`). Independent proposals → critique → synthesis →
  20 tasks → parallel execution → QA validation.
- **Result:** 20 of 20 tasks completed. 770,485 tokens tracked per agent.
- **Human checkpoints:** the plan was approved before execution; the
  delivery was accepted at the final gate.
- **Cost:** $0 in API fees. The run executed on a flat-rate coding
  subscription, not per-token billing.

## Independent verification (2026-10-24)

The run's headline numbers were re-checked against this artifact before
the case study was linked to it:

- **Tests re-run locally:** `src/timer.js` + UI logic suites pass in full —
  `test/timer.test.js` 32/32, `test/app.test.js` 14/14 (46 Pomodoro tests).
  `test/accessibility.test.js` (6 tests) targets the AgentWeave landing
  page, not this app: the run's workspace was shared with landing-page
  work, which is also why the run-era dashboard figure of "51 tests"
  spans the shared suite rather than this app alone.
- **Defect found:** the shipped bundle did not contain the app.
  `scripts/build.mjs` copies `docs/` into `dist/`, and `docs/index.html`
  in this workspace is a leftover copy of an old AgentWeave landing page —
  so `dist/index.html` was a docs page, not the timer. The team's QA gate
  validated the test suites but never opened the assembled bundle, and
  the run's app entry page (the HTML shell wiring `src/app.js`) was never
  written. Process metrics said "done"; the product, as bundled, was not
  usable. This is recorded here rather than quietly fixed in the source.

## The live demo

The demo served from the landing page (`docs/examples/pomodoro/`) runs
this run's **unmodified** `src/app.js`, `src/timer.js`, and
`src/styles.css`. The missing HTML shell was authored on 2026-10-24 to
the exact DOM contract the code and its tests specify (element ids,
`data-mode` tabs, ARIA roles), and verified interactively: initial render
25:00, start/pause, live countdown, focus/break switching, daily history
rendering, zero page errors.
