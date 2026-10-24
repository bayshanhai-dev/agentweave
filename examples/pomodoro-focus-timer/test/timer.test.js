import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DURATIONS, MODES, PHASES, complete, loadSnapshot, loadState, makeInitialState, pause, reconcile, remainingSeconds, reset, saveSnapshot, saveState, start, switchMode, todayKey } from '../src/timer.js';
const memory = () => ({ data: {}, getItem(key) { return this.data[key] ?? null; }, setItem(key, value) { this.data[key] = value; } });
const now = new Date(2026, 9, 23, 9, 0, 0).getTime();
test('initializes focus and break with the configured 25-minute and 5-minute defaults', () => {
  const initial = makeInitialState(DEFAULT_DURATIONS, now);
  assert.equal(initial.mode, MODES.FOCUS);
  assert.equal(initial.phase, PHASES.IDLE);
  assert.equal(initial.durationSeconds, 25 * 60);
  assert.equal(initial.remainingSeconds, 25 * 60);

  const breakState = switchMode(initial, MODES.BREAK, DEFAULT_DURATIONS);
  assert.equal(breakState.mode, MODES.BREAK);
  assert.equal(breakState.phase, PHASES.IDLE);
  assert.equal(breakState.durationSeconds, 5 * 60);
  assert.equal(breakState.remainingSeconds, 5 * 60);
});
test('uses wall-clock timestamps, so remaining time resists interval drift', () => { const running = start(makeInitialState(DEFAULT_DURATIONS, now), now); assert.equal(remainingSeconds(running, now + 12_345), 25 * 60 - 12); assert.equal(remainingSeconds(running, now + 25 * 60 * 1000 + 1), 0); });
test('state explicitly records running status, remaining time, and session timestamps', () => {
  const initial = makeInitialState(DEFAULT_DURATIONS, now);
  assert.equal(initial.running, false);
  assert.equal(initial.remainingSeconds, 25 * 60);
  assert.equal(initial.sessionStartedAt, null);
  const running = start(initial, now);
  assert.equal(running.running, true);
  assert.equal(running.sessionStartedAt, now);
  assert.equal(running.startedAt, now);
  assert.equal(running.endAt, now + 25 * 60 * 1000);
  const reconciled = reconcile(running, now + 90_000);
  assert.equal(reconciled.remainingSeconds, 24 * 60 - 30);
  const paused = pause(reconciled, now + 90_000);
  assert.equal(paused.running, false);
  assert.equal(paused.pausedAt, now + 90_000);
  assert.equal(paused.sessionStartedAt, now);
  const resumed = start(paused, now + 120_000);
  assert.equal(resumed.startedAt, now + 120_000);
  assert.equal(resumed.sessionStartedAt, now);
});
test('rounds a partially elapsed second up until the next whole second', () => {
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  assert.equal(remainingSeconds(running, now + 1), 25 * 60);
  assert.equal(remainingSeconds(running, now + 999), 25 * 60);
  assert.equal(remainingSeconds(running, now + 1_001), 25 * 60 - 1);
});
test('repeated delayed callbacks do not accumulate interval drift', () => {
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  const callbackTimes = [now + 4_999, now + 65_001, now + 301_000];
  assert.deepEqual(callbackTimes.map((at) => remainingSeconds(running, at)), [25 * 60 - 4, 24 * 60 - 5, 20 * 60 - 1]);
});
test('a delayed callback reconciles directly from the timestamp instead of interval count', () => {
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  const delayed = reconcile(running, now + 7 * 60 * 1000 + 900, DEFAULT_DURATIONS);
  assert.equal(remainingSeconds(delayed, now + 7 * 60 * 1000 + 900), 18 * 60);
  const afterSuspension = reconcile(running, now + 25 * 60 * 1000 + 2_000, DEFAULT_DURATIONS);
  assert.equal(afterSuspension.mode, MODES.BREAK);
  assert.equal(afterSuspension.completedSessions, 1);
});
test('pause freezes the wall-clock-derived remainder', () => { const running = start(makeInitialState(DEFAULT_DURATIONS, now), now); const paused = pause(running, now + 61_200); assert.equal(paused.phase, PHASES.PAUSED); assert.equal(remainingSeconds(paused, now + 10 * 60 * 1000), 24 * 60 - 1); });
test('resuming after a long pause uses the frozen remainder, not the old end timestamp', () => {
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  const paused = pause(running, now + 2 * 60 * 1000 + 250);
  const resumed = start(paused, now + 3 * 60 * 60 * 1000);
  assert.equal(resumed.endAt, now + 3 * 60 * 60 * 1000 + (23 * 60) * 1000);
  assert.equal(remainingSeconds(resumed, now + 3 * 60 * 60 * 1000 + 10_001), 22 * 60 + 50);
});
test('completion rolls focus into break and records today’s work', () => { const done = complete(start(makeInitialState(DEFAULT_DURATIONS, now), now), now + 25 * 60 * 1000, DEFAULT_DURATIONS); assert.equal(done.mode, MODES.BREAK); assert.equal(done.completedSessions, 1); assert.equal(done.focusMinutes, 25); assert.equal(done.phase, PHASES.IDLE); });
test('start, pause, resume, reset, and break completion preserve the expected transitions', () => {
  const initial = makeInitialState(DEFAULT_DURATIONS, now);
  const running = start(initial, now);
  assert.equal(running.phase, PHASES.RUNNING);
  const paused = pause(running, now + 90_000);
  assert.equal(paused.phase, PHASES.PAUSED);
  assert.equal(remainingSeconds(paused, now + 300_000), 24 * 60 - 30);
  const resumed = start(paused, now + 120_000);
  assert.equal(resumed.phase, PHASES.RUNNING);
  assert.equal(remainingSeconds(resumed, now + 120_000), 24 * 60 - 30);
  const resetState = reset(resumed, DEFAULT_DURATIONS);
  assert.equal(resetState.phase, PHASES.IDLE);
  assert.equal(remainingSeconds(resetState, now), 25 * 60);
  const breakDone = complete({ ...resetState, mode: MODES.BREAK, durationSeconds: 300, pausedRemainingSeconds: 0 }, now, DEFAULT_DURATIONS);
  assert.equal(breakDone.mode, MODES.FOCUS);
  assert.equal(breakDone.completedSessions, 0);
});
test('reconciling an already-completed transition records a focus session exactly once', () => {
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  const completed = reconcile(running, now + 25 * 60 * 1000, DEFAULT_DURATIONS);
  const checkedAgain = reconcile(completed, now + 25 * 60 * 1000 + 60_000, DEFAULT_DURATIONS);
  const checkedAfterAnotherCallback = reconcile(checkedAgain, now + 26 * 60 * 1000, DEFAULT_DURATIONS);
  assert.equal(completed.completedSessions, 1);
  assert.equal(checkedAgain.completedSessions, 1);
  assert.equal(checkedAfterAnotherCallback.completedSessions, 1);
  assert.equal(checkedAfterAnotherCallback.focusMinutes, 25);
});
test('persisting repeated reconciliation of a completed focus records one session', () => {
  const storage = memory();
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  const completed = reconcile(running, now + 25 * 60 * 1000, DEFAULT_DURATIONS);
  saveSnapshot(storage, 'timer', { state: completed, days: {} });
  saveSnapshot(storage, 'timer', { state: reconcile(completed, now + 25 * 60 * 1000 + 250, DEFAULT_DURATIONS), days: {} });
  const saved = loadState(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.equal(saved.completedSessions, 1);
  assert.equal(saved.focusMinutes, 25);
});
test('a persisted state from another local calendar day is discarded', () => { const storage = memory(); const old = { ...makeInitialState(DEFAULT_DURATIONS, now), day: '2026-10-22', completedSessions: 7 }; storage.setItem('timer', JSON.stringify(old)); const loaded = loadState(storage, 'timer', DEFAULT_DURATIONS, now); assert.equal(loaded.day, todayKey(new Date(now))); assert.equal(loaded.completedSessions, 0); });
test('history day keys follow the user local timezone', () => {
  const instant = '2026-10-23T00:30:00.000Z';
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(todayKey(new Date(instant)), '2026-10-22');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(todayKey(new Date(instant)), '2026-10-23');
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
test('reconcile handles midnight rollover and an elapsed timer', () => { const previous = { ...makeInitialState(DEFAULT_DURATIONS, now), day: '2026-10-22', completedSessions: 3 }; const rolled = reconcile(previous, now, DEFAULT_DURATIONS); assert.equal(rolled.day, '2026-10-23'); assert.equal(rolled.completedSessions, 0); const running = start(makeInitialState(DEFAULT_DURATIONS, now), now); assert.equal(reconcile(running, now + 25 * 60 * 1000, DEFAULT_DURATIONS).mode, MODES.BREAK); });
test('midnight rollover preserves a valid paused timer while resetting daily totals', () => {
  const beforeMidnight = new Date(2026, 9, 22, 23, 59, 0).getTime();
  const paused = pause(start({ ...makeInitialState(DEFAULT_DURATIONS, beforeMidnight), completedSessions: 2, focusMinutes: 50 }, beforeMidnight), beforeMidnight + 60_000);
  const rolled = reconcile(paused, new Date(2026, 9, 23, 0, 1, 0).getTime(), DEFAULT_DURATIONS);
  assert.equal(rolled.day, '2026-10-23');
  assert.equal(rolled.mode, MODES.FOCUS);
  assert.equal(rolled.phase, PHASES.PAUSED);
  assert.equal(rolled.pausedRemainingSeconds, 24 * 60);
  assert.equal(rolled.completedSessions, 0);
  assert.equal(rolled.focusMinutes, 0);
});
test('an active timer that crosses midnight continues and overdue completion belongs to the new day', () => {
  const beforeMidnight = new Date(2026, 9, 22, 23, 50, 0).getTime();
  const running = start({ ...makeInitialState(DEFAULT_DURATIONS, beforeMidnight), day: '2026-10-22', completedSessions: 4 }, beforeMidnight);
  const afterMidnight = new Date(2026, 9, 23, 0, 20, 0).getTime();
  const rolled = reconcile(running, afterMidnight, DEFAULT_DURATIONS);
  assert.equal(rolled.day, '2026-10-23');
  assert.equal(rolled.mode, MODES.BREAK);
  assert.equal(rolled.completedSessions, 1);
  assert.equal(rolled.focusMinutes, 25);
});
test('midnight rollover is safe when triggered by startup, a timer action, or visibility/focus reconciliation', () => {
  const beforeMidnight = new Date(2026, 9, 22, 23, 59, 59, 500).getTime();
  const afterMidnight = new Date(2026, 9, 23, 0, 0, 0, 100).getTime();
  for (const trigger of ['startup', 'timer action', 'visibility', 'focus']) {
    const old = { ...makeInitialState(DEFAULT_DURATIONS, beforeMidnight), day: '2026-10-22', completedSessions: 2, focusMinutes: 50 };
    const fresh = reconcile(old, afterMidnight, DEFAULT_DURATIONS);
    assert.equal(fresh.day, '2026-10-23', trigger);
    assert.equal(fresh.completedSessions, 0, trigger);
    assert.equal(fresh.focusMinutes, 0, trigger);
  }
});
test('mode changes and reset always return an explicit idle state', () => { const changed = switchMode(start(makeInitialState(DEFAULT_DURATIONS, now), now), MODES.BREAK); assert.deepEqual({ mode: changed.mode, phase: changed.phase, remaining: remainingSeconds(changed, now) }, { mode: MODES.BREAK, phase: PHASES.IDLE, remaining: 5 * 60 }); assert.equal(reset(changed, DEFAULT_DURATIONS).mode, MODES.BREAK); });
test('persists the active state and date-keyed history in a versioned envelope', () => {
  const storage = memory();
  const state = { ...makeInitialState(DEFAULT_DURATIONS, now), completedSessions: 2, focusMinutes: 50 };
  assert.equal(saveSnapshot(storage, 'timer', { state, days: { '2026-10-22': { completedSessions: 4, focusMinutes: 100 } } }), true);
  const raw = JSON.parse(storage.data.timer);
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.days['2026-10-22'], { completedSessions: 4, focusMinutes: 100 });
  assert.deepEqual(loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now).state.completedSessions, 2);
});
test('legacy saveState preserves existing date-keyed history', () => {
  const storage = memory();
  const initial = makeInitialState(DEFAULT_DURATIONS, now);
  saveSnapshot(storage, 'timer', { state: initial, days: {
    '2026-10-22': { completedSessions: 4, focusMinutes: 100 }
  } });
  saveState(storage, 'timer', { ...initial, completedSessions: 1, focusMinutes: 25 });
  const saved = JSON.parse(storage.data.timer);
  assert.deepEqual(saved.days['2026-10-22'], { completedSessions: 4, focusMinutes: 100 });
  assert.deepEqual(saved.days['2026-10-23'], { completedSessions: 1, focusMinutes: 25 });
});
test('rollover keeps the prior day in history while starting a fresh active day', () => {
  const storage = memory();
  const oldState = { ...makeInitialState(DEFAULT_DURATIONS, now), day: '2026-10-22', completedSessions: 3, focusMinutes: 75 };
  storage.setItem('timer', JSON.stringify({ version: 1, currentDay: oldState.day, state: oldState, days: {} }));
  const snapshot = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.equal(snapshot.state.day, '2026-10-23');
  assert.deepEqual(snapshot.days['2026-10-22'], { completedSessions: 3, focusMinutes: 75 });
});
test('startup rollover preserves the active timer and loads existing current-day totals', () => {
  const storage = memory();
  const oldState = start({ ...makeInitialState(DEFAULT_DURATIONS, now), day: '2026-10-22' }, now);
  storage.setItem('timer', JSON.stringify({ version: 1, state: oldState, days: {
    '2026-10-23': { completedSessions: 2, focusMinutes: 50 }
  }}));
  const loaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.equal(loaded.state.day, '2026-10-23');
  assert.equal(loaded.state.running, true);
  assert.equal(loaded.state.endAt, oldState.endAt);
  assert.equal(loaded.state.completedSessions, 2);
  assert.equal(loaded.state.focusMinutes, 50);
});
test('reloading a persisted running timer continues from its absolute deadline', () => {
  const storage = memory();
  const running = start(makeInitialState(DEFAULT_DURATIONS, now), now);
  saveSnapshot(storage, 'timer', { state: running, days: {} });
  const reloaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now + 90_000);
  assert.equal(reloaded.state.running, true);
  assert.equal(remainingSeconds(reloaded.state, now + 90_000), 23 * 60 + 30);
  const completed = reconcile(reloaded.state, now + 25 * 60 * 1000, DEFAULT_DURATIONS);
  assert.equal(completed.mode, MODES.BREAK);
  assert.equal(completed.completedSessions, 1);
  assert.equal(reconcile(completed, now + 26 * 60 * 1000, DEFAULT_DURATIONS).completedSessions, 1);
});
test('reload preserves independent date-keyed history while loading current-day totals', () => {
  const storage = memory();
  const state = { ...makeInitialState(DEFAULT_DURATIONS, now), completedSessions: 2, focusMinutes: 50 };
  saveSnapshot(storage, 'timer', { state, days: {
    '2026-10-21': { completedSessions: 1, focusMinutes: 25 },
    '2026-10-22': { completedSessions: 4, focusMinutes: 100 }
  } });
  const reloaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.deepEqual(reloaded.days, {
    '2026-10-21': { completedSessions: 1, focusMinutes: 25 },
    '2026-10-22': { completedSessions: 4, focusMinutes: 100 },
    '2026-10-23': { completedSessions: 2, focusMinutes: 50 }
  });
  assert.equal(reloaded.state.completedSessions, 2);
  assert.equal(reloaded.state.focusMinutes, 50);
});
test('malformed and unavailable storage safely return defaults', () => {
  const malformed = memory(); malformed.data.timer = '{not-json';
  assert.equal(loadState(malformed, 'timer', DEFAULT_DURATIONS, now).completedSessions, 0);
  const failing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => loadSnapshot(failing, 'timer', DEFAULT_DURATIONS, now));
  assert.equal(saveSnapshot(failing, 'timer', { state: makeInitialState(DEFAULT_DURATIONS, now), days: {} }), false);
});
test('missing storage values and malformed snapshot fields are ignored independently', () => {
  const storage = memory();
  assert.deepEqual(loadSnapshot(storage, 'missing', DEFAULT_DURATIONS, now).state, makeInitialState(DEFAULT_DURATIONS, now));
  storage.setItem('timer', JSON.stringify({ state: { mode: MODES.FOCUS, phase: 'broken' }, days: { '2026-10-23': { completedSessions: '2', focusMinutes: 50 } } }));
  const loaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.equal(loaded.state.phase, PHASES.IDLE);
  assert.equal(loaded.state.completedSessions, 0);
  assert.equal(loaded.days['2026-10-23'], undefined);
});
test('a valid legacy flat state is loaded and its totals are migrated into day history', () => {
  const storage = memory();
  const legacy = { ...makeInitialState(DEFAULT_DURATIONS, now), completedSessions: 2, focusMinutes: 50 };
  storage.setItem('timer', JSON.stringify(legacy));
  const loaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.deepEqual(loaded.days[legacy.day], { completedSessions: 2, focusMinutes: 50 });
  assert.equal(loaded.state.completedSessions, 2);
  assert.equal(loaded.state.focusMinutes, 50);
});
test('saving filters malformed history and reports storage failures', () => {
  const storage = memory();
  const state = makeInitialState(DEFAULT_DURATIONS, now);
  saveSnapshot(storage, 'timer', { state, days: {
    '2026-10-22': { completedSessions: 1, focusMinutes: 25 },
    'not-a-day': { completedSessions: 2, focusMinutes: 50 },
    '2026-10-21': { completedSessions: -1, focusMinutes: 25 }
  } });
  const saved = JSON.parse(storage.data.timer);
  assert.deepEqual(Object.keys(saved.days), ['2026-10-22', '2026-10-23']);
  assert.equal(saveSnapshot(null, 'timer', { state, days: {} }), false);
});
test('storage reads and writes tolerate missing APIs and failures independently', () => {
  assert.doesNotThrow(() => loadSnapshot({}, 'timer', DEFAULT_DURATIONS, now));
  assert.equal(saveSnapshot({}, 'timer', { state: makeInitialState(DEFAULT_DURATIONS, now), days: {} }), false);
  const readOnly = { getItem() { return null; } };
  assert.equal(saveSnapshot(readOnly, 'timer', { state: makeInitialState(DEFAULT_DURATIONS, now), days: {} }), false);
  const writeOnly = { setItem() {} };
  assert.equal(loadState(writeOnly, 'timer', DEFAULT_DURATIONS, now).phase, PHASES.IDLE);
});

test('unsupported envelopes and impossible calendar dates are ignored safely', () => {
  const storage = memory();
  storage.setItem('timer', JSON.stringify({ version: 99, state: { ...makeInitialState(DEFAULT_DURATIONS, now), completedSessions: 8 }, days: {
    '2026-02-30': { completedSessions: 4, focusMinutes: 100 }
  } }));
  const loaded = loadSnapshot(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.deepEqual(loaded.state, makeInitialState(DEFAULT_DURATIONS, now));
  assert.deepEqual(loaded.days, {});
});

test('incomplete timing fields cannot produce NaN after loading', () => {
  const storage = memory();
  storage.setItem('timer', JSON.stringify({ ...makeInitialState(DEFAULT_DURATIONS, now), endAt: undefined }));
  const loaded = loadState(storage, 'timer', DEFAULT_DURATIONS, now);
  assert.equal(Number.isNaN(remainingSeconds(loaded, now)), false);
  assert.equal(remainingSeconds(loaded, now), DEFAULT_DURATIONS.focus);
});
