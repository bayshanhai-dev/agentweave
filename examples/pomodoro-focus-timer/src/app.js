import { DEFAULT_DURATIONS, MODES, PHASES, loadSnapshot, pause, reconcile, remainingSeconds, reset, saveSnapshot, start, switchMode, todayKey } from './timer.js';

const STORAGE_KEY = 'pomodoro-timer-state-v1';
let storage = null;
try { storage = window.localStorage; } catch { /* Privacy mode or blocked storage. */ }
const snapshot = loadSnapshot(storage, STORAGE_KEY, DEFAULT_DURATIONS);
const loadedState = snapshot.state;
let state = reconcile(snapshot.state, Date.now(), DEFAULT_DURATIONS);
snapshot.state = state;
let lastRenderedSeconds = null;
const $ = (id) => document.getElementById(id);
const timer = $('timer');
const status = $('status');
const announcer = $('announcer');
const modeTabs = [...document.querySelectorAll('[data-mode]')];
const historyList = $('history-list');
const persist = () => {
  // Keep the in-memory history in sync before saving. This matters at local
  // midnight: the rollover is persisted twice (archive, then new day), and
  // the second write must retain the archived day's totals.
  if (state?.day) snapshot.days[state.day] = {
    completedSessions: state.completedSessions,
    focusMinutes: state.focusMinutes
  };
  return saveSnapshot(storage, STORAGE_KEY, snapshot);
};
if (state !== loadedState) persist();
const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const modeName = (mode) => mode === MODES.FOCUS ? 'focus' : 'break';
const titleCase = (value) => `${value[0].toUpperCase()}${value.slice(1)}`;
const announce = (message) => { announcer.textContent = ''; window.setTimeout(() => { announcer.textContent = message; }, 20); };
function renderTodayLabel() {
  $('today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.now()));
}

function renderHistory() {
  if (!historyList) return;
  const currentDate = new Date(Date.now());
  const dateFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const rows = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(currentDate);
    date.setDate(currentDate.getDate() - offset);
    const day = todayKey(date);
    const record = day === state.day
      ? { completedSessions: state.completedSessions, focusMinutes: state.focusMinutes }
      : snapshot.days?.[day] ?? { completedSessions: 0, focusMinutes: 0 };
    const label = offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : dateFormatter.format(date);
    const sessionLabel = `${record.completedSessions} ${record.completedSessions === 1 ? 'session' : 'sessions'}`;
    const minuteLabel = `${record.focusMinutes} ${record.focusMinutes === 1 ? 'minute' : 'minutes'}`;
    rows.push(`<div class="history-row${offset === 0 ? ' is-today' : ''}"><time datetime="${day}">${label}</time><span>${sessionLabel}</span><span>${minuteLabel}</span></div>`);
  }
  historyList.innerHTML = rows.join('');
}

function render() {
  const seconds = remainingSeconds(state); const mode = modeName(state.mode);
  timer.textContent = formatTime(seconds);
  timer.dateTime = `PT${seconds}S`;
  timer.setAttribute('aria-label', `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds remaining`);
  const progress = Math.max(0, Math.min(100, ((state.durationSeconds - seconds) / state.durationSeconds) * 100));
  $('timer-ring').style.setProperty('--progress', progress.toFixed(2));
  $('progress-bar').style.width = `${progress}%`;
  $('progress-track').setAttribute('aria-valuenow', String(Math.round(progress)));
  $('progress-track').setAttribute('aria-label', `${titleCase(mode)} session progress`);
  $('timer-heading').textContent = `${titleCase(mode)} session`;
  const isRunning = state.running;
  $('state-label').textContent = isRunning ? 'Running' : state.phase === PHASES.PAUSED ? 'Paused' : 'Ready';
  const timerCard = $('timer-card') ?? $('timer-panel').closest('.timer-card');
  timerCard.classList.toggle('is-running', isRunning);
  if (timerCard.dataset) timerCard.dataset.mode = state.mode;
  $('start-pause').textContent = isRunning ? `Pause ${mode}` : `Start ${mode}`;
  $('start-pause').setAttribute('aria-label', isRunning ? `Pause ${mode} timer` : `Start ${mode} timer`);
  $('start-pause').setAttribute('aria-pressed', String(isRunning));
  $('reset').setAttribute('aria-label', `Reset ${mode} timer`);
  $('reset').disabled = state.phase === PHASES.IDLE && seconds === state.durationSeconds;
  status.textContent = isRunning ? `${titleCase(mode)} in progress.` : state.phase === PHASES.PAUSED ? 'Paused. Take a breath, then continue.' : 'Ready when you are.';
  modeTabs.forEach((button) => { const selected = button.dataset.mode === state.mode; button.classList.toggle('is-selected', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  $('timer-panel').setAttribute('aria-labelledby', `${state.mode}-tab`);
  $('completed-count').textContent = state.completedSessions; $('focus-minutes').textContent = state.focusMinutes;
  renderHistory();
  if (lastRenderedSeconds !== seconds && state.phase === PHASES.RUNNING) timer.animate?.([{ opacity: .75 }, { opacity: 1 }], { duration: 180 });
  lastRenderedSeconds = seconds;
}
function tick() {
  const now = Date.now();
  const currentDay = todayKey(new Date(now));
  if (state.day !== currentDay) persist(); // Archive the previous day before rollover.
  const previous = state;
  const next = reconcile(state, now, DEFAULT_DURATIONS, snapshot.days?.[currentDay]);
  if (next !== state) {
    state = next; snapshot.state = state;
    persist();
    renderTodayLabel();
    if (previous.mode !== next.mode) announce(`${titleCase(next.mode)} mode is ready.`);
  }
  render();
}

function reconcileActiveDay() {
  const now = Date.now();
  const currentDay = todayKey(new Date(now));
  if (state.day !== currentDay) persist();
  const next = reconcile(state, now, DEFAULT_DURATIONS, snapshot.days?.[currentDay]);
  if (next === state) return;
  state = next; snapshot.state = state; persist(); renderTodayLabel(); render();
}

renderTodayLabel();
$('start-pause').addEventListener('click', () => { reconcileActiveDay(); const wasRunning = state.running; state = wasRunning ? pause(state) : start(state); snapshot.state = state; persist(); render(); announce(wasRunning ? `${titleCase(modeName(state.mode))} timer paused.` : `${titleCase(modeName(state.mode))} timer started.`); });
$('reset').addEventListener('click', () => { reconcileActiveDay(); state = reset(state); snapshot.state = state; persist(); render(); announce(`${titleCase(modeName(state.mode))} timer reset.`); });
modeTabs.forEach((button) => button.addEventListener('click', () => { reconcileActiveDay(); if (button.dataset.mode === state.mode) return; state = switchMode(state, button.dataset.mode); snapshot.state = state; persist(); render(); announce(`${titleCase(modeName(state.mode))} mode selected. Timer ready.`); }));
document.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = modeTabs.indexOf(document.activeElement);
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? modeTabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + modeTabs.length) % modeTabs.length;
  modeTabs[nextIndex].focus();
  modeTabs[nextIndex].click();
});
document.addEventListener('keydown', (event) => { if (event.target.matches('button, input, textarea, select')) return; if (event.code === 'Space') { event.preventDefault(); $('start-pause').click(); } if (event.key.toLowerCase() === 'r') $('reset').click(); });
render(); window.setInterval(tick, 250); window.addEventListener('beforeunload', persist);
document.addEventListener('visibilitychange', reconcileActiveDay);
window.addEventListener('focus', reconcileActiveDay);
