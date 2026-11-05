import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sha256, type ValidatedDeliveryHandoff } from "./handoff.js";
import type { CredentialHandle } from "./secret-store.js";

const exec = promisify(execFile);

export type RemoteDeliveryBranch = {
  commit: string;
  idempotencyKey?: string;
};

export type PullRequestRecord = {
  url: string;
  branch: string;
  idempotencyKey: string;
};

export interface DeliveryGitClient {
  findRemoteBranch(
    handoff: ValidatedDeliveryHandoff,
    credential: CredentialHandle,
  ): Promise<RemoteDeliveryBranch | undefined>;
  hasLocalCommit(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
  ): Promise<boolean>;
  createCommit(handoff: ValidatedDeliveryHandoff): Promise<string>;
  push(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
    credential: CredentialHandle,
  ): Promise<void>;
}

export interface PullRequestClient {
  findOpenPullRequest(
    handoff: ValidatedDeliveryHandoff,
    credential: CredentialHandle,
  ): Promise<PullRequestRecord | undefined>;
  openPullRequest(
    input: {
      handoff: ValidatedDeliveryHandoff;
      commit: string;
    },
    credential: CredentialHandle,
  ): Promise<PullRequestRecord>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hermetic git transport for local/file remotes. It intentionally does not
 * consume the credential value. A production remote transport implements the
 * same interface and receives only the opaque in-memory handle.
 */
export class LocalGitDeliveryClient implements DeliveryGitClient {
  readonly #remoteUrl: string;
  readonly #deliveryRoot: string;
  readonly #workspaceRoot: string;

  constructor(options: {
    remoteUrl: string;
    deliveryRoot: string;
    workspaceRoot: string;
  }) {
    this.#remoteUrl = options.remoteUrl;
    this.#deliveryRoot = resolve(options.deliveryRoot);
    this.#workspaceRoot = resolve(options.workspaceRoot);
    const rel = relative(this.#workspaceRoot, this.#deliveryRoot);
    if (
      rel === "" ||
      (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    ) {
      throw new Error(
        "delivery worktree root must be outside the agent workspace",
      );
    }
  }

  async findRemoteBranch(
    handoff: ValidatedDeliveryHandoff,
    _credential: CredentialHandle,
  ): Promise<RemoteDeliveryBranch | undefined> {
    const repository = await this.#repository(handoff);
    const reference = `refs/heads/${handoff.branch}`;
    const result = await exec(
      "git",
      ["ls-remote", "--heads", this.#remoteUrl, reference],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    const commit = result.stdout.trim().split(/\s+/u)[0];
    if (!commit) return undefined;
    await exec(
      "git",
      [
        "fetch",
        "--force",
        "origin",
        `${reference}:refs/remotes/origin/${handoff.branch}`,
      ],
      {
        cwd: repository,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const message = await exec(
      "git",
      ["show", "-s", "--format=%B", `refs/remotes/origin/${handoff.branch}`],
      { cwd: repository, maxBuffer: 1024 * 1024 },
    );
    const marker = message.stdout
      .match(/^AgentWeave-Idempotency-Key:\s*(.+)$/mu)?.[1]
      ?.trim();
    return { commit, ...(marker ? { idempotencyKey: marker } : {}) };
  }

  async hasLocalCommit(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
  ): Promise<boolean> {
    const repository = await this.#repository(handoff);
    try {
      await exec("git", ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: repository,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createCommit(handoff: ValidatedDeliveryHandoff): Promise<string> {
    const repository = await this.#repository(handoff);
    await exec("git", ["fetch", "--force", "origin", handoff.base_ref], {
      cwd: repository,
      maxBuffer: 4 * 1024 * 1024,
    });
    await exec(
      "git",
      [
        "checkout",
        "--force",
        "-B",
        handoff.branch,
        `origin/${handoff.base_ref}`,
      ],
      {
        cwd: repository,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    for (const file of handoff.files) {
      const destination = join(repository, file.path);
      if (file.exists) {
        await mkdir(dirname(destination), { recursive: true });
        const source = await open(
          file.sourcePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let content: Buffer;
        try {
          content = await source.readFile();
        } finally {
          await source.close();
        }
        if (sha256(content) !== file.contentHash) {
          throw new Error("declared_file_changed_after_validation");
        }
        await writeFile(destination, content);
      } else {
        await rm(destination, { force: true });
      }
    }
    await exec("git", ["add", "--all", "--", ...handoff.changed_files], {
      cwd: repository,
      maxBuffer: 4 * 1024 * 1024,
    });
    const changed = await exec(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      {
        cwd: repository,
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const actual = changed.stdout
      .toString("utf8")
      .split("\u0000")
      .filter(Boolean)
      .sort();
    const expected = [...handoff.changed_files].sort();
    if (
      actual.length !== expected.length ||
      actual.some((path, index) => path !== expected[index])
    ) {
      throw new Error("declared_file_scope_mismatch");
    }

    await exec(
      "git",
      [
        "-c",
        "user.name=AgentWeave Delivery Worker",
        "-c",
        "user.email=delivery-worker@agentweave.invalid",
        "commit",
        "-m",
        handoff.commit_summary,
        "-m",
        `AgentWeave-Idempotency-Key: ${handoff.idempotency_key}`,
      ],
      { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
    );
    const result = await exec("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    });
    return result.stdout.trim();
  }

  async push(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
    _credential: CredentialHandle,
  ): Promise<void> {
    const repository = await this.#repository(handoff);
    await exec(
      "git",
      ["push", "origin", `${commit}:refs/heads/${handoff.branch}`],
      {
        cwd: repository,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  }

  async #repository(handoff: ValidatedDeliveryHandoff): Promise<string> {
    await this.#assertExternalRoot();
    const directory = join(
      this.#deliveryRoot,
      handoff.idempotency_key.replace(/[^a-zA-Z0-9._-]/gu, "_"),
    );
    if (await exists(join(directory, ".git"))) return directory;
    await mkdir(this.#deliveryRoot, { recursive: true });
    const temporary = `${directory}.${randomUUID()}.tmp`;
    await exec(
      "git",
      [
        "clone",
        "--no-checkout",
        "--origin",
        "origin",
        this.#remoteUrl,
        temporary,
      ],
      {
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await mkdir(dirname(directory), { recursive: true });
    const { rename } = await import("node:fs/promises");
    try {
      await rename(temporary, directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!(await exists(join(directory, ".git")))) throw error;
    }
    return directory;
  }

  async #assertExternalRoot(): Promise<void> {
    const workspaceRoot = await realpath(this.#workspaceRoot);
    let existing = this.#deliveryRoot;
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
        "delivery worktree root must be outside the agent workspace",
      );
    }
  }
}
