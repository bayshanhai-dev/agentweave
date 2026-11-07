import type {
  DeliveryBlockedReport,
  DeliveryCiStatus,
  DeliveryReportPublisher,
  DeliverySucceededReport,
} from "../delivery-report.js";
import {
  HandoffValidationError,
  safeHandoffIdentity,
  validateDeliveryHandoff,
  type DeliveryHandoff,
  type ValidatedDeliveryHandoff,
} from "./handoff.js";
import {
  DeliveryAuthorizationError,
  type DeliveryAuthorizer,
} from "./authorization.js";
import type { DeliveryGitClient, PullRequestClient } from "./clients.js";
import {
  ReceiptCollisionError,
  type DeliveryReceipt,
  type DeliveryReceiptStore,
} from "./receipt-store.js";
import {
  CredentialStoreError,
  type CredentialHandle,
  type SecretStoreAdapter,
} from "./secret-store.js";
import { readFile } from "node:fs/promises";

export type DeliveryAttemptResult =
  | {
      status: "succeeded";
      report: DeliverySucceededReport;
      receipt: DeliveryReceipt;
    }
  | {
      status: "blocked";
      report: DeliveryBlockedReport;
      receipt?: DeliveryReceipt;
    };

type ExecutorOptions = {
  authorizer: DeliveryAuthorizer;
  receipts: DeliveryReceiptStore;
  secrets: SecretStoreAdapter;
  git: DeliveryGitClient;
  pullRequests: PullRequestClient;
  reports: DeliveryReportPublisher;
  ciStatus?: DeliveryCiStatus;
  now?: () => Date;
};

function publicHandoff(handoff: ValidatedDeliveryHandoff): DeliveryHandoff {
  return {
    schema: handoff.schema,
    task_id: handoff.task_id,
    workstream_id: handoff.workstream_id,
    run_id: handoff.run_id,
    repository: handoff.repository,
    base_ref: handoff.base_ref,
    branch: handoff.branch,
    commit_summary: handoff.commit_summary,
    changed_files: handoff.changed_files,
    requested_actor: handoff.requested_actor,
    credential_ref: handoff.credential_ref,
    idempotency_key: handoff.idempotency_key,
    status: handoff.status,
    created_at: handoff.created_at,
    expires_at: handoff.expires_at,
    agent_boundary: handoff.agent_boundary,
  };
}

type BlockOptions = {
  input: unknown;
  workstreamId: string;
  reason: string;
  attemptedAction: string;
  evidence: string;
  nextOwner: DeliveryBlockedReport["next_owner"];
  nextAction: string;
  receipt?: DeliveryReceipt;
  handoff?: ValidatedDeliveryHandoff;
  routeToDeputy?: boolean;
};

export class DeliveryExecutor {
  readonly #authorizer: DeliveryAuthorizer;
  readonly #receipts: DeliveryReceiptStore;
  readonly #secrets: SecretStoreAdapter;
  readonly #git: DeliveryGitClient;
  readonly #pullRequests: PullRequestClient;
  readonly #reports: DeliveryReportPublisher;
  readonly #ciStatus: DeliveryCiStatus;
  readonly #now: () => Date;

  constructor(options: ExecutorOptions) {
    this.#authorizer = options.authorizer;
    this.#receipts = options.receipts;
    this.#secrets = options.secrets;
    this.#git = options.git;
    this.#pullRequests = options.pullRequests;
    this.#reports = options.reports;
    this.#ciStatus = options.ciStatus ?? "ci_pending";
    this.#now = options.now ?? (() => new Date());
  }

  async execute(
    input: unknown,
    context: { workspaceRoot: string; workstreamId: string },
  ): Promise<DeliveryAttemptResult> {
    let handoff: ValidatedDeliveryHandoff;
    try {
      handoff = await validateDeliveryHandoff(input, {
        workspaceRoot: context.workspaceRoot,
        now: this.#now(),
      });
    } catch (error) {
      const reason =
        error instanceof HandoffValidationError
          ? error.code
          : "handoff_validation_failed";
      return this.#block({
        input,
        workstreamId: context.workstreamId,
        reason,
        attemptedAction: "validate_handoff",
        evidence: "delivery-receipt:unavailable",
        nextOwner: "worker",
        nextAction: "Issue a fresh valid delivery-path/v1 handoff.",
      });
    }

    if (handoff.workstream_id !== context.workstreamId) {
      return this.#block({
        input,
        handoff,
        workstreamId: context.workstreamId,
        reason: "workstream_identity_mismatch",
        attemptedAction: "validate_handoff",
        evidence: "delivery-receipt:unavailable",
        nextOwner: "worker",
        nextAction: "Submit the handoff to its declared workstream.",
      });
    }

    try {
      await this.#authorizer.authorize(handoff);
    } catch (error) {
      const reason =
        error instanceof DeliveryAuthorizationError
          ? error.code
          : "authorization_failed";
      return this.#block({
        input,
        handoff,
        workstreamId: context.workstreamId,
        reason,
        attemptedAction: "authorize_handoff",
        evidence: "delivery-receipt:unavailable",
        nextOwner: "Reviewer",
        nextAction:
          "Record or correct the task approval before retrying delivery.",
      });
    }

    let receipt: DeliveryReceipt;
    try {
      receipt = await this.#receipts.accept(handoff);
    } catch (error) {
      const reason =
        error instanceof ReceiptCollisionError
          ? error.code
          : "receipt_accept_failed";
      return this.#block({
        input,
        handoff,
        workstreamId: context.workstreamId,
        reason,
        attemptedAction: "accept_receipt",
        evidence: this.#receipts.reference(handoff.idempotency_key),
        nextOwner: "Maintainer",
        nextAction:
          "Resolve the receipt collision and issue a new run identifier if needed.",
      });
    }

    if (receipt.state === "pr_opened" && receipt.commit && receipt.prUrl) {
      return this.#succeed(handoff, receipt);
    }

    let credential: CredentialHandle;
    if (handoff.credential_ref.store !== this.#secrets.store) {
      return this.#block({
        input,
        handoff,
        workstreamId: context.workstreamId,
        reason: "credential_unauthorized",
        attemptedAction: "resolve_credential",
        evidence: this.#receipts.reference(handoff.idempotency_key),
        nextOwner: "Maintainer",
        nextAction:
          "Configure the authorized secret-store adapter for this handoff.",
        receipt,
      });
    }
    try {
      credential = await this.#secrets.resolve(handoff.credential_ref.name, {
        repository: handoff.repository,
      });
    } catch (error) {
      const reason =
        error instanceof CredentialStoreError
          ? error.reason
          : "credential_malformed";
      const unprovisioned = reason === "credential_unprovisioned";
      return this.#block({
        input,
        handoff,
        workstreamId: context.workstreamId,
        reason,
        attemptedAction: "resolve_credential",
        evidence: this.#receipts.reference(handoff.idempotency_key),
        nextOwner: unprovisioned ? "human_deputy" : "Maintainer",
        nextAction: unprovisioned
          ? "Provision the repo-scoped credential or deliver the unchanged handoff as deputy."
          : "Repair the authorized secret-store entry before retrying.",
        receipt,
        routeToDeputy: unprovisioned,
      });
    }

    if (await this.#handoffContainsCredential(handoff, credential)) {
      return this.#blockOperation(
        input,
        context.workstreamId,
        handoff,
        receipt,
        "credential_value_forbidden",
        "scan_delivery_scope_for_credentials",
        "Remove the credential value from the handoff and declared files, then issue a fresh run.",
      );
    }

    let remoteBranch;
    let remotePullRequest;
    try {
      [remoteBranch, remotePullRequest] = await Promise.all([
        this.#git.findRemoteBranch(handoff, credential),
        this.#pullRequests.findOpenPullRequest(handoff, credential),
      ]);
    } catch {
      return this.#blockOperation(
        input,
        context.workstreamId,
        handoff,
        receipt,
        "remote_inspection_failed",
        "inspect_remote_branch_and_pr",
        "Retry after remote access is restored.",
      );
    }

    if (remoteBranch) {
      if (remoteBranch.idempotencyKey !== handoff.idempotency_key) {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "branch_conflict",
          "reuse_remote_branch",
          "Choose a new authorized branch for this delivery.",
        );
      }
      if (receipt.commit && receipt.commit !== remoteBranch.commit) {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "remote_branch_mismatch",
          "reuse_remote_branch",
          "Inspect the durable receipt and remote branch before retrying.",
        );
      }
      receipt = {
        ...receipt,
        commit: remoteBranch.commit,
        state: "pushed",
      };
      await this.#receipts.save(receipt);
    }

    if (remotePullRequest) {
      if (
        await this.#textContainsCredential(remotePullRequest.url, credential)
      ) {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "credential_value_forbidden",
          "reuse_pull_request",
          "Remove credential material from the pull-request record before retrying.",
        );
      }
      if (
        !remoteBranch ||
        remotePullRequest.branch !== handoff.branch ||
        remotePullRequest.idempotencyKey !== handoff.idempotency_key
      ) {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "pull_request_conflict",
          "reuse_pull_request",
          "Resolve the conflicting pull request before retrying.",
        );
      }
      receipt = {
        ...receipt,
        commit: remoteBranch.commit,
        prUrl: remotePullRequest.url,
        state: "pr_opened",
      };
      await this.#receipts.save(receipt);
      return this.#succeed(handoff, receipt);
    }

    if (!receipt.commit) {
      try {
        const commit = await this.#git.createCommit(handoff);
        receipt = {
          ...receipt,
          commit,
          state: "committed",
          blockedReason: undefined,
        };
        await this.#receipts.save(receipt);
      } catch {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "commit_failed",
          "create_commit",
          "Correct the declared file scope or delivery worktree and retry.",
        );
      }
    } else if (
      !remoteBranch &&
      !(await this.#git.hasLocalCommit(handoff, receipt.commit))
    ) {
      return this.#blockOperation(
        input,
        context.workstreamId,
        handoff,
        receipt,
        "receipt_inconsistent",
        "resume_commit",
        "Restore the durable delivery worktree for the recorded commit.",
      );
    }

    const commit = receipt.commit;
    if (!commit) {
      return this.#blockOperation(
        input,
        context.workstreamId,
        handoff,
        receipt,
        "receipt_inconsistent",
        "resume_commit",
        "Restore the durable delivery receipt before retrying.",
      );
    }

    if (!remoteBranch) {
      try {
        await this.#git.push(handoff, commit, credential);
        receipt = { ...receipt, state: "pushed", blockedReason: undefined };
        await this.#receipts.save(receipt);
      } catch {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "push_failed",
          "push_branch",
          "Restore remote push access and retry the same handoff.",
        );
      }
    }

    try {
      const existing = await this.#pullRequests.findOpenPullRequest(
        handoff,
        credential,
      );
      const pullRequest =
        existing ??
        (await this.#pullRequests.openPullRequest(
          { handoff, commit },
          credential,
        ));
      if (await this.#textContainsCredential(pullRequest.url, credential)) {
        return this.#blockOperation(
          input,
          context.workstreamId,
          handoff,
          receipt,
          "credential_value_forbidden",
          "open_pull_request",
          "Remove credential material from the pull-request result before retrying.",
        );
      }
      if (
        pullRequest.branch !== handoff.branch ||
        pullRequest.idempotencyKey !== handoff.idempotency_key
      ) {
        throw new Error("pull_request_conflict");
      }
      receipt = {
        ...receipt,
        prUrl: pullRequest.url,
        state: "pr_opened",
        blockedReason: undefined,
      };
      await this.#receipts.save(receipt);
    } catch {
      return this.#blockOperation(
        input,
        context.workstreamId,
        handoff,
        receipt,
        "pr_open_failed",
        "open_pull_request",
        "Restore pull-request API access and retry the same handoff.",
      );
    }

    return this.#succeed(handoff, receipt);
  }

  async #handoffContainsCredential(
    handoff: ValidatedDeliveryHandoff,
    credential: CredentialHandle,
  ): Promise<boolean> {
    return credential.use(async (value) => {
      if (!value) return true;
      if (JSON.stringify(publicHandoff(handoff)).includes(value)) return true;
      const credentialBytes = Buffer.from(value);
      for (const file of handoff.files) {
        if (!file.exists) continue;
        if ((await readFile(file.sourcePath)).indexOf(credentialBytes) !== -1)
          return true;
      }
      return false;
    });
  }

  async #textContainsCredential(
    text: string,
    credential: CredentialHandle,
  ): Promise<boolean> {
    return credential.use(async (value) => !value || text.includes(value));
  }

  async #succeed(
    handoff: ValidatedDeliveryHandoff,
    receipt: DeliveryReceipt,
  ): Promise<DeliveryAttemptResult> {
    if (!receipt.commit || !receipt.prUrl) {
      throw new Error("successful receipt is missing durable evidence");
    }
    const report: DeliverySucceededReport = {
      event: "delivery.succeeded",
      schema: "delivery-path/v1",
      task_id: handoff.task_id,
      workstream_id: handoff.workstream_id,
      run_id: handoff.run_id,
      idempotency_key: handoff.idempotency_key,
      repository: handoff.repository,
      branch: handoff.branch,
      base_ref: handoff.base_ref,
      commit: receipt.commit,
      changed_files: handoff.changed_files,
      pr_url: receipt.prUrl,
      ci_status: this.#ciStatus,
      credential_ref: {
        store: handoff.credential_ref.store,
        name: handoff.credential_ref.name,
      },
      evidence: this.#receipts.reference(handoff.idempotency_key),
    };
    await this.#reports.publish(handoff.workstream_id, report);
    return { status: "succeeded", report, receipt };
  }

  async #blockOperation(
    input: unknown,
    workstreamId: string,
    handoff: ValidatedDeliveryHandoff,
    receipt: DeliveryReceipt,
    reason: string,
    attemptedAction: string,
    nextAction: string,
  ): Promise<DeliveryAttemptResult> {
    const blocked = {
      ...receipt,
      state: "blocked" as const,
      blockedReason: reason,
    };
    await this.#receipts.save(blocked);
    return this.#block({
      input,
      handoff,
      workstreamId,
      reason,
      attemptedAction,
      evidence: this.#receipts.reference(handoff.idempotency_key),
      nextOwner: "worker",
      nextAction,
      receipt: blocked,
    });
  }

  async #block(options: BlockOptions): Promise<DeliveryAttemptResult> {
    let receipt = options.receipt;
    if (receipt && receipt.state !== "blocked") {
      receipt = {
        ...receipt,
        state: "blocked",
        blockedReason: options.reason,
      };
      await this.#receipts.save(receipt);
    }
    const identity = options.handoff ?? safeHandoffIdentity(options.input);
    const report: DeliveryBlockedReport = {
      event: "delivery.blocked",
      schema: "delivery-path/v1",
      task_id: identity.task_id,
      workstream_id: identity.workstream_id,
      run_id: identity.run_id,
      status: "BLOCKED",
      reason: options.reason,
      attempted_action: options.attemptedAction,
      evidence: options.evidence,
      next_owner: options.nextOwner,
      next_action: options.nextAction,
      blocked_since: this.#now().toISOString(),
    };
    await this.#reports.publish(
      options.workstreamId,
      report,
      options.routeToDeputy && options.handoff
        ? { recipient: "human_deputy", handoff: publicHandoff(options.handoff) }
        : undefined,
    );
    return { status: "blocked", report, ...(receipt ? { receipt } : {}) };
  }
}
