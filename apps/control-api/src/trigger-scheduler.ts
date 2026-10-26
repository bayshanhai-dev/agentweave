import { randomUUID } from "node:crypto";
import { Cron } from "croner";

export type TriggerKind = "schedule" | "api";
export type TriggerTargetMode = "workstream" | "create";
export type TriggerFireStatus = "fired" | "skipped" | "coalesced" | "failed";

export type Trigger = {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  cronExpr?: string;
  timezone: string;
  targetMode: TriggerTargetMode;
  targetWorkstreamId?: string;
  templateId?: string;
  goalTemplate?: string;
  dutyTitle: string;
  dutyPrompt: string;
  stateKey?: string;
  priority: number;
  maxRunsPerDay?: number;
  maxOpenTasks?: number;
  quietStart?: string;
  quietEnd?: string;
  batchWindowSec: number;
  overlapPolicy: "skip" | "allow";
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TriggerFire = {
  id: string;
  triggerId: string;
  slotKey: string;
  status: TriggerFireStatus;
  reason?: string;
  workstreamId?: string;
  messageId?: string;
  dutyTaskId?: string;
  firedAt: string;
};

export type FireDecision =
  | { action: "fire" }
  | { action: "skip"; reason: string };

export interface TriggerStore {
  listEnabled(): Promise<Trigger[]>;
  listFiresSince(since: Date): Promise<TriggerFire[]>;
  findFire(
    triggerId: string,
    slotKey: string,
  ): Promise<TriggerFire | undefined>;
  insertFire(fire: TriggerFire): Promise<boolean>;
  updateFire(
    id: string,
    update: {
      status: TriggerFireStatus;
      reason?: string;
      workstreamId?: string;
      messageId?: string;
      dutyTaskId?: string;
    },
  ): Promise<void>;
  updateLastFiredAt(id: string, firedAt: string): Promise<void>;
  findLatestBatchFire(
    triggerId: string,
    since: Date,
  ): Promise<TriggerFire | undefined>;
  hasOpenOverlap(trigger: Trigger): Promise<boolean>;
  countOpenTasks(trigger: Trigger): Promise<number>;
}

export type TriggerFireAction = (
  trigger: Trigger,
  input: { fireId: string; payload: string; now: Date },
) => Promise<{
  workstreamId?: string;
  messageId?: string;
  dutyTaskId?: string;
}>;

export type TriggerCoalesceAction = (
  trigger: Trigger,
  priorFire: TriggerFire,
  input: { fireId: string; payload: string; now: Date },
) => Promise<void>;

export type TriggerSchedulerOptions = {
  now?: () => Date;
  createId?: () => string;
  globalDailyMax?: number;
  stormMax10Min?: number;
  onSkipped?: (trigger: Trigger, reason: string) => void | Promise<void>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

function zonedParts(now: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function localDate(now: Date, timezone: string): string {
  const parts = zonedParts(now, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localMinute(now: Date, timezone: string): number {
  const parts = zonedParts(now, timezone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function parseClock(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

export function scheduleSlot(trigger: Trigger, now: Date): Date | undefined {
  if (trigger.kind !== "schedule" || !trigger.cronExpr) return undefined;
  return new Cron(trigger.cronExpr, {
    timezone: trigger.timezone,
  }).previousRuns(1, new Date(now.getTime() + 1_000))[0];
}

export function scheduleSlotKey(
  trigger: Trigger,
  now: Date,
): string | undefined {
  const slot = scheduleSlot(trigger, now);
  return slot ? `${trigger.id}:${slot.toISOString()}` : undefined;
}

export function nextFireAt(trigger: Trigger, now: Date): string | undefined {
  if (trigger.kind !== "schedule" || !trigger.cronExpr) return undefined;
  return new Cron(trigger.cronExpr, { timezone: trigger.timezone })
    .nextRun(now)
    ?.toISOString();
}

export function isDue(
  trigger: Trigger,
  now: Date,
  fires: TriggerFire[] = [],
): boolean {
  const slotKey = scheduleSlotKey(trigger, now);
  return Boolean(
    slotKey &&
      !fires.some(
        (fire) => fire.triggerId === trigger.id && fire.slotKey === slotKey,
      ),
  );
}

export function inQuietHours(trigger: Trigger, now: Date): boolean {
  if (!trigger.quietStart || !trigger.quietEnd) return false;
  const current = localMinute(now, trigger.timezone);
  const start = parseClock(trigger.quietStart);
  const end = parseClock(trigger.quietEnd);
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function runsToday(
  fires: TriggerFire[],
  trigger: Trigger,
  now: Date,
): number {
  const today = localDate(now, trigger.timezone);
  return fires.filter(
    (fire) =>
      fire.triggerId === trigger.id &&
      fire.status === "fired" &&
      localDate(new Date(fire.firedAt), trigger.timezone) === today,
  ).length;
}

export function decideFire(
  trigger: Trigger,
  now: Date,
  fires: TriggerFire[],
  input: { slotKey: string; overlap: boolean; openTasks?: number },
): FireDecision {
  if (
    fires.some(
      (fire) => fire.triggerId === trigger.id && fire.slotKey === input.slotKey,
    )
  ) {
    return { action: "skip", reason: "duplicate" };
  }
  if (inQuietHours(trigger, now))
    return { action: "skip", reason: "quiet-hours" };
  if (
    trigger.maxRunsPerDay !== undefined &&
    runsToday(fires, trigger, now) >= trigger.maxRunsPerDay
  ) {
    return { action: "skip", reason: "daily-cap" };
  }
  // Load gate (#131): a target that already holds maxOpenTasks open tasks
  // gets no new duty this slot; the skip is recorded with reason "busy".
  if (
    trigger.maxOpenTasks !== undefined &&
    input.openTasks !== undefined &&
    input.openTasks >= trigger.maxOpenTasks
  ) {
    return { action: "skip", reason: "busy" };
  }
  if (trigger.overlapPolicy === "skip" && input.overlap)
    return { action: "skip", reason: "overlap" };
  return { action: "fire" };
}

export function sortTriggers(triggers: Trigger[]): Trigger[] {
  return [...triggers].sort(
    (left, right) =>
      right.priority - left.priority || left.name.localeCompare(right.name),
  );
}

export function substituteTriggerText(
  template: string,
  trigger: Trigger,
  now: Date,
  payload: string,
  cap?: number,
): string {
  const value = template
    .replaceAll("{{date}}", localDate(now, trigger.timezone))
    .replaceAll("{{payload}}", payload);
  return cap === undefined ? value : value.slice(0, cap);
}

export function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateCron(expression: string, timezone: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false;
  try {
    return Boolean(new Cron(expression, { timezone }).nextRun());
  } catch {
    return false;
  }
}

export function validClock(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export class TriggerScheduler {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly globalDailyMax: number;
  private readonly stormMax10Min: number;

  constructor(
    private readonly store: TriggerStore,
    private readonly fireAction: TriggerFireAction,
    private readonly coalesceAction: TriggerCoalesceAction,
    private readonly options: TriggerSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.globalDailyMax = options.globalDailyMax ?? 200;
    this.stormMax10Min = options.stormMax10Min ?? 20;
  }

  async tick(): Promise<TriggerFire[]> {
    const now = this.now();
    const triggers = sortTriggers(await this.store.listEnabled()).filter(
      (trigger) => trigger.kind === "schedule",
    );
    const fires = await this.store.listFiresSince(
      new Date(now.getTime() - 48 * 60 * 60 * 1_000),
    );
    const utcDayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const firedToday = fires.filter(
      (fire) =>
        fire.status === "fired" && Date.parse(fire.firedAt) >= utcDayStart,
    ).length;
    const firedRecently = fires.filter(
      (fire) =>
        fire.status === "fired" &&
        Date.parse(fire.firedAt) >= now.getTime() - 10 * 60_000,
    ).length;
    const globalReason =
      firedToday >= this.globalDailyMax
        ? "global-daily-cap"
        : firedRecently > this.stormMax10Min
          ? "storm-breaker"
          : undefined;
    if (globalReason === "global-daily-cap") {
      this.options.warn?.("Trigger global daily cap reached", {
        firedToday,
        maximum: this.globalDailyMax,
      });
    }
    if (globalReason === "storm-breaker") {
      this.options.warn?.("Trigger storm breaker opened", {
        firedRecently,
        maximum: this.stormMax10Min,
      });
    }

    const recorded: TriggerFire[] = [];
    for (const trigger of triggers) {
      const slotKey = scheduleSlotKey(trigger, now);
      if (
        !slotKey ||
        fires.some(
          (fire) => fire.triggerId === trigger.id && fire.slotKey === slotKey,
        )
      )
        continue;
      if (globalReason) {
        const skipped = await this.recordSkipped(
          trigger,
          slotKey,
          globalReason,
          now,
        );
        if (skipped) {
          fires.push(skipped);
          recorded.push(skipped);
        }
        continue;
      }
      const result = await this.run(trigger, {
        slotKey,
        payload: "",
        now,
        fires,
      });
      if (result) {
        fires.push(result);
        recorded.push(result);
      }
    }
    return recorded;
  }

  async fireNow(
    trigger: Trigger,
    input: { idempotencyKey?: string; payload?: string } = {},
  ): Promise<TriggerFire> {
    const now = this.now();
    const slotKey = input.idempotencyKey?.trim() || this.createId();
    const existing = await this.store.findFire(trigger.id, slotKey);
    if (existing) return existing;
    const fires = await this.store.listFiresSince(
      new Date(now.getTime() - 48 * 60 * 60 * 1_000),
    );
    const payload = input.payload ?? "";
    const utcDayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const firedToday = fires.filter(
      (fire) =>
        fire.status === "fired" && Date.parse(fire.firedAt) >= utcDayStart,
    ).length;
    const firedRecently = fires.filter(
      (fire) =>
        fire.status === "fired" &&
        Date.parse(fire.firedAt) >= now.getTime() - 10 * 60_000,
    ).length;
    const globalReason =
      firedToday >= this.globalDailyMax
        ? "global-daily-cap"
        : firedRecently > this.stormMax10Min
          ? "storm-breaker"
          : undefined;
    if (globalReason) {
      if (globalReason === "storm-breaker")
        this.options.warn?.("Trigger storm breaker opened", {
          firedRecently,
          maximum: this.stormMax10Min,
        });
      else
        this.options.warn?.("Trigger global daily cap reached", {
          firedToday,
          maximum: this.globalDailyMax,
        });
      return (
        (await this.recordSkipped(trigger, slotKey, globalReason, now)) ??
        (await this.store.findFire(trigger.id, slotKey))!
      );
    }

    if (
      !inQuietHours(trigger, now) &&
      (trigger.maxRunsPerDay === undefined ||
        runsToday(fires, trigger, now) < trigger.maxRunsPerDay) &&
      trigger.kind === "api" &&
      trigger.batchWindowSec > 0
    ) {
      const prior = await this.store.findLatestBatchFire(
        trigger.id,
        new Date(now.getTime() - trigger.batchWindowSec * 1_000),
      );
      if (prior) return this.coalesce(trigger, prior, slotKey, payload, now);
    }

    const result = await this.run(trigger, { slotKey, payload, now, fires });
    return result ?? (await this.store.findFire(trigger.id, slotKey))!;
  }

  private async run(
    trigger: Trigger,
    input: {
      slotKey: string;
      payload: string;
      now: Date;
      fires: TriggerFire[];
    },
  ): Promise<TriggerFire | undefined> {
    const overlap =
      trigger.overlapPolicy === "skip"
        ? await this.store.hasOpenOverlap(trigger)
        : false;
    const openTasks =
      trigger.maxOpenTasks !== undefined
        ? await this.store.countOpenTasks(trigger)
        : undefined;
    const decision = decideFire(trigger, input.now, input.fires, {
      slotKey: input.slotKey,
      overlap,
      ...(openTasks !== undefined ? { openTasks } : {}),
    });
    if (decision.action === "skip") {
      if (decision.reason === "duplicate") return undefined;
      return this.recordSkipped(
        trigger,
        input.slotKey,
        decision.reason,
        input.now,
      );
    }

    const fire: TriggerFire = {
      id: this.createId(),
      triggerId: trigger.id,
      slotKey: input.slotKey,
      status: "fired",
      firedAt: input.now.toISOString(),
    };
    if (!(await this.store.insertFire(fire)))
      return this.store.findFire(trigger.id, input.slotKey);
    try {
      const result = await this.fireAction(trigger, {
        fireId: fire.id,
        payload: input.payload,
        now: input.now,
      });
      const update = { status: "fired" as const, ...result };
      await this.store.updateFire(fire.id, update);
      await this.store.updateLastFiredAt(trigger.id, fire.firedAt);
      return { ...fire, ...result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.updateFire(fire.id, { status: "failed", reason });
      return { ...fire, status: "failed", reason };
    }
  }

  private async recordSkipped(
    trigger: Trigger,
    slotKey: string,
    reason: string,
    now: Date,
  ): Promise<TriggerFire | undefined> {
    const fire: TriggerFire = {
      id: this.createId(),
      triggerId: trigger.id,
      slotKey,
      status: "skipped",
      reason,
      firedAt: now.toISOString(),
    };
    if (!(await this.store.insertFire(fire))) return undefined;
    await this.options.onSkipped?.(trigger, reason);
    return fire;
  }

  private async coalesce(
    trigger: Trigger,
    prior: TriggerFire,
    slotKey: string,
    payload: string,
    now: Date,
  ): Promise<TriggerFire> {
    const fire: TriggerFire = {
      id: this.createId(),
      triggerId: trigger.id,
      slotKey,
      status: "coalesced",
      reason: `batched-with:${prior.id}`,
      ...(prior.workstreamId ? { workstreamId: prior.workstreamId } : {}),
      ...(prior.messageId ? { messageId: prior.messageId } : {}),
      ...(prior.dutyTaskId ? { dutyTaskId: prior.dutyTaskId } : {}),
      firedAt: now.toISOString(),
    };
    if (!(await this.store.insertFire(fire)))
      return (await this.store.findFire(trigger.id, slotKey))!;
    try {
      // Appending an extra message to the existing duty is the deliberately simpler
      // batching path allowed by the product brief; it preserves every payload.
      await this.coalesceAction(trigger, prior, {
        fireId: fire.id,
        payload,
        now,
      });
      return fire;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.updateFire(fire.id, {
        status: "failed",
        reason,
        ...(prior.workstreamId ? { workstreamId: prior.workstreamId } : {}),
        ...(prior.messageId ? { messageId: prior.messageId } : {}),
        ...(prior.dutyTaskId ? { dutyTaskId: prior.dutyTaskId } : {}),
      });
      return { ...fire, status: "failed", reason };
    }
  }
}
