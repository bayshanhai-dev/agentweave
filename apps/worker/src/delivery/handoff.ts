import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

export const DELIVERY_SCHEMA = "delivery-path/v1" as const;
export const MAX_CHANGED_FILES = 1_000;

export type DeliveryActor = "worker" | "human_deputy";
export type DeliveryRepository = { host: string; owner: string; name: string };
export type DeliveryCredentialRef = {
  store: string;
  name: string;
  value: null;
};

export type DeliveryHandoff = {
  schema: typeof DELIVERY_SCHEMA;
  task_id: string;
  workstream_id: string;
  run_id: string;
  repository: DeliveryRepository;
  base_ref: string;
  branch: string;
  commit_summary: string;
  changed_files: string[];
  requested_actor: DeliveryActor;
  credential_ref: DeliveryCredentialRef;
  idempotency_key: string;
  status: "ready_for_delivery";
  created_at: string;
  expires_at: string;
  agent_boundary: { workspace: "workspace-write"; git: "read-only" };
};

export type ValidatedDeliveryFile = {
  path: string;
  sourcePath: string;
  exists: boolean;
  contentHash: string | null;
};

export type ValidatedDeliveryHandoff = DeliveryHandoff & {
  payloadHash: string;
  manifestHash: string;
  files: ValidatedDeliveryFile[];
};

export class HandoffValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HandoffValidationError";
  }
}

type ValidationOptions = {
  workspaceRoot: string;
  now?: Date;
  maxChangedFiles?: number;
};

const HANDOFF_KEYS = [
  "schema",
  "task_id",
  "workstream_id",
  "run_id",
  "repository",
  "base_ref",
  "branch",
  "commit_summary",
  "changed_files",
  "requested_actor",
  "credential_ref",
  "idempotency_key",
  "status",
  "created_at",
  "expires_at",
  "agent_boundary",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${location} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function requiredString(
  value: unknown,
  field: string,
  options: { max?: number; singleLine?: boolean } = {},
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} must be a non-empty string`,
    );
  }
  if (value !== value.trim()) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} must not have surrounding whitespace`,
    );
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} is too long`,
    );
  }
  if (options.singleLine && /[\r\n]/u.test(value)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} must be a single line`,
    );
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function validateFile(
  workspaceRoot: string,
  workspaceRealRoot: string,
  path: string,
): Promise<ValidatedDeliveryFile> {
  if (
    path.length === 0 ||
    path === "." ||
    path.includes("\\") ||
    isAbsolute(path) ||
    normalize(path) !== path ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HandoffValidationError(
      "invalid_changed_path",
      `Invalid changed file path: ${path}`,
    );
  }

  const sourcePath = resolve(workspaceRoot, path);
  if (!isContained(workspaceRoot, sourcePath)) {
    throw new HandoffValidationError(
      "path_escape",
      `Changed file escapes workspace: ${path}`,
    );
  }

  const existingPath = await nearestExistingPath(sourcePath);
  const existingRealPath = await realpath(existingPath);
  if (!isContained(workspaceRealRoot, existingRealPath)) {
    throw new HandoffValidationError(
      "path_escape",
      `Changed file resolves outside workspace: ${path}`,
    );
  }

  try {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new HandoffValidationError(
        "path_escape",
        `Changed file is a symlink: ${path}`,
      );
    }
    if (!metadata.isFile()) {
      throw new HandoffValidationError(
        "unbounded_file_scope",
        `Changed path is not a file: ${path}`,
      );
    }
    const resolvedFile = await realpath(sourcePath);
    if (!isContained(workspaceRealRoot, resolvedFile)) {
      throw new HandoffValidationError(
        "path_escape",
        `Changed file resolves outside workspace: ${path}`,
      );
    }
    const { readFile } = await import("node:fs/promises");
    return {
      path,
      sourcePath,
      exists: true,
      contentHash: sha256(await readFile(sourcePath)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, sourcePath, exists: false, contentHash: null };
    }
    throw error;
  }
}

function assertGitRef(value: string, field: "base_ref" | "branch"): void {
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value
      .split("/")
      .some(
        (part) => !part || part.startsWith(".") || part.endsWith(".lock"),
      ) ||
    /[\x00-\x20\x7f~^:?*[\\]/u.test(value)
  ) {
    throw new HandoffValidationError(
      "invalid_git_ref",
      `${field} is not a valid git ref`,
    );
  }
}

function parseUtcTimestamp(value: unknown, field: string): Date {
  const text = requiredString(value, field, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} must be an RFC3339 UTC timestamp`,
    );
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new HandoffValidationError(
      "malformed_handoff",
      `${field} is invalid`,
    );
  }
  return parsed;
}

export function deliveryManifestHash(
  files: readonly ValidatedDeliveryFile[],
): string {
  return sha256(
    canonicalize(
      files.map((file) => ({
        path: file.path,
        content_sha256: file.contentHash,
      })),
    ),
  );
}

export function deliveryIdempotencyKey(
  handoff: Pick<
    DeliveryHandoff,
    | "schema"
    | "task_id"
    | "workstream_id"
    | "run_id"
    | "repository"
    | "base_ref"
    | "branch"
  >,
  manifestHash: string,
): string {
  const scope = {
    schema: handoff.schema,
    task_id: handoff.task_id,
    workstream_id: handoff.workstream_id,
    run_id: handoff.run_id,
    repository: handoff.repository,
    base_ref: handoff.base_ref,
    branch: handoff.branch,
    manifest_sha256: manifestHash,
  };
  return `sha256:${sha256(canonicalize(scope))}`;
}

export function deliveryPayloadHash(handoff: DeliveryHandoff): string {
  return sha256(canonicalize(handoff));
}

export async function validateDeliveryHandoff(
  input: unknown,
  options: ValidationOptions,
): Promise<ValidatedDeliveryHandoff> {
  if (!isRecord(input)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "Handoff must be an object",
    );
  }
  assertExactKeys(input, HANDOFF_KEYS, "handoff");
  if (input.schema !== DELIVERY_SCHEMA) {
    throw new HandoffValidationError(
      "unsupported_schema",
      `schema must be ${DELIVERY_SCHEMA}`,
    );
  }

  const taskId = requiredString(input.task_id, "task_id", { max: 256 });
  const workstreamId = requiredString(input.workstream_id, "workstream_id", {
    max: 256,
  });
  const runId = requiredString(input.run_id, "run_id", { max: 256 });

  if (!isRecord(input.repository)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "repository must be an object",
    );
  }
  assertExactKeys(input.repository, ["host", "owner", "name"], "repository");
  const repository: DeliveryRepository = {
    host: requiredString(input.repository.host, "repository.host", {
      max: 255,
    }),
    owner: requiredString(input.repository.owner, "repository.owner", {
      max: 255,
    }),
    name: requiredString(input.repository.name, "repository.name", {
      max: 255,
    }),
  };

  const baseRef = requiredString(input.base_ref, "base_ref", { max: 255 });
  const branch = requiredString(input.branch, "branch", { max: 255 });
  assertGitRef(baseRef, "base_ref");
  assertGitRef(branch, "branch");
  const commitSummary = requiredString(input.commit_summary, "commit_summary", {
    max: 512,
    singleLine: true,
  });

  if (!Array.isArray(input.changed_files)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "changed_files must be an array",
    );
  }
  const maxChangedFiles = options.maxChangedFiles ?? MAX_CHANGED_FILES;
  if (
    input.changed_files.length === 0 ||
    input.changed_files.length > maxChangedFiles
  ) {
    throw new HandoffValidationError(
      "unbounded_file_scope",
      `changed_files must contain between 1 and ${maxChangedFiles} paths`,
    );
  }
  if (input.changed_files.some((path) => typeof path !== "string")) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "changed_files entries must be strings",
    );
  }
  const changedFiles = input.changed_files as string[];
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new HandoffValidationError(
      "duplicate_changed_path",
      "changed_files contains duplicates",
    );
  }

  if (
    input.requested_actor !== "worker" &&
    input.requested_actor !== "human_deputy"
  ) {
    throw new HandoffValidationError(
      "invalid_requested_actor",
      "requested_actor must be worker or human_deputy",
    );
  }
  if (!isRecord(input.credential_ref)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "credential_ref must be an object",
    );
  }
  assertExactKeys(
    input.credential_ref,
    ["store", "name", "value"],
    "credential_ref",
  );
  const credentialRef: DeliveryCredentialRef = {
    store: requiredString(input.credential_ref.store, "credential_ref.store", {
      max: 255,
    }),
    name: requiredString(input.credential_ref.name, "credential_ref.name", {
      max: 1_024,
    }),
    value: null,
  };
  if (input.credential_ref.value !== null) {
    throw new HandoffValidationError(
      "credential_value_forbidden",
      "credential_ref.value must be null",
    );
  }

  const idempotencyKey = requiredString(
    input.idempotency_key,
    "idempotency_key",
    { max: 512 },
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(idempotencyKey)) {
    throw new HandoffValidationError(
      "invalid_idempotency_key",
      "idempotency_key must be a sha256 digest",
    );
  }
  if (input.status !== "ready_for_delivery") {
    throw new HandoffValidationError(
      "invalid_status",
      "status must be ready_for_delivery",
    );
  }

  const createdAt = parseUtcTimestamp(input.created_at, "created_at");
  const expiresAt = parseUtcTimestamp(input.expires_at, "expires_at");
  if (expiresAt <= createdAt) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "expires_at must be after created_at",
    );
  }
  if (expiresAt <= (options.now ?? new Date())) {
    throw new HandoffValidationError("expired_handoff", "handoff has expired");
  }

  if (!isRecord(input.agent_boundary)) {
    throw new HandoffValidationError(
      "malformed_handoff",
      "agent_boundary must be an object",
    );
  }
  assertExactKeys(input.agent_boundary, ["workspace", "git"], "agent_boundary");
  if (
    input.agent_boundary.workspace !== "workspace-write" ||
    input.agent_boundary.git !== "read-only"
  ) {
    throw new HandoffValidationError(
      "invalid_agent_boundary",
      "agent_boundary must preserve workspace-write and read-only git",
    );
  }

  const workspaceRoot = resolve(options.workspaceRoot);
  const workspaceRealRoot = await realpath(workspaceRoot).catch(() => {
    throw new HandoffValidationError(
      "workspace_unavailable",
      "workspace root is unavailable",
    );
  });
  const files = await Promise.all(
    changedFiles.map((path) =>
      validateFile(workspaceRoot, workspaceRealRoot, path),
    ),
  );
  const manifestHash = deliveryManifestHash(files);

  const handoff: DeliveryHandoff = {
    schema: DELIVERY_SCHEMA,
    task_id: taskId,
    workstream_id: workstreamId,
    run_id: runId,
    repository,
    base_ref: baseRef,
    branch,
    commit_summary: commitSummary,
    changed_files: changedFiles,
    requested_actor: input.requested_actor,
    credential_ref: credentialRef,
    idempotency_key: idempotencyKey,
    status: "ready_for_delivery",
    created_at: input.created_at as string,
    expires_at: input.expires_at as string,
    agent_boundary: { workspace: "workspace-write", git: "read-only" },
  };

  if (deliveryIdempotencyKey(handoff, manifestHash) !== idempotencyKey) {
    throw new HandoffValidationError(
      "invalid_idempotency_key",
      "idempotency_key does not cover the handoff identity and file manifest",
    );
  }

  return {
    ...handoff,
    payloadHash: deliveryPayloadHash(handoff),
    manifestHash,
    files,
  };
}

export function safeHandoffIdentity(input: unknown): {
  task_id: string;
  workstream_id: string;
  run_id: string;
} {
  const value = isRecord(input) ? input : {};
  const safe = (candidate: unknown): string =>
    typeof candidate === "string" && candidate.trim()
      ? candidate.slice(0, 256)
      : "unknown";
  return {
    task_id: safe(value.task_id),
    workstream_id: safe(value.workstream_id),
    run_id: safe(value.run_id),
  };
}
