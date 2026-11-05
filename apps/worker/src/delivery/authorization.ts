import type { ValidatedDeliveryHandoff } from "./handoff.js";

export class DeliveryAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeliveryAuthorizationError";
  }
}

export interface DeliveryAuthorizer {
  authorize(handoff: ValidatedDeliveryHandoff): Promise<void>;
}

export type ApprovedDeliveryTask = {
  taskId: string;
  workstreamId: string;
  assignedTo: "Engineer";
  reviewerApproved: boolean;
  repository: { host: string; owner: string; name: string };
  baseRef: string;
  branchPrefix: string;
  allowedFiles: string[];
};

/**
 * Fail-closed authorization snapshot supplied by the control plane after it
 * authenticates the handoff source. The executor never infers approval from
 * handoff claims.
 */
export class StaticDeliveryAuthorizer implements DeliveryAuthorizer {
  readonly #tasks: ApprovedDeliveryTask[];

  constructor(tasks: ApprovedDeliveryTask[]) {
    this.#tasks = tasks;
  }

  async authorize(handoff: ValidatedDeliveryHandoff): Promise<void> {
    const approval = this.#tasks.find(
      (task) =>
        task.taskId === handoff.task_id &&
        task.workstreamId === handoff.workstream_id,
    );
    if (!approval || approval.assignedTo !== "Engineer") {
      throw new DeliveryAuthorizationError("task_not_approved");
    }
    if (!approval.reviewerApproved) {
      throw new DeliveryAuthorizationError("reviewer_approval_missing");
    }
    if (
      approval.repository.host !== handoff.repository.host ||
      approval.repository.owner !== handoff.repository.owner ||
      approval.repository.name !== handoff.repository.name
    ) {
      throw new DeliveryAuthorizationError("repository_not_authorized");
    }
    if (approval.baseRef !== handoff.base_ref) {
      throw new DeliveryAuthorizationError("base_ref_not_authorized");
    }
    if (!handoff.branch.startsWith(approval.branchPrefix)) {
      throw new DeliveryAuthorizationError("branch_not_authorized");
    }
    const allowed = new Set(approval.allowedFiles);
    if (handoff.changed_files.some((path) => !allowed.has(path))) {
      throw new DeliveryAuthorizationError("file_scope_not_authorized");
    }
  }
}

export class DenyAllDeliveryAuthorizer implements DeliveryAuthorizer {
  async authorize(): Promise<void> {
    throw new DeliveryAuthorizationError("task_not_approved");
  }
}
