import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import type {
  DeliveryOutcomeReport,
  DeliveryReportPublisher,
  DeputyDeliveryRoute,
} from "../../src/delivery-report.js";
import {
  deliveryIdempotencyKey,
  deliveryManifestHash,
  sha256,
  type DeliveryHandoff,
  type ValidatedDeliveryFile,
  type ValidatedDeliveryHandoff,
} from "../../src/delivery/handoff.js";
import type {
  PullRequestClient,
  PullRequestRecord,
} from "../../src/delivery/clients.js";
import type { CredentialHandle } from "../../src/delivery/secret-store.js";

const exec = promisify(execFile);

export const SECRET_VALUE = "github-secret-value-that-must-never-leak";
export const NOW = new Date("2026-11-04T12:00:00.000Z");

export type Fixture = {
  root: string;
  workspace: string;
  remote: string;
  deliveryRoot: string;
  receiptPath: string;
  secretPath: string;
  cleanup(): Promise<void>;
};

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentweave-delivery-"));
  const workspace = join(root, "workspace");
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const deliveryRoot = join(root, "delivery-worktrees");
  const receiptPath = join(root, "worker-state", "receipts.json");
  const secretPath = join(root, "outside-secret-store.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(seed, { recursive: true });
  await exec("git", ["init", "--initial-branch=main"], { cwd: seed });
  await writeFile(join(seed, "base.txt"), "base\n");
  await exec("git", ["add", "base.txt"], { cwd: seed });
  await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: seed },
  );
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["remote", "add", "origin", remote], { cwd: seed });
  await exec("git", ["push", "origin", "main"], { cwd: seed });
  await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remote,
  });
  await writeFile(
    secretPath,
    `${JSON.stringify({
      version: 1,
      secrets: {
        "github/bayshanhai-dev/agentweave/push": {
          value: SECRET_VALUE,
          repositories: ["github.com/bayshanhai-dev/agentweave"],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(secretPath, 0o600);
  return {
    root,
    workspace,
    remote,
    deliveryRoot,
    receiptPath,
    secretPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createHandoff(
  workspace: string,
  changedFiles: string[],
  overrides: Partial<DeliveryHandoff> = {},
): Promise<DeliveryHandoff> {
  const files: ValidatedDeliveryFile[] = [];
  for (const path of changedFiles) {
    const sourcePath = join(workspace, path);
    try {
      const content = await readFile(sourcePath);
      files.push({
        path,
        sourcePath,
        exists: true,
        contentHash: sha256(content),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files.push({ path, sourcePath, exists: false, contentHash: null });
    }
  }
  const base: Omit<DeliveryHandoff, "idempotency_key"> = {
    schema: "delivery-path/v1",
    task_id: "issue-146",
    workstream_id: "owner-team",
    run_id: "engineer-turn-2026-11-04-01",
    repository: {
      host: "github.com",
      owner: "bayshanhai-dev",
      name: "agentweave",
    },
    base_ref: "main",
    branch: "codex/issue-146-delivery-path",
    commit_summary: "Issue #146: add sanctioned delivery path",
    changed_files: changedFiles,
    requested_actor: "worker",
    credential_ref: {
      store: "box-secret-store",
      name: "github/bayshanhai-dev/agentweave/push",
      value: null,
    },
    status: "ready_for_delivery",
    created_at: "2026-11-04T11:00:00.000Z",
    expires_at: "2026-11-04T13:00:00.000Z",
    agent_boundary: { workspace: "workspace-write", git: "read-only" },
    ...overrides,
  };
  const manifestHash = deliveryManifestHash(files);
  const handoff = {
    ...base,
    idempotency_key: deliveryIdempotencyKey(base, manifestHash),
  };
  return { ...handoff, ...overrides } as DeliveryHandoff;
}

export class RecordingReportPublisher implements DeliveryReportPublisher {
  readonly calls: Array<{
    workstreamId: string;
    report: DeliveryOutcomeReport;
    route?: DeputyDeliveryRoute;
  }> = [];

  async publish(
    workstreamId: string,
    report: DeliveryOutcomeReport,
    route?: DeputyDeliveryRoute,
  ): Promise<void> {
    this.calls.push({ workstreamId, report, ...(route ? { route } : {}) });
  }
}

export class LocalPullRequestClient implements PullRequestClient {
  readonly records = new Map<string, PullRequestRecord>();
  readonly openPullRequest = vi.fn(
    async (
      input: { handoff: ValidatedDeliveryHandoff; commit: string },
      credential: CredentialHandle,
    ): Promise<PullRequestRecord> => {
      await credential.use(async () => undefined);
      const record = {
        url: `local://pull/${encodeURIComponent(input.handoff.branch)}`,
        branch: input.handoff.branch,
        idempotencyKey: input.handoff.idempotency_key,
      };
      this.records.set(input.handoff.branch, record);
      return record;
    },
  );

  async findOpenPullRequest(
    handoff: ValidatedDeliveryHandoff,
    _credential: CredentialHandle,
  ): Promise<PullRequestRecord | undefined> {
    return this.records.get(handoff.branch);
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}
