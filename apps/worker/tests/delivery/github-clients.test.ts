import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubGitClient,
  GitHubPullRequestClient,
  type GitCommandRunner,
} from "../../src/delivery/clients.js";
import {
  validateDeliveryHandoff,
  type ValidatedDeliveryHandoff,
} from "../../src/delivery/handoff.js";
import type { CredentialHandle } from "../../src/delivery/secret-store.js";
import {
  NOW,
  SECRET_VALUE,
  createFixture,
  createHandoff,
  git,
  type Fixture,
} from "./helpers.js";

const exec = promisify(execFile);
const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function credential(): CredentialHandle {
  return {
    name: "github/bayshanhai-dev/agentweave/push",
    use: async (consumer) => consumer(SECRET_VALUE),
  };
}

async function validated(
  fixture: Fixture,
  files: string[] = ["change.txt"],
): Promise<ValidatedDeliveryHandoff> {
  await writeFile(join(fixture.workspace, files[0]), "delivery\n");
  const handoff = await createHandoff(fixture.workspace, files);
  return validateDeliveryHandoff(handoff, {
    workspaceRoot: fixture.workspace,
    now: NOW,
  });
}

describe("GitHubPullRequestClient", () => {
  it("uses the GitHub list/create shapes and round-trips the marker", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const handoff = await validated(fixture);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              html_url: "https://github.com/bayshanhai-dev/agentweave/pull/7",
              body: `Task\n<!-- agentweave-delivery:${handoff.idempotency_key} -->`,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: "https://github.com/bayshanhai-dev/agentweave/pull/8",
          }),
          { status: 201 },
        ),
      );
    const client = new GitHubPullRequestClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.findOpenPullRequest(handoff, credential())).resolves.toEqual({
      url: "https://github.com/bayshanhai-dev/agentweave/pull/7",
      branch: handoff.branch,
      idempotencyKey: handoff.idempotency_key,
    });
    await expect(
      client.openPullRequest({ handoff, commit: "a".repeat(40) }, credential()),
    ).resolves.toEqual({
      url: "https://github.com/bayshanhai-dev/agentweave/pull/8",
      branch: handoff.branch,
      idempotencyKey: handoff.idempotency_key,
    });

    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(first[0]).toBe(
      `https://api.github.com/repos/bayshanhai-dev/agentweave/pulls?state=open&head=${encodeURIComponent(`bayshanhai-dev:${handoff.branch}`)}`,
    );
    expect(first[1].method).toBe("GET");
    const firstHeaders = first[1].headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe(`Bearer ${SECRET_VALUE}`);
    const second = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[0]).toBe(
      "https://api.github.com/repos/bayshanhai-dev/agentweave/pulls",
    );
    expect(second[1].method).toBe("POST");
    const body = JSON.parse(String(second[1].body)) as Record<string, string>;
    expect(body).toEqual({
      title: handoff.commit_summary,
      head: handoff.branch,
      base: handoff.base_ref,
      body: expect.stringContaining(
        `<!-- agentweave-delivery:${handoff.idempotency_key} -->`,
      ),
    });
    expect(JSON.stringify([first[0], body])).not.toContain(SECRET_VALUE);
  });

  it("redacts token-free API failures while retaining status", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const handoff = await validated(fixture);
    const client = new GitHubPullRequestClient({
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(`bad ${SECRET_VALUE}`, { status: 403 }),
        ) as unknown as typeof fetch,
    });
    await expect(client.findOpenPullRequest(handoff, credential())).rejects.toThrow(
      `github_api_request_failed:403:bad [REDACTED]`,
    );
  });
});

describe("GitHubGitClient", () => {
  it("clones, scopes, commits, pushes, and finds a branch through file transport", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const handoff = await validated(fixture);
    const client = new GitHubGitClient({
      deliveryRoot: fixture.deliveryRoot,
      workspaceRoot: fixture.workspace,
      remoteUrlBuilder: () => fixture.remote,
    });

    expect(await client.findRemoteBranch(handoff, credential())).toBeUndefined();
    const commit = await client.createCommit(handoff);
    await client.push(handoff, commit, credential());
    const branch = await client.findRemoteBranch(handoff, credential());
    expect(branch).toEqual({ commit, idempotencyKey: handoff.idempotency_key });

    const checkout = join(fixture.root, "github-client-checkout");
    await git(fixture.root, ["clone", "--branch", handoff.branch, fixture.remote, checkout]);
    expect(await readFile(join(checkout, "change.txt"), "utf8")).toBe("delivery\n");
    expect(await readFile(join(checkout, "base.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(fixture.deliveryRoot, "bayshanhai-dev__agentweave", ".git", "config"), "utf8")).not.toContain(SECRET_VALUE);
  });

  it("keeps the GitHub URL in argv/config and the token only in authenticated env", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const handoff = await validated(fixture);
    const captured: Array<{ args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
    const runGit: GitCommandRunner = async (command, args, options) => {
      captured.push({ args, options });
      return exec(command, args, options as never);
    };
    const client = new GitHubGitClient({
      deliveryRoot: fixture.deliveryRoot,
      workspaceRoot: fixture.workspace,
      runGit,
      remoteUrlBuilder: () => fixture.remote,
    });
    await client.findRemoteBranch(handoff, credential());
    expect(captured.flatMap((entry) => entry.args).join(" ")).not.toContain(SECRET_VALUE);
    expect(captured.map((entry) => entry.options.env?.AGENTWEAVE_GIT_TOKEN)).toContain(SECRET_VALUE);
    expect(captured.map((entry) => entry.options.env?.GIT_CONFIG_VALUE_0).filter(Boolean).join("\n")).not.toContain(SECRET_VALUE);
    expect(captured.flatMap((entry) => entry.args)).toContain(fixture.remote);
  });
});
