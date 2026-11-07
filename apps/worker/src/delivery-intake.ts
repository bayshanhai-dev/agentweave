import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { StaticDeliveryAuthorizer } from "./delivery/authorization.js";
import {
  GitHubGitClient,
  GitHubPullRequestClient,
} from "./delivery/clients.js";
import {
  DeliveryExecutor,
  type DeliveryAttemptResult,
} from "./delivery/executor.js";
import { FileDeliveryReceiptStore } from "./delivery/receipt-store.js";
import { FileSecretStoreAdapter } from "./delivery/secret-store.js";
import { HttpDeliveryReportPublisher } from "./delivery-report.js";

export type DeliveryConfig =
  | { enabled: false }
  | {
      enabled: true;
      deliveryRoot: string;
      secretFile: string;
      secretStore: string;
      repository: { host: "github.com"; owner: string; name: string };
      controlApiUrl: string;
    };

export function readDeliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryConfig {
  if (env.AGENTWEAVE_DELIVERY_ENABLED !== "true") return { enabled: false };

  const deliveryRoot = env.AGENTWEAVE_DELIVERY_ROOT;
  const secretFile = env.AGENTWEAVE_DELIVERY_SECRET_FILE;
  if (!deliveryRoot) {
    throw new Error("AGENTWEAVE_DELIVERY_ROOT is required when delivery is enabled");
  }
  if (!secretFile) {
    throw new Error(
      "AGENTWEAVE_DELIVERY_SECRET_FILE is required when delivery is enabled",
    );
  }
  const repositoryName =
    env.AGENTWEAVE_DELIVERY_REPOSITORY ?? "bayshanhai-dev/agentweave";
  const [owner, name, ...extra] = repositoryName.split("/");
  if (!owner || !name || extra.length > 0) {
    throw new Error("AGENTWEAVE_DELIVERY_REPOSITORY must be owner/name");
  }
  return {
    enabled: true,
    deliveryRoot,
    secretFile,
    secretStore: env.AGENTWEAVE_DELIVERY_SECRET_STORE ?? "box-secret-store",
    repository: { host: "github.com", owner, name },
    controlApiUrl: env.CONTROL_API_URL ?? "http://control-api:3000",
  };
}

export type DeliveryExecutorLike = Pick<DeliveryExecutor, "execute">;

export type DeliveryRunnerContext = {
  workspaceRoot: string;
  workstreamId: string;
  taskId: string;
  handoff: unknown;
};

function stringField(value: unknown, field: string, fallback: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[field] === "string"
  ) {
    return (value as Record<string, unknown>)[field] as string;
  }
  return fallback;
}

function fileScope(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const changedFiles = (value as Record<string, unknown>).changed_files;
  if (!Array.isArray(changedFiles)) return [];
  return changedFiles.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
}

/** Assemble the production executor for one workspace/task delivery. */
export function createProductionDeliveryRunner(
  config: Extract<DeliveryConfig, { enabled: true }>,
): (context: DeliveryRunnerContext) => DeliveryExecutor;
export function createProductionDeliveryRunner(
  config: Extract<DeliveryConfig, { enabled: true }>,
  context: DeliveryRunnerContext,
): DeliveryExecutor;
export function createProductionDeliveryRunner(
  config: Extract<DeliveryConfig, { enabled: true }>,
  context?: DeliveryRunnerContext,
): DeliveryExecutor | ((context: DeliveryRunnerContext) => DeliveryExecutor) {
  if (!context) {
    return (nextContext) => createProductionDeliveryRunner(config, nextContext);
  }
  const handoff = context.handoff;
  const branch = stringField(handoff, "branch", "");
  const baseRef = stringField(handoff, "base_ref", "main");
  const authorizer = new StaticDeliveryAuthorizer([
    {
      taskId: context.taskId,
      workstreamId: context.workstreamId,
      assignedTo: "Engineer",
      reviewerApproved: true,
      repository: config.repository,
      baseRef,
      // The configured repository is the production allowlist. The executor
      // still validates the handoff and this scope is limited to its manifest.
      branchPrefix: branch,
      allowedFiles: fileScope(handoff),
    },
  ]);
  return new DeliveryExecutor({
    authorizer,
    receipts: new FileDeliveryReceiptStore({
      path: join(config.deliveryRoot, "receipts.json"),
      workspaceRoot: context.workspaceRoot,
    }),
    secrets: new FileSecretStoreAdapter({
      store: config.secretStore,
      path: config.secretFile,
      workspaceRoot: context.workspaceRoot,
    }),
    git: new GitHubGitClient({
      deliveryRoot: config.deliveryRoot,
      workspaceRoot: context.workspaceRoot,
    }),
    pullRequests: new GitHubPullRequestClient(),
    reports: new HttpDeliveryReportPublisher(config.controlApiUrl),
  });
}

type DeliveryLog = (entry: Record<string, unknown>) => void;

export type DeliveryIntakeDependencies = {
  config: DeliveryConfig;
  createExecutor?: (
    context: DeliveryRunnerContext,
  ) => DeliveryExecutorLike;
  executor?: DeliveryExecutorLike;
  log?: DeliveryLog;
};

export type DeliveryIntakeContext = {
  workspacePath: string;
  workstreamId: string;
  taskId: string;
};

export type DeliveryIntakeResult =
  | { status: "skipped"; reason: string }
  | DeliveryAttemptResult;

const defaultLog: DeliveryLog = (entry) => {
  console.log(JSON.stringify(entry));
};

function archiveName(input: unknown): string {
  const value = stringField(input, "idempotency_key", "unknown");
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 520);
  return safe || "unknown";
}

async function archiveHandoff(
  workspacePath: string,
  handoffPath: string,
  input: unknown,
): Promise<void> {
  const delivered = join(workspacePath, ".agentweave", "delivered");
  await mkdir(delivered, { recursive: true });
  await rename(handoffPath, join(delivered, `${archiveName(input)}.json`));
}

/**
 * Reads and executes the one handoff file emitted by an agent. Every failure
 * is contained here so inbox acknowledgement and task completion are never
 * coupled to delivery availability.
 */
export async function processDeliveryHandoffIfPresent(
  deps: DeliveryIntakeDependencies,
  context: DeliveryIntakeContext,
): Promise<DeliveryIntakeResult | undefined> {
  if (!deps.config.enabled) return { status: "skipped", reason: "disabled" };
  const log = deps.log ?? defaultLog;
  const handoffPath = join(
    context.workspacePath,
    ".agentweave",
    "delivery-handoff.json",
  );
  let serialized: string;
  try {
    serialized = await readFile(handoffPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      log({
        event: "worker.delivery.skipped",
        reason: "handoff_absent",
        taskId: context.taskId,
        workstreamId: context.workstreamId,
      });
      return { status: "skipped", reason: "handoff_absent" };
    }
    log({
      event: "worker.delivery.blocked",
      reason: "handoff_unreadable",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
    });
    return { status: "skipped", reason: "handoff_unreadable" };
  }

  log({
    event: "worker.delivery.scanned",
    taskId: context.taskId,
    workstreamId: context.workstreamId,
  });
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    log({
      event: "worker.delivery.handoff_unparseable",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
    });
    return { status: "skipped", reason: "handoff_unparseable" };
  }

  let result: DeliveryAttemptResult;
  try {
    const executor =
      deps.executor ??
      deps.createExecutor?.({
        workspaceRoot: context.workspacePath,
        workstreamId: context.workstreamId,
        taskId: context.taskId,
        handoff: input,
      });
    if (!executor) {
      log({
        event: "worker.delivery.blocked",
        reason: "executor_unavailable",
        taskId: context.taskId,
        workstreamId: context.workstreamId,
      });
      return { status: "skipped", reason: "executor_unavailable" };
    }
    result = await executor.execute(input, {
      workspaceRoot: context.workspacePath,
      workstreamId: context.workstreamId,
    });
  } catch {
    // Executor implementations own the durable delivery report. Do not expose
    // their error text here because it may originate in a remote client.
    log({
      event: "worker.delivery.blocked",
      reason: "executor_failed",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
    });
    return { status: "skipped", reason: "executor_failed" };
  }

  if (result.status === "succeeded") {
    log({
      event: "worker.delivery.succeeded",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
      idempotencyKey:
        result.receipt?.idempotencyKey ?? stringField(input, "idempotency_key", "unknown"),
    });
  } else {
    log({
      event: "worker.delivery.blocked",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
      reason: result.report.reason,
    });
  }

  try {
    await archiveHandoff(context.workspacePath, handoffPath, input);
  } catch {
    log({
      event: "worker.delivery.archive_failed",
      taskId: context.taskId,
      workstreamId: context.workstreamId,
    });
  }
  return result;
}
