import { describe, expect, it } from "vitest";
import {
  decideFire,
  inQuietHours,
  isDue,
  localDate,
  runsToday,
  scheduleSlotKey,
  sortTriggers,
  substituteTriggerText,
  TriggerScheduler,
  type Trigger,
  type TriggerFire,
  type TriggerFireStatus,
  type TriggerStore,
} from "../src/trigger-scheduler.js";

const now = new Date("2026-01-15T14:00:30.000Z");

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "trigger-1",
    name: "Morning duty",
    enabled: true,
    kind: "schedule",
    cronExpr: "0 9 * * *",
    timezone: "America/New_York",
    targetMode: "workstream",
    targetWorkstreamId: "ws-1",
    dutyTitle: "Check production",
    dutyPrompt: "Check {{date}} {{payload}}",
    priority: 0,
    batchWindowSec: 0,
    overlapPolicy: "skip",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fire(overrides: Partial<TriggerFire> = {}): TriggerFire {
  return {
    id: "fire-1",
    triggerId: "trigger-1",
    slotKey: "slot-1",
    status: "fired",
    firedAt: now.toISOString(),
    ...overrides,
  };
}

class FakeStore implements TriggerStore {
  fires: TriggerFire[] = [];
  overlapIds = new Set<string>();
  constructor(public triggers: Trigger[] = []) {}
  async listEnabled() {
    return this.triggers.filter((item) => item.enabled);
  }
  async listFiresSince(since: Date) {
    return this.fires.filter(
      (item) => Date.parse(item.firedAt) >= since.getTime(),
    );
  }
  async findFire(triggerId: string, slotKey: string) {
    return this.fires.find(
      (item) => item.triggerId === triggerId && item.slotKey === slotKey,
    );
  }
  async insertFire(candidate: TriggerFire) {
    if (await this.findFire(candidate.triggerId, candidate.slotKey))
      return false;
    this.fires.push(candidate);
    return true;
  }
  async updateFire(
    id: string,
    update: {
      status: TriggerFireStatus;
      reason?: string;
      workstreamId?: string;
      messageId?: string;
    },
  ) {
    const index = this.fires.findIndex((item) => item.id === id);
    if (index >= 0) this.fires[index] = { ...this.fires[index]!, ...update };
  }
  async updateLastFiredAt(id: string, firedAt: string) {
    const item = this.triggers.find((candidate) => candidate.id === id);
    if (item) item.lastFiredAt = firedAt;
  }
  async findLatestBatchFire(triggerId: string, since: Date) {
    return [...this.fires]
      .reverse()
      .find(
        (item) =>
          item.triggerId === triggerId &&
          item.status === "fired" &&
          Date.parse(item.firedAt) >= since.getTime(),
      );
  }
  async hasOpenOverlap(candidate: Trigger) {
    return this.overlapIds.has(candidate.id);
  }
}

function scheduler(
  store: FakeStore,
  calls: string[] = [],
  options: ConstructorParameters<typeof TriggerScheduler>[3] = {},
) {
  let id = 0;
  return new TriggerScheduler(
    store,
    async (candidate) => {
      calls.push(candidate.id);
      return {
        workstreamId: candidate.targetWorkstreamId ?? `ws-${candidate.id}`,
        messageId: `message-${candidate.id}`,
      };
    },
    async (candidate) => {
      calls.push(`coalesced:${candidate.id}`);
    },
    { now: () => now, createId: () => `generated-${++id}`, ...options },
  );
}

describe("trigger decision core", () => {
  it("computes due slots in the trigger timezone and suppresses an existing slot", () => {
    const newYork = trigger();
    const tokyo = trigger({
      id: "tokyo",
      cronExpr: "0 23 * * *",
      timezone: "Asia/Tokyo",
    });
    expect(scheduleSlotKey(newYork, now)).toBe(
      "trigger-1:2026-01-15T14:00:00.000Z",
    );
    expect(scheduleSlotKey(tokyo, now)).toBe("tokyo:2026-01-15T14:00:00.000Z");
    expect(isDue(newYork, now)).toBe(true);
    expect(
      isDue(newYork, now, [fire({ slotKey: scheduleSlotKey(newYork, now)! })]),
    ).toBe(false);
  });

  it("handles ordinary and wrap-midnight quiet windows", () => {
    expect(
      inQuietHours(trigger({ quietStart: "08:00", quietEnd: "10:00" }), now),
    ).toBe(true);
    expect(
      inQuietHours(
        trigger({ quietStart: "22:00", quietEnd: "07:00" }),
        new Date("2026-01-15T10:30:00Z"),
      ),
    ).toBe(true);
    expect(
      inQuietHours(trigger({ quietStart: "22:00", quietEnd: "07:00" }), now),
    ).toBe(false);
  });

  it("counts successful runs by local calendar date and enforces the daily cap", () => {
    const capped = trigger({ maxRunsPerDay: 1 });
    const fires = [fire({ firedAt: "2026-01-15T05:30:00.000Z" })]; // Jan 15 UTC, Jan 15 00:30 in New York
    expect(localDate(new Date(fires[0]!.firedAt), capped.timezone)).toBe(
      "2026-01-15",
    );
    expect(runsToday(fires, capped, now)).toBe(1);
    expect(
      decideFire(capped, now, fires, { slotKey: "new-slot", overlap: false }),
    ).toEqual({ action: "skip", reason: "daily-cap" });
  });

  it("prioritizes duplicate, quiet-hours, cap, and overlap decisions deterministically", () => {
    const candidate = trigger({
      quietStart: "08:00",
      quietEnd: "10:00",
      maxRunsPerDay: 1,
    });
    expect(
      decideFire(candidate, now, [fire({ slotKey: "same" })], {
        slotKey: "same",
        overlap: true,
      }),
    ).toEqual({ action: "skip", reason: "duplicate" });
    expect(
      decideFire(candidate, now, [], { slotKey: "new", overlap: true }),
    ).toEqual({ action: "skip", reason: "quiet-hours" });
    expect(
      decideFire(trigger(), now, [], { slotKey: "new", overlap: true }),
    ).toEqual({ action: "skip", reason: "overlap" });
  });

  it("sorts by descending priority then name and substitutes capped text", () => {
    expect(
      sortTriggers([
        trigger({ id: "b", name: "Beta", priority: 2 }),
        trigger({ id: "a", name: "Alpha", priority: 2 }),
        trigger({ id: "c", name: "Critical", priority: 9 }),
      ]).map((item) => item.id),
    ).toEqual(["c", "a", "b"]);
    expect(
      substituteTriggerText(
        "{{date}}/{{payload}}",
        trigger(),
        now,
        "payload",
        12,
      ),
    ).toBe("2026-01-15/p");
  });
});

describe("TriggerScheduler", () => {
  it("fires due triggers in priority order and records each slot once", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      trigger({ id: "low", name: "Low", priority: 1 }),
      trigger({ id: "high", name: "High", priority: 9 }),
    ]);
    const service = scheduler(store, calls);
    await service.tick();
    await service.tick();
    expect(calls).toEqual(["high", "low"]);
    expect(store.fires).toHaveLength(2);
  });

  it("audits every due trigger when the global daily cap is reached", async () => {
    const store = new FakeStore([
      trigger(),
      trigger({ id: "trigger-2", name: "Second" }),
    ]);
    store.fires = [fire({ id: "prior", triggerId: "old", slotKey: "old" })];
    const recorded = await scheduler(store, [], { globalDailyMax: 1 }).tick();
    expect(recorded.map((item) => item.reason)).toEqual([
      "global-daily-cap",
      "global-daily-cap",
    ]);
  });

  it("opens the storm breaker only above the ten-minute threshold and warns", async () => {
    const store = new FakeStore([trigger()]);
    store.fires = Array.from({ length: 3 }, (_, index) =>
      fire({
        id: `prior-${index}`,
        triggerId: `old-${index}`,
        slotKey: `old-${index}`,
      }),
    );
    const warnings: string[] = [];
    const recorded = await scheduler(store, [], {
      stormMax10Min: 2,
      warn: (message) => warnings.push(message),
    }).tick();
    expect(recorded[0]?.reason).toBe("storm-breaker");
    expect(warnings).toEqual(["Trigger storm breaker opened"]);
  });

  it("does not open the storm breaker at the ten-minute threshold", async () => {
    const calls: string[] = [];
    const store = new FakeStore([trigger()]);
    store.fires = Array.from({ length: 2 }, (_, index) =>
      fire({
        id: `prior-${index}`,
        triggerId: `old-${index}`,
        slotKey: `old-${index}`,
      }),
    );
    const recorded = await scheduler(store, calls, { stormMax10Min: 2 }).tick();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("fired");
    expect(calls).toEqual(["trigger-1"]);
  });

  it("coalesces an API burst before the overlap gate and preserves its audit link", async () => {
    const apiTrigger = trigger({
      kind: "api",
      cronExpr: undefined,
      batchWindowSec: 60,
    });
    const store = new FakeStore([apiTrigger]);
    store.fires = [
      fire({
        workstreamId: "ws-1",
        messageId: "message-1",
        firedAt: new Date(now.getTime() - 10_000).toISOString(),
      }),
    ];
    store.overlapIds.add(apiTrigger.id);
    const calls: string[] = [];
    const result = await scheduler(store, calls).fireNow(apiTrigger, {
      idempotencyKey: "incoming",
      payload: "two",
    });
    expect(result).toMatchObject({
      status: "coalesced",
      workstreamId: "ws-1",
      messageId: "message-1",
    });
    expect(calls).toEqual(["coalesced:trigger-1"]);
  });

  it("skips overlap for both existing and create target modes", async () => {
    const existing = trigger({ id: "existing" });
    const create = trigger({
      id: "create",
      targetMode: "create",
      targetWorkstreamId: undefined,
      templateId: "software-development",
      goalTemplate: "Goal",
    });
    const store = new FakeStore([existing, create]);
    store.overlapIds.add(existing.id);
    store.overlapIds.add(create.id);
    const service = scheduler(store);
    expect(
      await service.fireNow(existing, { idempotencyKey: "one" }),
    ).toMatchObject({ status: "skipped", reason: "overlap" });
    expect(
      await service.fireNow(create, { idempotencyKey: "two" }),
    ).toMatchObject({ status: "skipped", reason: "overlap" });
  });

  it("returns the original audit record for a repeated idempotency key", async () => {
    const apiTrigger = trigger({ kind: "api", cronExpr: undefined });
    const store = new FakeStore([apiTrigger]);
    const calls: string[] = [];
    const service = scheduler(store, calls);
    const first = await service.fireNow(apiTrigger, { idempotencyKey: "same" });
    const second = await service.fireNow(apiTrigger, {
      idempotencyKey: "same",
    });
    expect(second.id).toBe(first.id);
    expect(calls).toHaveLength(1);
  });

  it("records an action failure without rejecting the scheduler tick", async () => {
    const store = new FakeStore([trigger()]);
    const service = new TriggerScheduler(
      store,
      async () => {
        throw new Error("target-workstream-not-found");
      },
      async () => undefined,
      { now: () => now, createId: () => "failed-fire" },
    );
    await expect(service.tick()).resolves.toMatchObject([
      { status: "failed", reason: "target-workstream-not-found" },
    ]);
  });
});
