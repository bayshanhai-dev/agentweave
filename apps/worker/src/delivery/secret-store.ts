import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DeliveryRepository } from "./handoff.js";

export type CredentialFailureReason =
  | "credential_unprovisioned"
  | "credential_unauthorized"
  | "credential_malformed";

export class CredentialStoreError extends Error {
  constructor(readonly reason: CredentialFailureReason) {
    super(reason);
    this.name = "CredentialStoreError";
  }
}

export interface CredentialHandle {
  readonly name: string;
  use<T>(consumer: (credential: string) => Promise<T>): Promise<T>;
}

class InMemoryCredentialHandle implements CredentialHandle {
  readonly name: string;
  #credential: string;

  constructor(name: string, credential: string) {
    this.name = name;
    this.#credential = credential;
  }

  async use<T>(consumer: (credential: string) => Promise<T>): Promise<T> {
    return consumer(this.#credential);
  }

  toJSON(): { name: string } {
    return { name: this.name };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `CredentialHandle(${this.name})`;
  }
}

export interface SecretStoreAdapter {
  readonly store: string;
  resolve(
    name: string,
    context: { repository: DeliveryRepository },
  ): Promise<CredentialHandle>;
}

type SecretDocument = {
  version: 1;
  secrets: Record<
    string,
    {
      value: string;
      repositories: string[];
    }
  >;
};

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function repositoryName(repository: DeliveryRepository): string {
  return `${repository.host}/${repository.owner}/${repository.name}`;
}

function parseDocument(value: unknown): SecretDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialStoreError("credential_malformed");
  }
  const root = value as Record<string, unknown>;
  if (
    root.version !== 1 ||
    root.secrets === null ||
    typeof root.secrets !== "object" ||
    Array.isArray(root.secrets) ||
    Object.keys(root).sort().join(",") !== "secrets,version"
  ) {
    throw new CredentialStoreError("credential_malformed");
  }
  return root as SecretDocument;
}

/**
 * Reads a versioned secret document from a path supplied by the outside worker.
 * The path must resolve outside the agent workspace. There is deliberately no
 * environment-variable, workspace-file, or command-line credential fallback.
 */
export class FileSecretStoreAdapter implements SecretStoreAdapter {
  readonly store: string;
  readonly #path: string;
  readonly #workspaceRoot: string;

  constructor(options: { store: string; path: string; workspaceRoot: string }) {
    this.store = options.store;
    this.#path = resolve(options.path);
    this.#workspaceRoot = resolve(options.workspaceRoot);
  }

  async resolve(
    name: string,
    context: { repository: DeliveryRepository },
  ): Promise<CredentialHandle> {
    if (isContained(this.#workspaceRoot, this.#path)) {
      throw new CredentialStoreError("credential_unauthorized");
    }
    let filePath: string;
    let workspacePath: string;
    try {
      [filePath, workspacePath] = await Promise.all([
        realpath(this.#path),
        realpath(this.#workspaceRoot),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CredentialStoreError("credential_unprovisioned");
      }
      throw new CredentialStoreError("credential_unauthorized");
    }
    if (isContained(workspacePath, filePath)) {
      throw new CredentialStoreError("credential_unauthorized");
    }

    try {
      const parent = await realpath(dirname(filePath));
      if (isContained(workspacePath, parent)) {
        throw new CredentialStoreError("credential_unauthorized");
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
        throw new CredentialStoreError("credential_unauthorized");
      }
      const document = parseDocument(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      const secret = document.secrets[name];
      if (!secret) throw new CredentialStoreError("credential_unprovisioned");
      if (
        secret === null ||
        typeof secret !== "object" ||
        Object.keys(secret).sort().join(",") !== "repositories,value" ||
        typeof secret.value !== "string" ||
        secret.value.length === 0 ||
        !Array.isArray(secret.repositories) ||
        secret.repositories.some((entry) => typeof entry !== "string")
      ) {
        throw new CredentialStoreError("credential_malformed");
      }
      if (!secret.repositories.includes(repositoryName(context.repository))) {
        throw new CredentialStoreError("credential_unauthorized");
      }
      return new InMemoryCredentialHandle(name, secret.value);
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CredentialStoreError("credential_unprovisioned");
      }
      throw new CredentialStoreError("credential_malformed");
    }
  }
}
