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

export type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding | "buffer";
  maxBuffer?: number;
};

export type GitCommandRunner = (
  command: string,
  args: string[],
  options: GitCommandOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const defaultGitCommandRunner: GitCommandRunner = async (
  command,
  args,
  options,
) => {
  const result = await exec(command, args, options as never);
  return { stdout: result.stdout, stderr: result.stderr };
};

export type GitHubRemoteUrlBuilder = (
  repository: ValidatedDeliveryHandoff["repository"],
) => string;

const githubRemoteUrl: GitHubRemoteUrlBuilder = (repository) =>
  `https://github.com/${repository.owner}/${repository.name}.git`;

const credentialHelper =
  '!f() { printf "username=agentweave-delivery\\n"; printf "password=%s\\n" "$AGENTWEAVE_GIT_TOKEN"; }; f';

function outputText(output: string | Buffer): string {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function redactedError(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.split(secret).join("[REDACTED]"));
}

function repositoryDirectoryName(
  repository: ValidatedDeliveryHandoff["repository"],
): string {
  return `${repository.owner}__${repository.name}`.replace(
    /[^a-zA-Z0-9._-]/gu,
    "_",
  );
}

/**
 * GitHub-backed delivery transport. The remote URL is deliberately clean;
 * authentication is supplied to each authenticated git child only through a
 * process environment credential helper configured with GIT_CONFIG_*.
 */
export class GitHubGitClient implements DeliveryGitClient {
  readonly #deliveryRoot: string;
  readonly #workspaceRoot?: string;
  readonly #runGit: GitCommandRunner;
  readonly #remoteUrlBuilder: GitHubRemoteUrlBuilder;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: {
    deliveryRoot: string;
    workspaceRoot?: string;
    runGit?: GitCommandRunner;
    remoteUrlBuilder?: GitHubRemoteUrlBuilder;
  }) {
    this.#deliveryRoot = resolve(options.deliveryRoot);
    this.#workspaceRoot = options.workspaceRoot
      ? resolve(options.workspaceRoot)
      : undefined;
    this.#runGit = options.runGit ?? defaultGitCommandRunner;
    this.#remoteUrlBuilder = options.remoteUrlBuilder ?? githubRemoteUrl;
  }

  async findRemoteBranch(
    handoff: ValidatedDeliveryHandoff,
    credential: CredentialHandle,
  ): Promise<RemoteDeliveryBranch | undefined> {
    return this.#serialized(handoff, async () => {
      const remoteUrl = this.#remoteUrlBuilder(handoff.repository);
      const repository = await this.#repository(handoff, credential);
      const branchReference = `refs/heads/${handoff.branch}`;
      const result = await this.#authenticated(
        credential,
        "git",
        ["ls-remote", "--heads", remoteUrl, branchReference],
        { maxBuffer: 1024 * 1024 },
      );
      const commit = outputText(result.stdout).trim().split(/\s+/u)[0];

      // Fetch the base even when the delivery branch does not exist. The
      // subsequent credential-free commit step can then check out origin/base.
      await this.#authenticated(
        credential,
        "git",
        ["fetch", "--force", "origin", handoff.base_ref],
        { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
      );
      if (!commit) return undefined;

      await this.#authenticated(
        credential,
        "git",
        [
          "fetch",
          "--force",
          "origin",
          `${branchReference}:refs/remotes/origin/${handoff.branch}`,
        ],
        { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
      );
      const message = await this.#runGit(
        "git",
        ["show", "-s", "--format=%B", `refs/remotes/origin/${handoff.branch}`],
        { cwd: repository, maxBuffer: 1024 * 1024 },
      );
      const marker = outputText(message.stdout)
        .match(/^AgentWeave-Idempotency-Key:\s*(.+)$/mu)?.[1]
        ?.trim();
      return { commit, ...(marker ? { idempotencyKey: marker } : {}) };
    });
  }

  async hasLocalCommit(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
  ): Promise<boolean> {
    try {
      const repository = await this.#repository(handoff);
      await this.#runGit("git", ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: repository,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createCommit(handoff: ValidatedDeliveryHandoff): Promise<string> {
    return this.#serialized(handoff, async () => {
      const repository = await this.#repository(handoff);
      await this.#runGit(
        "git",
        [
          "checkout",
          "--force",
          "-B",
          handoff.branch,
          `origin/${handoff.base_ref}`,
        ],
        { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
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

      await this.#runGit(
        "git",
        ["add", "--all", "--", ...handoff.changed_files],
        { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
      );
      const changed = await this.#runGit(
        "git",
        ["diff", "--cached", "--name-only", "-z"],
        { cwd: repository, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
      );
      const actual = outputText(changed.stdout)
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

      await this.#runGit(
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
      const result = await this.#runGit("git", ["rev-parse", "HEAD"], {
        cwd: repository,
      });
      return outputText(result.stdout).trim();
    });
  }

  async push(
    handoff: ValidatedDeliveryHandoff,
    commit: string,
    credential: CredentialHandle,
  ): Promise<void> {
    await this.#serialized(handoff, async () => {
      const repository = await this.#repository(handoff);
      await this.#authenticated(
        credential,
        "git",
        ["push", "origin", `${commit}:refs/heads/${handoff.branch}`],
        { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
      );
    });
  }

  async #repository(
    handoff: ValidatedDeliveryHandoff,
    credential?: CredentialHandle,
  ): Promise<string> {
    await this.#assertExternalRoot(handoff);
    const directory = join(
      this.#deliveryRoot,
      repositoryDirectoryName(handoff.repository),
    );
    if (await exists(join(directory, ".git"))) return directory;
    if (!credential) throw new Error("delivery_repository_uninitialized");

    await mkdir(this.#deliveryRoot, { recursive: true });
    const temporary = `${directory}.${randomUUID()}.tmp`;
    try {
      await this.#authenticated(
        credential,
        "git",
        [
          "clone",
          "--no-checkout",
          "--origin",
          "origin",
          this.#remoteUrlBuilder(handoff.repository),
          temporary,
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const { rename } = await import("node:fs/promises");
      try {
        await rename(temporary, directory);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (!(await exists(join(directory, ".git")))) throw error;
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return directory;
  }

  async #authenticated(
    credential: CredentialHandle,
    command: string,
    args: string[],
    options: GitCommandOptions,
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return credential.use(async (secret) => {
      if (args.some((argument) => argument.includes(secret))) {
        throw new Error("credential_value_forbidden");
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: credentialHelper,
        AGENTWEAVE_GIT_TOKEN: secret,
      };
      try {
        return await this.#runGit(command, args, { ...options, env });
      } catch (error) {
        throw redactedError(error, secret);
      }
    });
  }

  async #serialized<T>(
    handoff: ValidatedDeliveryHandoff,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${handoff.repository.host}/${handoff.repository.owner}/${handoff.repository.name}`;
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }

  async #assertExternalRoot(
    handoff: ValidatedDeliveryHandoff,
  ): Promise<void> {
    const workspaceRoot = this.#workspaceRoot
      ? await realpath(this.#workspaceRoot)
      : undefined;
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
    const roots = workspaceRoot
      ? [workspaceRoot]
      : handoff.files.map((file) => resolve(file.sourcePath));
    for (const root of roots) {
      const rel = relative(root, resolvedExisting);
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
}

export type FetchImplementation = typeof fetch;

const apiHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

function idempotencyMarker(idempotencyKey: string): string {
  return `<!-- agentweave-delivery:${idempotencyKey} -->`;
}

function markerFromBody(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  return body.match(/<!--\s*agentweave-delivery:([^\s]+)\s*-->/u)?.[1];
}

export class GitHubPullRequestClient implements PullRequestClient {
  readonly #apiBaseUrl: string;
  readonly #fetch: FetchImplementation;

  constructor(
    options: {
      fetchImpl?: FetchImplementation;
      apiBaseUrl?: string;
    } = {},
  ) {
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/$/u,
      "",
    );
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async findOpenPullRequest(
    handoff: ValidatedDeliveryHandoff,
    credential: CredentialHandle,
  ): Promise<PullRequestRecord | undefined> {
    return credential.use(async (secret) => {
      const url = `${this.#pullsUrl(handoff)}?state=open&head=${encodeURIComponent(`${handoff.repository.owner}:${handoff.branch}`)}`;
      const response = await this.#request(
        secret,
        url,
        { method: "GET", headers: { ...apiHeaders, Authorization: `Bearer ${secret}` } },
      );
      const records = await this.#jsonArray(response, secret);
      const record = records[0];
      if (!record) return undefined;
      const urlValue = typeof record.html_url === "string" ? record.html_url : undefined;
      if (!urlValue) throw new Error("github_pull_request_response_invalid");
      if (urlValue.includes(secret)) throw new Error("credential_value_forbidden");
      return {
        url: urlValue,
        branch: handoff.branch,
        idempotencyKey: markerFromBody(record.body) ?? "",
      };
    });
  }

  async openPullRequest(
    input: { handoff: ValidatedDeliveryHandoff; commit: string },
    credential: CredentialHandle,
  ): Promise<PullRequestRecord> {
    return credential.use(async (secret) => {
      const { handoff, commit } = input;
      const body = [
        `Task: ${handoff.task_id}`,
        `Commit: ${commit}`,
        `Changed files: ${handoff.changed_files.join(", ")}`,
        "",
        idempotencyMarker(handoff.idempotency_key),
      ].join("\n");
      const response = await this.#request(
        secret,
        this.#pullsUrl(handoff),
        {
          method: "POST",
          headers: {
            ...apiHeaders,
            "content-type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({
            title: handoff.commit_summary,
            head: handoff.branch,
            base: handoff.base_ref,
            body,
          }),
        },
      );
      const record = (await this.#json(response, secret)) as Record<string, unknown>;
      const url = typeof record.html_url === "string" ? record.html_url : undefined;
      if (!url) throw new Error("github_pull_request_response_invalid");
      if (url.includes(secret)) throw new Error("credential_value_forbidden");
      return {
        url,
        branch: handoff.branch,
        idempotencyKey: handoff.idempotency_key,
      };
    });
  }

  #pullsUrl(handoff: ValidatedDeliveryHandoff): string {
    return `${this.#apiBaseUrl}/repos/${handoff.repository.owner}/${handoff.repository.name}/pulls`;
  }

  async #request(
    secret: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      if (
        url.includes(secret) ||
        (typeof init.body === "string" && init.body.includes(secret))
      ) {
        throw new Error("credential_value_forbidden");
      }
      const response = await this.#fetch(url, init);
      if (!response.ok) {
        let detail = "request rejected";
        try {
          detail = (await response.text()).split(secret).join("[REDACTED]");
        } catch {
          /* Preserve the status if the error body is unavailable. */
        }
        throw new Error(
          `github_api_request_failed:${response.status}:${detail.slice(0, 240)}`,
        );
      }
      return response;
    } catch (error) {
      throw redactedError(error, secret);
    }
  }

  async #json(response: Response, secret: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw redactedError(new Error("github_response_invalid_json"), secret);
    }
  }

  async #jsonArray(response: Response, secret: string): Promise<Record<string, unknown>[]> {
    const value = await this.#json(response, secret);
    if (!Array.isArray(value)) throw new Error("github_pull_request_list_invalid");
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );
  }
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
