export const MODES = Object.freeze({ FOCUS: 'focus', BREAK: 'break' });
export const PHASES = Object.freeze({ IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused' });
export const DEFAULT_DURATIONS = Object.freeze({ [MODES.FOCUS]: 25 * 60, [MODES.BREAK]: 5 * 60 });
export const STORAGE_VERSION = 1;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value) {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function makeInitialState(durations = DEFAULT_DURATIONS, now = Date.now()) {
  return {
    mode: MODES.FOCUS,
    phase: PHASES.IDLE,
    running: false,
    durationSeconds: durations[MODES.FOCUS],
    remainingSeconds: durations[MODES.FOCUS],
    pausedRemainingSeconds: durations[MODES.FOCUS],
    endAt: null,
    sessionStartedAt: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    completedSessions: 0,
    focusMinutes: 0,
    day: todayKey(new Date(now))
  };
}

function validState(candidate) {
  return candidate && typeof candidate === 'object' && Object.values(MODES).includes(candidate.mode) && Object.values(PHASES).includes(candidate.phase)
    && (candidate.running === undefined || typeof candidate.running === 'boolean')
    && Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds > 0
    && Number.isFinite(candidate.remainingSeconds) && candidate.remainingSeconds >= 0
    && Number.isFinite(candidate.pausedRemainingSeconds) && candidate.pausedRemainingSeconds >= 0
    && Number.isFinite(candidate.completedSessions) && candidate.completedSessions >= 0
    && Number.isFinite(candidate.focusMinutes) && candidate.focusMinutes >= 0
    && isCalendarDay(candidate.day)
    && (candidate.endAt === undefined || candidate.endAt === null || Number.isFinite(candidate.endAt));
}

function validDayRecord(candidate) {
  return candidate && Number.isFinite(candidate.completedSessions) && candidate.completedSessions >= 0
    && Number.isFinite(candidate.focusMinutes) && candidate.focusMinutes >= 0;
}

function stateRecord(state) { return { completedSessions: state.completedSessions, focusMinutes: state.focusMinutes }; }
function timingState(state) {
  // Defaults make snapshots written by the previous implementation safe to load.
  const running = typeof state.running === 'boolean' ? state.running : state.phase === PHASES.RUNNING;
  const remaining = Number.isFinite(state.remainingSeconds) ? state.remainingSeconds : state.pausedRemainingSeconds;
  return {
    ...state,
    running,
    phase: running ? PHASES.RUNNING : state.phase,
    remainingSeconds: remaining,
    pausedRemainingSeconds: remaining,
    endAt: Number.isFinite(state.endAt) ? state.endAt : null,
    sessionStartedAt: Number.isFinite(state.sessionStartedAt) ? state.sessionStartedAt : null,
    startedAt: Number.isFinite(state.startedAt) ? state.startedAt : null,
    pausedAt: Number.isFinite(state.pausedAt) ? state.pausedAt : null,
    completedAt: Number.isFinite(state.completedAt) ? state.completedAt : null
  };
}
function rolloverState(state, day, dayRecord) {
  return {
    ...state,
    day,
    completedSessions: validDayRecord(dayRecord) ? dayRecord.completedSessions : 0,
    focusMinutes: validDayRecord(dayRecord) ? dayRecord.focusMinutes : 0
  };
}
function readStorage(storage, key) { try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; } }
function writeStorage(storage, key, value) { try { storage?.setItem(key, JSON.stringify(value)); return Boolean(storage); } catch { return false; } }

/** v1: { version, currentDay, state: TimerState, days: { "YYYY-MM-DD": DayRecord } } */
export function loadSnapshot(storage, key, durations = DEFAULT_DURATIONS, now = Date.now()) {
  const fresh = makeInitialState(durations, now);
  const parsed = readStorage(storage, key);
  const days = {};
  const isEnvelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('version' in parsed || 'state' in parsed || 'days' in parsed);
  const compatible = !isEnvelope || parsed.version === STORAGE_VERSION;
  if (compatible && parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days)) {
    for (const [day, record] of Object.entries(parsed.days)) if (isCalendarDay(day) && validDayRecord(record)) days[day] = { ...record };
  }
  const candidate = compatible && parsed?.state && typeof parsed.state === 'object' ? parsed.state : compatible ? parsed : null;
  const active = validState(candidate) ? timingState({ ...fresh, ...candidate }) : fresh;
  // Migrate the former flat state and preserve it in history.
  if (validState(candidate)) days[candidate.day] = stateRecord(candidate);
  if (active.day !== fresh.day) return { state: rolloverState(active, fresh.day, days[fresh.day]), days };
  if (validDayRecord(days[fresh.day])) {
    active.completedSessions = days[fresh.day].completedSessions;
    active.focusMinutes = days[fresh.day].focusMinutes;
  }
  return { state: active, days };
}

export function saveSnapshot(storage, key, snapshot) {
  const days = {};
  if (snapshot?.days && typeof snapshot.days === 'object') {
    for (const [day, record] of Object.entries(snapshot.days)) if (isCalendarDay(day) && validDayRecord(record)) days[day] = { ...record };
  }
  if (validState(snapshot?.state)) days[snapshot.state.day] = stateRecord(snapshot.state);
  return writeStorage(storage, key, { version: STORAGE_VERSION, currentDay: snapshot?.state?.day ?? null, state: snapshot?.state, days });
}

export function loadState(storage, key, durations = DEFAULT_DURATIONS, now = Date.now()) { return loadSnapshot(storage, key, durations, now).state; }
export function saveState(storage, key, state) {
  // Keep this legacy helper history-aware. Older callers still save a flat
  // state, but must not erase the date-keyed records introduced by v1.
  const existing = loadSnapshot(storage, key, DEFAULT_DURATIONS, Date.now());
  return saveSnapshot(storage, key, { state, days: existing.days });
}
export function remainingSeconds(state, now = Date.now()) {
  const active = timingState(state);
  return active.running && active.endAt !== null
    ? Math.max(0, Math.ceil((active.endAt - now) / 1000))
    : Math.max(0, Math.ceil(active.remainingSeconds));
}

export function start(state, now = Date.now()) {
  const active = timingState(state);
  if (active.running) return active;
  const remaining = remainingSeconds(active, now);
  return { ...active, phase: PHASES.RUNNING, running: true, endAt: now + remaining * 1000,
    remainingSeconds: remaining, pausedRemainingSeconds: remaining, sessionStartedAt: active.sessionStartedAt ?? now,
    startedAt: now, pausedAt: null, completedAt: null };
}

export function pause(state, now = Date.now()) {
  const active = timingState(state);
  if (!active.running) return active;
  const remaining = remainingSeconds(active, now);
  return { ...active, phase: PHASES.PAUSED, running: false, endAt: null,
    remainingSeconds: remaining, pausedRemainingSeconds: remaining, pausedAt: now };
}

export function reset(state, durations = DEFAULT_DURATIONS) {
  const active = timingState(state); const seconds = durations[active.mode];
  return { ...active, phase: PHASES.IDLE, running: false, durationSeconds: seconds, endAt: null,
    remainingSeconds: seconds, pausedRemainingSeconds: seconds, sessionStartedAt: null, startedAt: null, pausedAt: null, completedAt: null };
}

export function switchMode(state, mode, durations = DEFAULT_DURATIONS) {
  const active = timingState(state);
  if (!Object.values(MODES).includes(mode) || mode === active.mode) return active;
  const seconds = durations[mode];
  return { ...active, mode, phase: PHASES.IDLE, running: false, durationSeconds: seconds, endAt: null,
    remainingSeconds: seconds, pausedRemainingSeconds: seconds, sessionStartedAt: null, startedAt: null, pausedAt: null, completedAt: null };
}

export function complete(state, now = Date.now(), durations = DEFAULT_DURATIONS) {
  const active = timingState(state); const wasFocus = active.mode === MODES.FOCUS;
  const nextMode = wasFocus ? MODES.BREAK : MODES.FOCUS; const seconds = durations[nextMode];
  const next = { ...active, mode: nextMode, phase: PHASES.IDLE, running: false, durationSeconds: seconds, endAt: null,
    remainingSeconds: seconds, pausedRemainingSeconds: seconds, sessionStartedAt: null, startedAt: null, pausedAt: null, completedAt: now };
  return wasFocus ? { ...next, completedSessions: active.completedSessions + 1,
    focusMinutes: active.focusMinutes + Math.round(active.durationSeconds / 60), day: todayKey(new Date(now)) } : next;
}

export function reconcile(state, now = Date.now(), durations = DEFAULT_DURATIONS, dayRecord = null) {
  const active = timingState(state);
  if (active.day !== todayKey(new Date(now))) {
    const rolled = rolloverState(active, todayKey(new Date(now)), dayRecord);
    if (!rolled.running) return rolled;
    const remaining = remainingSeconds(rolled, now);
    if (remaining === 0) return complete(rolled, now, durations);
    return { ...rolled, remainingSeconds: remaining, pausedRemainingSeconds: remaining };
  }
  if (!active.running) return active;
  const remaining = remainingSeconds(active, now);
  if (remaining === 0) return complete(active, now, durations);
  return { ...active, remainingSeconds: remaining, pausedRemainingSeconds: remaining };
}
