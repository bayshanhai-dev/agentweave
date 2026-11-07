import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DenyAllDeliveryAuthorizer } from "../../src/delivery/authorization.js";
import type {
  DeliveryGitClient,
  PullRequestClient,
} from "../../src/delivery/clients.js";
import { DeliveryExecutor } from "../../src/delivery/executor.js";
import type { DeliveryHandoff } from "../../src/delivery/handoff.js";
import { FileDeliveryReceiptStore } from "../../src/delivery/receipt-store.js";
import type { SecretStoreAdapter } from "../../src/delivery/secret-store.js";
import {
  NOW,
  RecordingReportPublisher,
  createFixture,
  createHandoff,
  type Fixture,
} from "./helpers.js";

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function validationExecutor(
  fixture: Fixture,
  reports: RecordingReportPublisher,
): DeliveryExecutor {
  const git: DeliveryGitClient = {
    findRemoteBranch: vi.fn(),
    hasLocalCommit: vi.fn(),
    createCommit: vi.fn(),
    push: vi.fn(),
  };
  const pullRequests: PullRequestClient = {
    findOpenPullRequest: vi.fn(),
    openPullRequest: vi.fn(),
  };
  const secrets: SecretStoreAdapter = {
    store: "box-secret-store",
    resolve: vi.fn(),
  };
  return new DeliveryExecutor({
    authorizer: new DenyAllDeliveryAuthorizer(),
    receipts: new FileDeliveryReceiptStore({
      path: fixture.receiptPath,
      workspaceRoot: fixture.workspace,
    }),
    secrets,
    git,
    pullRequests,
    reports,
    now: () => NOW,
  });
}

describe("delivery-path/v1 validation", () => {
  it("turns every malformed, stale, escaped, ambiguous, or credential-bearing handoff into a visible blocked report", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "change.txt"), "change\n");
    await writeFile(join(fixture.root, "outside.txt"), "outside\n");
    await symlink(
      join(fixture.root, "outside.txt"),
      join(fixture.workspace, "escape.txt"),
    );
    const base = await createHandoff(fixture.workspace, ["change.txt"]);
    const reports = new RecordingReportPublisher();
    const executor = validationExecutor(fixture, reports);

    const cases: Array<{
      name: string;
      expected: string;
      mutate(value: Record<string, unknown>): void;
    }> = [
      {
        name: "missing required field",
        expected: "malformed_handoff",
        mutate: (value) => {
          delete value.branch;
        },
      },
      {
        name: "expired handoff",
        expected: "expired_handoff",
        mutate: (value) => {
          value.expires_at = "2026-11-04T11:30:00.000Z";
        },
      },
      {
        name: "absolute path",
        expected: "invalid_changed_path",
        mutate: (value) => {
          value.changed_files = ["/etc/passwd"];
        },
      },
      {
        name: "parent path escape",
        expected: "invalid_changed_path",
        mutate: (value) => {
          value.changed_files = ["../outside.txt"];
        },
      },
      {
        name: "non-normalized path",
        expected: "invalid_changed_path",
        mutate: (value) => {
          value.changed_files = ["folder/../change.txt"];
        },
      },
      {
        name: "duplicate path",
        expected: "duplicate_changed_path",
        mutate: (value) => {
          value.changed_files = ["change.txt", "change.txt"];
        },
      },
      {
        name: "symlink escape",
        expected: "path_escape",
        mutate: (value) => {
          value.changed_files = ["escape.txt"];
        },
      },
      {
        name: "empty unbounded scope",
        expected: "unbounded_file_scope",
        mutate: (value) => {
          value.changed_files = [];
        },
      },
      {
        name: "oversized unbounded scope",
        expected: "unbounded_file_scope",
        mutate: (value) => {
          value.changed_files = Array.from(
            { length: 1_001 },
            (_, index) => `file-${index}.txt`,
          );
        },
      },
      {
        name: "invalid requested actor",
        expected: "invalid_requested_actor",
        mutate: (value) => {
          value.requested_actor = "agent";
        },
      },
      {
        name: "credential value",
        expected: "credential_value_forbidden",
        mutate: (value) => {
          (value.credential_ref as Record<string, unknown>).value = "forbidden";
        },
      },
      {
        name: "credential-bearing extra field",
        expected: "malformed_handoff",
        mutate: (value) => {
          (value.credential_ref as Record<string, unknown>).token = "forbidden";
        },
      },
      {
        name: "invalid idempotency key",
        expected: "invalid_idempotency_key",
        mutate: (value) => {
          value.idempotency_key = "not-a-digest";
        },
      },
    ];

    for (const testCase of cases) {
      const value = structuredClone(base) as unknown as Record<string, unknown>;
      testCase.mutate(value);
      const result = await executor.execute(value, {
        workspaceRoot: fixture.workspace,
        workstreamId: "owner-team",
      });
      expect(result.status, testCase.name).toBe("blocked");
      expect(result.report.reason, testCase.name).toBe(testCase.expected);
      expect(result.report.status, testCase.name).toBe("BLOCKED");
      expect(reports.calls.at(-1)?.report, testCase.name).toEqual(
        result.report,
      );
    }

    expect(Object.keys(reports.calls[0]!.report).sort()).toEqual(
      [
        "event",
        "schema",
        "task_id",
        "workstream_id",
        "run_id",
        "status",
        "reason",
        "attempted_action",
        "evidence",
        "next_owner",
        "next_action",
        "blocked_since",
      ].sort(),
    );
  });

  it("rejects a changed manifest when a run_id is reused", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "change.txt"), "one\n");
    const first = await createHandoff(fixture.workspace, ["change.txt"]);
    const receipts = new FileDeliveryReceiptStore({
      path: fixture.receiptPath,
      workspaceRoot: fixture.workspace,
    });
    const { validateDeliveryHandoff } =
      await import("../../src/delivery/handoff.js");
    const validatedFirst = await validateDeliveryHandoff(first, {
      workspaceRoot: fixture.workspace,
      now: NOW,
    });
    await receipts.accept(validatedFirst);

    await writeFile(join(fixture.workspace, "change.txt"), "two\n");
    const second = await createHandoff(fixture.workspace, ["change.txt"]);
    const validatedSecond = await validateDeliveryHandoff(second, {
      workspaceRoot: fixture.workspace,
      now: NOW,
    });
    await expect(receipts.accept(validatedSecond)).rejects.toMatchObject({
      code: "run_id_reused",
    });
  });
});
