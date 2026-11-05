import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ValidatedDeliveryHandoff } from "./handoff.js";

export type DeliveryReceiptState =
  "accepted" | "committed" | "pushed" | "pr_opened" | "blocked";

export type DeliveryReceipt = {
  idempotencyKey: string;
  payloadHash: string;
  manifestHash: string;
  runIdentity: string;
  branch: string;
  commit?: string;
  prUrl?: string;
  state: DeliveryReceiptState;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export class ReceiptCollisionError extends Error {
  constructor(readonly code: "idempotency_key_reused" | "run_id_reused") {
    super(code);
    this.name = "ReceiptCollisionError";
  }
}

export interface DeliveryReceiptStore {
  get(idempotencyKey: string): Promise<DeliveryReceipt | undefined>;
  accept(handoff: ValidatedDeliveryHandoff): Promise<DeliveryReceipt>;
  save(receipt: DeliveryReceipt): Promise<void>;
  reference(idempotencyKey: string): string;
}

type ReceiptDocument = {
  version: 1;
  receipts: Record<string, DeliveryReceipt>;
  runs: Record<string, { manifestHash: string; idempotencyKey: string }>;
};

function emptyDocument(): ReceiptDocument {
  return { version: 1, receipts: {}, runs: {} };
}

function runIdentity(
  handoff: Pick<
    ValidatedDeliveryHandoff,
    "workstream_id" | "task_id" | "run_id"
  >,
): string {
  return `${handoff.workstream_id}\u0000${handoff.task_id}\u0000${handoff.run_id}`;
}

export class FileDeliveryReceiptStore implements DeliveryReceiptStore {
  readonly #path: string;
  readonly #workspaceRoot: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: { path: string; workspaceRoot: string }) {
    this.#path = resolve(options.path);
    this.#workspaceRoot = resolve(options.workspaceRoot);
    const rel = relative(this.#workspaceRoot, this.#path);
    if (
      rel === "" ||
      (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    ) {
      throw new Error(
        "delivery receipt path must be outside the agent workspace",
      );
    }
  }

  reference(idempotencyKey: string): string {
    return `delivery-receipt:${idempotencyKey}`;
  }

  async get(idempotencyKey: string): Promise<DeliveryReceipt | undefined> {
    await this.#pending;
    return (await this.#read()).receipts[idempotencyKey];
  }

  async accept(handoff: ValidatedDeliveryHandoff): Promise<DeliveryReceipt> {
    return this.#serialized(async () => {
      const document = await this.#read();
      const existing = document.receipts[handoff.idempotency_key];
      if (existing) {
        if (existing.payloadHash !== handoff.payloadHash) {
          throw new ReceiptCollisionError("idempotency_key_reused");
        }
        return existing;
      }

      const identity = runIdentity(handoff);
      const existingRun = document.runs[identity];
      if (existingRun && existingRun.manifestHash !== handoff.manifestHash) {
        throw new ReceiptCollisionError("run_id_reused");
      }
      if (
        existingRun &&
        existingRun.idempotencyKey !== handoff.idempotency_key
      ) {
        throw new ReceiptCollisionError("run_id_reused");
      }

      const now = new Date().toISOString();
      const receipt: DeliveryReceipt = {
        idempotencyKey: handoff.idempotency_key,
        payloadHash: handoff.payloadHash,
        manifestHash: handoff.manifestHash,
        runIdentity: identity,
        branch: handoff.branch,
        state: "accepted",
        createdAt: now,
        updatedAt: now,
      };
      document.receipts[handoff.idempotency_key] = receipt;
      document.runs[identity] = {
        manifestHash: handoff.manifestHash,
        idempotencyKey: handoff.idempotency_key,
      };
      await this.#write(document);
      return receipt;
    });
  }

  async save(receipt: DeliveryReceipt): Promise<void> {
    await this.#serialized(async () => {
      const document = await this.#read();
      const existing = document.receipts[receipt.idempotencyKey];
      if (existing && existing.payloadHash !== receipt.payloadHash) {
        throw new ReceiptCollisionError("idempotency_key_reused");
      }
      document.receipts[receipt.idempotencyKey] = {
        ...receipt,
        updatedAt: new Date().toISOString(),
      };
      await this.#write(document);
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending;
    let release: () => void = () => undefined;
    this.#pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #read(): Promise<ReceiptDocument> {
    await this.#assertExternalPath();
    try {
      const parsed = JSON.parse(
        await readFile(this.#path, "utf8"),
      ) as Partial<ReceiptDocument>;
      if (parsed.version !== 1 || !parsed.receipts || !parsed.runs) {
        throw new Error("invalid receipt document");
      }
      return parsed as ReceiptDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyDocument();
      throw error;
    }
  }

  async #write(document: ReceiptDocument): Promise<void> {
    await this.#assertExternalPath();
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }

  async #assertExternalPath(): Promise<void> {
    const workspaceRoot = await realpath(this.#workspaceRoot);
    let existing = this.#path;
    for (;;) {
      try {
        await lstat(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    const resolvedExisting = await realpath(existing);
    const rel = relative(workspaceRoot, resolvedExisting);
    if (
      rel === "" ||
      (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    ) {
      throw new Error(
        "delivery receipt path must be outside the agent workspace",
      );
    }
  }
}
