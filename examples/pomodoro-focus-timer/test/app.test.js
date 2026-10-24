import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DURATIONS, makeInitialState } from '../src/timer.js';

const dayBefore = new Date(2026, 9, 22, 23, 59, 59, 500).getTime();
const dayAfter = new Date(2026, 9, 23, 0, 0, 0, 100).getTime();

function element(id, extra = {}) {
  return {
    id, textContent: '', dateTime: '', disabled: false, tabIndex: 0, dataset: {},
    attributes: {}, listeners: {}, style: { setProperty() {} }, classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); },
    click() { this.dispatchEvent({ type: 'click' }); },
    closest() { return { classList: { toggle() {} } }; },
    matches() { return false; },
    focus() {}, animate() {}, ...extra
  };
}

async function loadApp({ state, now, days = {}, storage: providedStorage }) {
  const ids = ['timer', 'status', 'announcer', 'today-label', 'timer-ring', 'progress-bar', 'progress-track',
    'timer-heading', 'state-label', 'timer-panel', 'start-pause', 'reset', 'completed-count', 'focus-minutes', 'history-list'];
  const elements = Object.fromEntries(ids.map((id) => [id, element(id)]));
  elements['start-pause'].matches = () => true;
  const focusTab = element('focus-tab', { dataset: { mode: 'focus' } });
  const breakTab = element('break-tab', { dataset: { mode: 'break' } });
  const tablist = element('tablist');
  const documentListeners = {};
  const storage = providedStorage ?? { data: {}, getItem(key) { return this.data[key] ?? null; }, setItem(key, value) { this.data[key] = value; } };
  if (!providedStorage) storage.setItem('pomodoro-timer-state-v1', JSON.stringify({ version: 1, state, days }));
  let interval;
  const windowListeners = {};
  globalThis.window = {
    localStorage: storage,
    setTimeout(callback) { callback(); },
    setInterval(callback) { interval = callback; return 1; },
    addEventListener(type, listener) { (windowListeners[type] ??= []).push(listener); }
  };
  globalThis.document = {
    querySelectorAll(selector) { return selector === '[data-mode]' ? [focusTab, breakTab] : []; },
    querySelector(selector) { return selector === '[role="tablist"]' ? tablist : null; },
    getElementById(id) { return elements[id]; },
    addEventListener(type, listener) { (documentListeners[type] ??= []).push(listener); },
    dispatchEvent(event) { for (const listener of documentListeners[event.type] ?? []) listener(event); }
  };
  const originalNow = Date.now;
  Date.now = () => now.value;
  await import(`../src/app.js?app-test=${now.value}-${Math.random()}`);
  return {
    elements, focusTab, breakTab, tablist, storage,
    tick: () => interval(),
    visibility() { document.dispatchEvent({ type: 'visibilitychange' }); },
    focus() { for (const listener of windowListeners.focus ?? []) listener(); },
    restore() { Date.now = originalNow; delete globalThis.window; delete globalThis.document; }
  };
}

test('fake clock drives elapsed rendering and exactly-once focus completion', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    app.elements['start-pause'].dispatchEvent({ type: 'click' });
    now.value += 25 * 60 * 1000;
    app.tick();
    assert.equal(app.elements.timer.textContent, '05:00');
    assert.equal(app.elements['completed-count'].textContent, 1);
    app.tick();
    assert.equal(app.elements['completed-count'].textContent, 1);
    assert.equal(app.elements.status.textContent, 'Ready when you are.');
  } finally { app.restore(); }
});

test('initial render exposes the 25-minute focus and 5-minute break defaults', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    assert.equal(app.elements.timer.textContent, '25:00');
    assert.equal(app.elements.timer.attributes['aria-label'], '25 minutes 0 seconds remaining');
    assert.equal(app.elements['start-pause'].textContent, 'Start focus');
    app.breakTab.click();
    assert.equal(app.elements.timer.textContent, '05:00');
    assert.equal(app.elements.timer.attributes['aria-label'], '5 minutes 0 seconds remaining');
    assert.equal(app.elements['start-pause'].textContent, 'Start break');
  } finally { app.restore(); }
});

test('component rendering follows elapsed wall-clock time between callbacks', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    app.elements['start-pause'].dispatchEvent({ type: 'click' });
    now.value += 12_345;
    app.tick();
    assert.equal(app.elements.timer.textContent, '24:48');
    assert.equal(app.elements.timer.attributes['aria-label'], '24 minutes 48 seconds remaining');
    assert.equal(app.elements.status.textContent, 'Focus in progress.');
  } finally { app.restore(); }
});

test('startup, timer action, visibility, and focus all roll local history at midnight', async () => {
  const now = { value: dayAfter };
  const oldState = { ...makeInitialState(DEFAULT_DURATIONS, dayBefore), day: '2026-10-22', completedSessions: 3, focusMinutes: 75 };
  const app = await loadApp({ state: oldState, now });
  try {
    assert.equal(JSON.parse(app.storage.data['pomodoro-timer-state-v1']).state.day, '2026-10-23');
    for (const trigger of ['timer', 'visibility', 'focus']) {
      now.value = dayAfter;
      if (trigger === 'timer') app.tick();
      if (trigger === 'visibility') app.visibility();
      if (trigger === 'focus') app.focus();
      assert.equal(JSON.parse(app.storage.data['pomodoro-timer-state-v1']).state.day, '2026-10-23', trigger);
      assert.equal(app.elements['completed-count'].textContent, 0, trigger);
    }
  } finally { app.restore(); }
});

test('live midnight rollover keeps the archived day in persisted history', async () => {
  const now = { value: dayBefore };
  const oldState = { ...makeInitialState(DEFAULT_DURATIONS, dayBefore), day: '2026-10-22', completedSessions: 3, focusMinutes: 75 };
  const app = await loadApp({ state: oldState, now });
  try {
    now.value = dayAfter;
    app.tick();
    const saved = JSON.parse(app.storage.data['pomodoro-timer-state-v1']);
    assert.deepEqual(saved.days['2026-10-22'], { completedSessions: 3, focusMinutes: 75 });
    assert.deepEqual(saved.days['2026-10-23'], { completedSessions: 0, focusMinutes: 0 });
    assert.equal(saved.state.day, '2026-10-23');
  } finally { app.restore(); }
});

test('history displays the current local day and the previous six days', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({
    state: { ...makeInitialState(DEFAULT_DURATIONS, dayAfter), completedSessions: 2, focusMinutes: 50 },
    now,
    days: {
      '2026-10-22': { completedSessions: 9, focusMinutes: 225 },
      '2026-10-23': { completedSessions: 2, focusMinutes: 50 }
    }
  });
  try {
    assert.match(app.elements['history-list'].innerHTML, /Today/);
    assert.match(app.elements['history-list'].innerHTML, /2 sessions/);
    assert.match(app.elements['history-list'].innerHTML, /Yesterday/);
    assert.match(app.elements['history-list'].innerHTML, /9 sessions/);
    assert.match(app.elements['history-list'].innerHTML, /225 minutes/);
    assert.equal((app.elements['history-list'].innerHTML.match(/history-row/g) ?? []).length, 7);
    assert.equal((app.elements['history-list'].innerHTML.match(/0 sessions/g) ?? []).length, 5);
  } finally { app.restore(); }
});

test('history filtering uses live current-day totals and ignores records outside the seven-day window', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({
    state: { ...makeInitialState(DEFAULT_DURATIONS, dayAfter), completedSessions: 3, focusMinutes: 75 },
    now,
    days: {
      '2026-10-23': { completedSessions: 99, focusMinutes: 999 },
      '2026-10-22': { completedSessions: 2, focusMinutes: 50 },
      '2026-10-15': { completedSessions: 8, focusMinutes: 200 }
    }
  });
  try {
    assert.match(app.elements['history-list'].innerHTML, /3 sessions/);
    assert.match(app.elements['history-list'].innerHTML, /75 minutes/);
    assert.doesNotMatch(app.elements['history-list'].innerHTML, /99 sessions|999 minutes|8 sessions|200 minutes/);
    assert.match(app.elements['history-list'].innerHTML, /2 sessions/);
    assert.match(app.elements['history-list'].innerHTML, /50 minutes/);
  } finally { app.restore(); }
});

test('control states and live status text follow start, pause, resume, and reset', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    assert.equal(app.elements['start-pause'].textContent, 'Start focus');
    assert.equal(app.elements['start-pause'].attributes['aria-pressed'], 'false');
    assert.equal(app.elements.reset.disabled, true);
    app.elements['start-pause'].dispatchEvent({ type: 'click' });
    assert.equal(app.elements['start-pause'].textContent, 'Pause focus');
    assert.equal(app.elements['start-pause'].attributes['aria-pressed'], 'true');
    assert.equal(app.elements['start-pause'].attributes['aria-label'], 'Pause focus timer');
    assert.equal(app.elements.status.textContent, 'Focus in progress.');
    app.elements['start-pause'].dispatchEvent({ type: 'click' });
    assert.equal(app.elements['start-pause'].textContent, 'Start focus');
    assert.equal(app.elements.status.textContent, 'Paused. Take a breath, then continue.');
    app.elements.reset.dispatchEvent({ type: 'click' });
    assert.equal(app.elements.reset.disabled, true);
    assert.equal(app.elements.status.textContent, 'Ready when you are.');
  } finally { app.restore(); }
});

test('pause and resume preserve the frozen remainder across a long gap, then reset restores the full duration', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    app.elements['start-pause'].click();
    now.value += 61_200;
    app.tick();
    assert.equal(app.elements.timer.textContent, '23:59');

    app.elements['start-pause'].click();
    now.value += 3 * 60 * 60 * 1000;
    app.elements['start-pause'].click();
    now.value += 10_001;
    app.tick();
    assert.equal(app.elements.timer.textContent, '23:49');
    assert.equal(app.elements.status.textContent, 'Focus in progress.');

    app.elements.reset.click();
    assert.equal(app.elements.timer.textContent, '25:00');
    assert.equal(app.elements['start-pause'].textContent, 'Start focus');
    assert.equal(app.elements.status.textContent, 'Ready when you are.');
  } finally { app.restore(); }
});

test('space and r keyboard shortcuts operate the timer and preserve accessible state text', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    const keydown = (event) => document.dispatchEvent({ target: { matches: () => false }, ...event });
    keydown({ type: 'keydown', code: 'Space', key: ' ' , preventDefault() {} });
    assert.equal(app.elements['start-pause'].textContent, 'Pause focus');
    assert.equal(app.elements['start-pause'].attributes['aria-pressed'], 'true');

    keydown({ type: 'keydown', code: 'Space', key: ' ', preventDefault() {} });
    assert.equal(app.elements.status.textContent, 'Paused. Take a breath, then continue.');
    keydown({ type: 'keydown', code: 'KeyR', key: 'r', preventDefault() {} });
    assert.equal(app.elements.timer.textContent, '25:00');
    assert.equal(app.elements.status.textContent, 'Ready when you are.');
  } finally { app.restore(); }
});

test('tablist arrow keys move focus and select the corresponding mode', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    let focused;
    app.focusTab.focus = () => { focused = 'focus'; };
    app.breakTab.focus = () => { focused = 'break'; };
    document.activeElement = app.focusTab;
    const event = { type: 'keydown', key: 'ArrowRight', preventDefault() {} };
    app.tablist.dispatchEvent(event);
    assert.equal(focused, 'break');
    assert.equal(app.elements.timer.textContent, '05:00');
    assert.equal(app.breakTab.attributes['aria-selected'], 'true');
    assert.equal(app.focusTab.attributes['aria-selected'], 'false');
  } finally { app.restore(); }
});

test('component remains usable when storage reads and writes fail', async () => {
  const now = { value: dayAfter };
  const failingStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now, storage: failingStorage });
  try {
    assert.equal(app.elements.timer.textContent, '25:00');
    assert.doesNotThrow(() => app.elements['start-pause'].click());
    assert.equal(app.elements['start-pause'].textContent, 'Pause focus');
  } finally { app.restore(); }
});

test('automatic completion still transitions when persistence fails', async () => {
  const now = { value: dayAfter };
  const failingStorage = {
    getItem() { return JSON.stringify({ version: 1, state: makeInitialState(DEFAULT_DURATIONS, dayAfter), days: {} }); },
    setItem() { throw new Error('quota exceeded'); }
  };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now, storage: failingStorage });
  try {
    app.elements['start-pause'].click();
    now.value += 25 * 60 * 1000;
    assert.doesNotThrow(() => app.tick());
    assert.equal(app.elements.timer.textContent, '05:00');
    assert.equal(app.elements['completed-count'].textContent, 1);
    assert.equal(app.elements['focus-minutes'].textContent, 25);
    assert.equal(app.elements['start-pause'].textContent, 'Start break');
  } finally { app.restore(); }
});

test('break completion transitions back to focus without recording another focus session', async () => {
  const now = { value: dayAfter };
  const app = await loadApp({ state: makeInitialState(DEFAULT_DURATIONS, dayAfter), now });
  try {
    app.breakTab.dispatchEvent({ type: 'click' });
    app.elements['start-pause'].dispatchEvent({ type: 'click' });
    now.value += 5 * 60 * 1000;
    app.tick();
    assert.equal(app.elements.timer.textContent, '25:00');
    assert.equal(app.elements['start-pause'].textContent, 'Start focus');
    assert.equal(app.elements['completed-count'].textContent, 0);
    assert.equal(app.elements['focus-minutes'].textContent, 0);
    app.tick();
    assert.equal(app.elements['completed-count'].textContent, 0);
  } finally { app.restore(); }
});
