import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticDeliveryAuthorizer } from "../../src/delivery/authorization.js";
import {
  LocalGitDeliveryClient,
  type DeliveryGitClient,
} from "../../src/delivery/clients.js";
import { DeliveryExecutor } from "../../src/delivery/executor.js";
import { FileDeliveryReceiptStore } from "../../src/delivery/receipt-store.js";
import { FileSecretStoreAdapter } from "../../src/delivery/secret-store.js";
import {
  LocalPullRequestClient,
  NOW,
  RecordingReportPublisher,
  SECRET_VALUE,
  createFixture,
  createHandoff,
  git,
  type Fixture,
} from "./helpers.js";

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function buildExecutor(
  fixture: Fixture,
  changedFiles: string[],
  options: {
    gitClient?: DeliveryGitClient;
    pullRequests?: LocalPullRequestClient;
    reports?: RecordingReportPublisher;
    secretPath?: string;
  } = {},
) {
  const receipts = new FileDeliveryReceiptStore({
    path: fixture.receiptPath,
    workspaceRoot: fixture.workspace,
  });
  const gitClient =
    options.gitClient ??
    new LocalGitDeliveryClient({
      remoteUrl: fixture.remote,
      deliveryRoot: fixture.deliveryRoot,
      workspaceRoot: fixture.workspace,
    });
  const pullRequests = options.pullRequests ?? new LocalPullRequestClient();
  const reports = options.reports ?? new RecordingReportPublisher();
  const executor = new DeliveryExecutor({
    authorizer: new StaticDeliveryAuthorizer([
      {
        taskId: "issue-146",
        workstreamId: "owner-team",
        assignedTo: "Engineer",
        reviewerApproved: true,
        repository: {
          host: "github.com",
          owner: "bayshanhai-dev",
          name: "agentweave",
        },
        baseRef: "main",
        branchPrefix: "codex/issue-146-",
        allowedFiles: changedFiles,
      },
    ]),
    receipts,
    secrets: new FileSecretStoreAdapter({
      store: "box-secret-store",
      path: options.secretPath ?? fixture.secretPath,
      workspaceRoot: fixture.workspace,
    }),
    git: gitClient,
    pullRequests,
    reports,
    now: () => NOW,
  });
  return { executor, receipts, gitClient, pullRequests, reports };
}

describe("DeliveryExecutor", () => {
  it("creates one scoped commit and one PR, then returns the receipt on identical retry", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(
      join(fixture.workspace, "src", "delivery.ts"),
      "export const delivered = true;\n",
    );
    await writeFile(
      join(fixture.workspace, "README.delivery.md"),
      "delivery contract\n",
    );
    const changedFiles = ["src/delivery.ts", "README.delivery.md"];
    const handoff = await createHandoff(fixture.workspace, changedFiles);
    const { executor, pullRequests, reports } = buildExecutor(
      fixture,
      changedFiles,
    );

    const first = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(first.status).toBe("succeeded");
    expect(first.report).toMatchObject({
      event: "delivery.succeeded",
      ci_status: "ci_pending",
      changed_files: changedFiles,
    });
    expect(pullRequests.openPullRequest).toHaveBeenCalledTimes(1);

    const checkout = join(fixture.root, "checkout");
    await git(fixture.root, [
      "clone",
      "--branch",
      handoff.branch,
      fixture.remote,
      checkout,
    ]);
    expect(
      await git(checkout, [
        "rev-list",
        "--count",
        `origin/main..${handoff.branch}`,
      ]),
    ).toBe("1");
    expect(await git(checkout, ["log", "-1", "--format=%s"])).toBe(
      handoff.commit_summary,
    );
    expect(
      (
        await git(checkout, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "HEAD",
        ])
      )
        .split("\n")
        .sort(),
    ).toEqual([...changedFiles].sort());

    const firstCommit =
      first.status === "succeeded" ? first.receipt.commit : undefined;
    const second = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(second.status).toBe("succeeded");
    expect(
      second.status === "succeeded" ? second.receipt.commit : undefined,
    ).toBe(firstCommit);
    expect(pullRequests.openPullRequest).toHaveBeenCalledTimes(1);
    expect(reports.calls).toHaveLength(2);
    expect(
      await git(checkout, [
        "rev-list",
        "--count",
        `origin/main..origin/${handoff.branch}`,
      ]),
    ).toBe("1");
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "change.txt"), "one\n");
    const handoff = await createHandoff(fixture.workspace, ["change.txt"]);
    const { executor } = buildExecutor(fixture, ["change.txt"]);
    expect(
      (
        await executor.execute(handoff, {
          workspaceRoot: fixture.workspace,
          workstreamId: "owner-team",
        })
      ).status,
    ).toBe("succeeded");

    const collision = {
      ...handoff,
      commit_summary: "A different commit summary",
    };
    const result = await executor.execute(collision, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(result.status).toBe("blocked");
    expect(result.report.reason).toBe("idempotency_key_reused");
  });

  it("rejects a reused run_id when the file manifest changes", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "change.txt"), "one\n");
    const firstHandoff = await createHandoff(fixture.workspace, ["change.txt"]);
    const { executor, reports } = buildExecutor(fixture, ["change.txt"]);
    expect(
      (
        await executor.execute(firstHandoff, {
          workspaceRoot: fixture.workspace,
          workstreamId: "owner-team",
        })
      ).status,
    ).toBe("succeeded");

    await writeFile(join(fixture.workspace, "change.txt"), "two\n");
    const changedManifest = await createHandoff(fixture.workspace, [
      "change.txt",
    ]);
    const result = await executor.execute(changedManifest, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(result.status).toBe("blocked");
    expect(result.report.reason).toBe("run_id_reused");
    expect(reports.calls.at(-1)?.report).toEqual(result.report);
  });

  it("routes an unchanged handoff to human_deputy when the credential is unprovisioned", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "change.txt"), "change\n");
    const handoff = await createHandoff(fixture.workspace, ["change.txt"]);
    const gitClient: DeliveryGitClient = {
      findRemoteBranch: vi.fn(),
      hasLocalCommit: vi.fn(),
      createCommit: vi.fn(),
      push: vi.fn(),
    };
    const reports = new RecordingReportPublisher();
    const { executor } = buildExecutor(fixture, ["change.txt"], {
      gitClient,
      reports,
      secretPath: join(fixture.root, "missing-secret-store.json"),
    });

    const result = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(result.status).toBe("blocked");
    expect(result.report).toMatchObject({
      event: "delivery.blocked",
      status: "BLOCKED",
      reason: "credential_unprovisioned",
      next_owner: "human_deputy",
    });
    expect(gitClient.findRemoteBranch).not.toHaveBeenCalled();
    expect(gitClient.createCommit).not.toHaveBeenCalled();
    expect(gitClient.push).not.toHaveBeenCalled();
    expect(reports.calls[0]?.route).toEqual({
      recipient: "human_deputy",
      handoff,
    });
  });

  it.each([
    ["credential_unauthorized", "unauthorized"],
    ["credential_malformed", "malformed"],
  ] as const)(
    "fails closed with %s and performs no git operation",
    async (expected, kind) => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      await writeFile(join(fixture.workspace, "change.txt"), "change\n");
      const secretPath = join(fixture.root, `${kind}-secret-store.json`);
      await writeFile(
        secretPath,
        kind === "malformed"
          ? "{not-json\n"
          : JSON.stringify({
              version: 1,
              secrets: {
                "github/bayshanhai-dev/agentweave/push": {
                  value: SECRET_VALUE,
                  repositories: ["github.com/someone-else/another-repo"],
                },
              },
            }),
        { mode: 0o600 },
      );
      await chmod(secretPath, 0o600);
      const handoff = await createHandoff(fixture.workspace, ["change.txt"]);
      const gitClient: DeliveryGitClient = {
        findRemoteBranch: vi.fn(),
        hasLocalCommit: vi.fn(),
        createCommit: vi.fn(),
        push: vi.fn(),
      };
      const reports = new RecordingReportPublisher();
      const { executor } = buildExecutor(fixture, ["change.txt"], {
        gitClient,
        reports,
        secretPath,
      });

      const result = await executor.execute(handoff, {
        workspaceRoot: fixture.workspace,
        workstreamId: "owner-team",
      });
      expect(result.status).toBe("blocked");
      expect(result.report.reason).toBe(expected);
      expect(gitClient.findRemoteBranch).not.toHaveBeenCalled();
      expect(gitClient.createCommit).not.toHaveBeenCalled();
      expect(gitClient.push).not.toHaveBeenCalled();
      expect(reports.calls[0]?.route).toBeUndefined();
    },
  );

  it("never persists or reports the credential value", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "safe.txt"), "safe change\n");
    const handoff = await createHandoff(fixture.workspace, ["safe.txt"]);
    const { executor, reports } = buildExecutor(fixture, ["safe.txt"]);

    const result = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(result.status).toBe("succeeded");
    const commit = result.status === "succeeded" ? result.receipt.commit : "";
    const deliveryRepository = join(
      fixture.deliveryRoot,
      handoff.idempotency_key.replace(/[^a-zA-Z0-9._-]/gu, "_"),
    );
    const outputs = [
      JSON.stringify(result),
      JSON.stringify(reports.calls),
      await readFile(fixture.receiptPath, "utf8"),
      await git(deliveryRepository, ["show", "-s", "--format=%B", commit]),
    ].join("\n");
    expect(outputs).not.toContain(SECRET_VALUE);
  });

  it("blocks before git when the credential value appears in the declared delivery scope", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(
      join(fixture.workspace, "leaked.txt"),
      `do not ship ${SECRET_VALUE}\n`,
    );
    const handoff = await createHandoff(fixture.workspace, ["leaked.txt"]);
    const gitClient: DeliveryGitClient = {
      findRemoteBranch: vi.fn(),
      hasLocalCommit: vi.fn(),
      createCommit: vi.fn(),
      push: vi.fn(),
    };
    const reports = new RecordingReportPublisher();
    const { executor } = buildExecutor(fixture, ["leaked.txt"], {
      gitClient,
      reports,
    });

    const result = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(result.status).toBe("blocked");
    expect(result.report.reason).toBe("credential_value_forbidden");
    expect(gitClient.findRemoteBranch).not.toHaveBeenCalled();
    expect(gitClient.createCommit).not.toHaveBeenCalled();
    expect(JSON.stringify(reports.calls)).not.toContain(SECRET_VALUE);
    expect(await readFile(fixture.receiptPath, "utf8")).not.toContain(
      SECRET_VALUE,
    );
  });

  it("resumes a recorded commit after a push failure without creating a second commit", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeFile(join(fixture.workspace, "resume.txt"), "resume me\n");
    const handoff = await createHandoff(fixture.workspace, ["resume.txt"]);
    const localGit = new LocalGitDeliveryClient({
      remoteUrl: fixture.remote,
      deliveryRoot: fixture.deliveryRoot,
      workspaceRoot: fixture.workspace,
    });
    let failPush = true;
    const gitClient: DeliveryGitClient = {
      findRemoteBranch: (...args) => localGit.findRemoteBranch(...args),
      hasLocalCommit: (...args) => localGit.hasLocalCommit(...args),
      createCommit: vi.fn((...args) => localGit.createCommit(...args)),
      push: vi.fn(async (...args) => {
        if (failPush) {
          failPush = false;
          throw new Error("simulated push rejection");
        }
        await localGit.push(...args);
      }),
    };
    const pullRequests = new LocalPullRequestClient();
    const { executor } = buildExecutor(fixture, ["resume.txt"], {
      gitClient,
      pullRequests,
    });

    const first = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(first.status).toBe("blocked");
    expect(first.report.reason).toBe("push_failed");
    expect(first.receipt?.commit).toMatch(/^[a-f0-9]{40}$/u);

    const second = await executor.execute(handoff, {
      workspaceRoot: fixture.workspace,
      workstreamId: "owner-team",
    });
    expect(second.status).toBe("succeeded");
    expect(gitClient.createCommit).toHaveBeenCalledTimes(1);
    expect(gitClient.push).toHaveBeenCalledTimes(2);
    expect(pullRequests.openPullRequest).toHaveBeenCalledTimes(1);
  });
});
