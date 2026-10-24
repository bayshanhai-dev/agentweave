# Focus timer

A small, accessible Pomodoro timer with explicit `idle` / `running` / `paused` state, focus/break modes, and local daily progress.

## Installation and development

This is a dependency-free browser application. Node.js 18 or newer is required
for the tests and build; Python 3 is also required for the optional local static
server. No `npm install` step is required because `package.json` has no
dependencies.

From the project root, confirm that Node.js is available, then use these development commands:

```sh
# Check the prerequisite
node --version

# Start the local development server (http://localhost:4173)
npm run dev

# Run the complete automated test suite
npm test

# Create and verify the production static bundle in dist/
npm run build
npm run build:check

# Run all automated checks, including tests and a clean production build
npm run check
```

Open <http://localhost:4173> after starting the server. The development server
provides the source tree directly. `npm run build` stages the app in `dist/`,
and `npm run build:check` rebuilds it and verifies the required files and asset
references. Each command fails with a non-zero exit status if a test, build, or
verification step fails.

For a production-like local preview after building, run:

```sh
python3 -m http.server 4173 --directory dist
```

All runtime assets are local files. The application does not make network
requests, and the project has no runtime or development package dependencies.

Individual test files can be run while developing:

```sh
node --test test/timer.test.js
node --test test/app.test.js
node --test test/accessibility.test.js
```

## AgentWeave landing page

The self-contained bilingual AgentWeave landing page lives at `docs/index.html`
and is the GitHub Pages artifact. Its machine-readable content, language,
accessibility, factual-source, and deployment requirements are recorded in
`requirements/agentweave-landing.json`.

Run the dependency-free validation gate locally with:

```sh
npm run validate:docs
```

The validator checks required bilingual copy and canonical links, core semantic
and keyboard-accessibility markers, the no-runtime-dependency constraint,
source-backed factual statements, and the Pages workflow. Pushes to `main` that
touch the landing-page files run the same gate before `.github/workflows/pages.yml`
publishes `docs/`.

## Timer behavior

- **Focus** starts at 25 minutes; **Break** starts at 5 minutes.
- **Start** changes an idle or paused timer to `running`. **Pause** freezes the current remaining time. Pressing Start again resumes from that frozen value.
- **Reset** returns the selected mode to its full duration and `idle` state. It does not erase today’s completed-session or focus-minute totals.
- Switching between Focus and Break selects the new mode, resets its timer to the full duration, and leaves it `idle`.
- When a Focus timer reaches zero, it records one completed focus session and its duration in today’s focus minutes, then changes to an idle Break timer. When a Break timer reaches zero, it changes to an idle Focus timer without changing the focus totals.
- Timer actions, the timer tick, startup, visibility changes, and window focus changes reconcile the state before applying an action. This also handles timers that finish while the page is backgrounded.

Completion accounting is exactly once per running timer: reconciliation increments the focus totals only when it observes a running timer at zero, and completion immediately moves that timer to the next mode in `idle` state with a full duration. Later ticks, visibility events, focus events, or repeated reconciliation therefore see a non-running timer and cannot record the same completion again. A reset or mode switch also abandons the current timer without recording a completion.

## Timing model

Running timers store an absolute `endAt` timestamp in milliseconds. The displayed remaining time is calculated from `endAt - Date.now()` (rounded up to whole seconds), rather than by subtracting one second per interval. Consequently, delayed callbacks, throttled tabs, and suspended pages do not make the timer gain or lose time. Pausing converts the timestamp-derived value into `pausedRemainingSeconds` and clears `endAt`; resuming creates a new end timestamp from that stored remainder.

## Persistence and calendar days

The app uses localStorage key `pomodoro-timer-state-v1` and a versioned envelope:

```js
{
  version: 1,
  currentDay: "YYYY-MM-DD",
  state: TimerState,
  days: {
    "YYYY-MM-DD": { completedSessions: 2, focusMinutes: 50 }
  }
}
```

The active `state` contains the timer’s `mode` (`focus` or `break`), `phase`
(`idle`, `running`, or `paused`), `running` flag, configured duration,
remaining/paused seconds, timestamp fields (`endAt`, `sessionStartedAt`,
`startedAt`, `pausedAt`, `completedAt`), the active day, and that day’s
`completedSessions` and `focusMinutes`. A running timer’s `endAt` is the
authoritative deadline; the remaining-second fields are the persisted display
and pause values.

Dates use the browser’s local calendar date and timezone, not UTC or a server timezone. The active `state` holds the current timer; the date-keyed `days` map preserves historical daily totals. On local midnight, the previous active day is archived in `days`, the active state is assigned to the new local day, and daily totals are reset to zero. The current timer’s mode, phase, and remaining time are preserved as described below. This rollover is checked on startup, timer actions, every timer tick, visibility changes, and window focus changes, so returning to an open tab after midnight is handled too.

Only `version: 1` envelopes are read. Date keys must be real calendar dates, and invalid records are skipped independently so one damaged history entry does not discard the rest of the snapshot. A legacy flat `TimerState` (without the envelope) is accepted and normalized in memory; the next normal app persistence writes the v1 envelope and its totals into day history.

The app persists the active timer and date-keyed totals after timer actions, state-changing timer reconciliation, startup recovery, and before the page unloads. Persistence is best-effort: missing `localStorage`, invalid JSON, invalid state fields, invalid date records, blocked storage, and storage read/write errors are treated safely. Valid records are retained where possible; otherwise the app starts from default Focus/idle state and continues in memory without persistence. Storage failures are not allowed to prevent the timer from running.

On rollover, the prior active state’s totals are retained under its old date in `days`; the active state is then assigned the new local date and its daily totals are reset or restored from that date’s record. A timer that is paused at midnight remains paused with its remaining time. A timer that is still running continues according to its original `endAt`; if it expires after midnight, its completion is attributed to the new day. Rollover reconciliation is performed at startup and before timer actions, and is also triggered by ticks, visibility changes, and window focus changes. The app persists the archived history and new active-day state when reconciliation observes the rollover. The history view filters its output to the current local calendar day.

Because a running timer is based on its absolute `endAt` timestamp, backgrounding or throttling the browser tab does not make it gain or lose elapsed time. When the tab runs again, the next tick or visibility/focus reconciliation calculates the remaining time from the current wall clock and records an overdue completion once if the deadline has passed.

## Accessibility and test coverage

The primary controls are keyboard accessible: `Space` toggles start/pause and `R` resets when focus is outside a form control. Focus and Break use a keyboard-navigable tablist (`ArrowLeft`/`ArrowRight`, `Home`, and `End`), with selected state and focus-visible styling preserved. The timer exposes a human-readable accessible label, status text, live action announcements, and the timer-panel relationship through ARIA attributes.

Run the complete automated suite with `npm test` (equivalent to `node --test`). Individual suites can be run with `node --test test/timer.test.js`, `node --test test/app.test.js`, or `node --test test/accessibility.test.js`.

The automated tests cover timestamp-based countdowns and delayed/backgrounded callbacks, pause/resume/reset transitions, mode switching, exactly-once focus and break completion accounting, date-keyed persistence and midnight rollover, malformed or unavailable storage recovery, app-level fake-clock behavior, and accessibility markup and keyboard handlers. The tests are source/markup-level Node tests; use a browser and assistive technology for manual end-to-end verification.
