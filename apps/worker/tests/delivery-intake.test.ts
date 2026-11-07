import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  processDeliveryHandoffIfPresent,
  readDeliveryConfig,
  type DeliveryConfig,
  type DeliveryExecutorLike,
} from "../src/delivery-intake.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentweave-intake-"));
  roots.push(root);
  await mkdirForHandoff(root);
  return root;
}

async function mkdirForHandoff(root: string): Promise<void> {
  await (await import("node:fs/promises")).mkdir(join(root, ".agentweave"), {
    recursive: true,
  });
}

function enabledConfig(root: string): Extract<DeliveryConfig, { enabled: true }> {
  return {
    enabled: true,
    deliveryRoot: join(root, "delivery-root"),
    secretFile: join(root, "secret.json"),
    secretStore: "box-secret-store",
    repository: { host: "github.com", owner: "bayshanhai-dev", name: "agentweave" },
    controlApiUrl: "http://control-api:3000",
  };
}

function blockedExecutor(): DeliveryExecutorLike {
  return {
    execute: vi.fn(async () => ({
      status: "blocked" as const,
      report: {
        event: "delivery.blocked" as const,
        schema: "delivery-path/v1" as const,
        task_id: "issue-146",
        workstream_id: "owner-team",
        run_id: "run-1",
        status: "BLOCKED" as const,
        reason: "credential_unprovisioned",
        attempted_action: "resolve_credential",
        evidence: "delivery-receipt:key",
        next_owner: "human_deputy" as const,
        next_action: "Provision the credential.",
        blocked_since: "2026-11-06T00:00:00.000Z",
      },
    })),
  };
}

describe("readDeliveryConfig", () => {
  it("is disabled without requiring delivery variables", () => {
    expect(readDeliveryConfig({})).toEqual({ enabled: false });
  });

  it("uses the production defaults when enabled", () => {
    expect(
      readDeliveryConfig({
        AGENTWEAVE_DELIVERY_ENABLED: "true",
        AGENTWEAVE_DELIVERY_ROOT: "/var/lib/agentweave/delivery",
        AGENTWEAVE_DELIVERY_SECRET_FILE: "/etc/agentweave/secrets.json",
      }),
    ).toMatchObject({
      enabled: true,
      secretStore: "box-secret-store",
      repository: { owner: "bayshanhai-dev", name: "agentweave" },
    });
  });
});

describe("processDeliveryHandoffIfPresent", () => {
  it("does not construct an executor while disabled", async () => {
    const root = await workspace();
    const createExecutor = vi.fn();
    await expect(
      processDeliveryHandoffIfPresent(
        { config: { enabled: false }, createExecutor },
        { workspacePath: root, workstreamId: "owner-team", taskId: "issue-146" },
      ),
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("skips without constructing an executor when no handoff is present", async () => {
    const root = await workspace();
    const createExecutor = vi.fn();
    await expect(
      processDeliveryHandoffIfPresent(
        { config: enabledConfig(root), createExecutor },
        { workspacePath: root, workstreamId: "owner-team", taskId: "issue-146" },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "handoff_absent" });
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("executes a handoff once and archives it after a terminal result", async () => {
    const root = await workspace();
    const input = {
      idempotency_key: `sha256:${"a".repeat(64)}`,
      task_id: "issue-146",
    };
    const executor = blockedExecutor();
    const createExecutor = vi.fn(() => executor);
    const log = vi.fn();
    await writeFile(
      join(root, ".agentweave", "delivery-handoff.json"),
      JSON.stringify(input),
    );
    const result = await processDeliveryHandoffIfPresent(
      { config: enabledConfig(root), createExecutor, log },
      { workspacePath: root, workstreamId: "owner-team", taskId: "issue-146" },
    );
    expect(result?.status).toBe("blocked");
    expect(createExecutor).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await expect(
      access(
        join(
          root,
          ".agentweave",
          "delivered",
          `${input.idempotency_key.replaceAll(":", "_")}.json`,
        ),
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "worker.delivery.scanned" }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "worker.delivery.blocked" }));
  });

  it("leaves malformed JSON in place and swallows executor failures", async () => {
    const root = await workspace();
    const handoffPath = join(root, ".agentweave", "delivery-handoff.json");
    await writeFile(handoffPath, "{not-json");
    const log = vi.fn();
    await expect(
      processDeliveryHandoffIfPresent(
        { config: enabledConfig(root), createExecutor: vi.fn(), log },
        { workspacePath: root, workstreamId: "owner-team", taskId: "issue-146" },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "handoff_unparseable" });
    await expect(readFile(handoffPath, "utf8")).resolves.toBe("{not-json");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker.delivery.handoff_unparseable" }),
    );

    await writeFile(handoffPath, JSON.stringify({ idempotency_key: "key" }));
    const throwingExecutor: DeliveryExecutorLike = {
      execute: vi.fn(async () => {
        throw new Error("remote failure");
      }),
    };
    await expect(
      processDeliveryHandoffIfPresent(
        { config: enabledConfig(root), executor: throwingExecutor, log },
        { workspacePath: root, workstreamId: "owner-team", taskId: "issue-146" },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "executor_failed" });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker.delivery.blocked", reason: "executor_failed" }),
    );
  });
});

