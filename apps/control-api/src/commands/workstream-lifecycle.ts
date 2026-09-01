import { randomUUID } from "node:crypto";
import { canTransition, type WorkstreamStatus } from "@agentweave/domain";

type LifecycleAgent = {
  id: string;
  status: "idle" | "running" | "paused" | "stopped" | "failed" | "done";
};
type LifecycleWorkstream = {
  id: string;
  status: string;
  agents: LifecycleAgent[];
};
type LifecycleCommand =
  "pause" | "resume" | "complete" | "emergency-stop" | "waiting-for-human";
type CommandBody = {
  commandId?: string;
  reason?: string;
  decision?: "resume" | "complete" | "reject";
};
type EmitLifecycleEvent = (type: string, message: string) => void;
type CommandRepository = {
  findResponse(
    workstreamId: string,
    commandId: string,
  ): Promise<unknown | undefined>;
  commit(input: {
    workstreamId: string;
    commandId: string;
    command: string;
    status: string;
    agents: LifecycleAgent[];
    response: unknown;
  }): Promise<void>;
};

export class WorkstreamCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "workstream_command_failed"));
  }
}

export class WorkstreamLifecycleCommandHandler {
  constructor(private readonly repository: CommandRepository) {}

  async execute(
    workstream: LifecycleWorkstream,
    command: LifecycleCommand,
    body: CommandBody,
    emit: EmitLifecycleEvent,
  ): Promise<unknown> {
    if (
      ["completing", "completed", "archived", "emergency_stopped"].includes(
        workstream.status,
      )
    )
      throw new WorkstreamCommandError(409, {
        error: "workstream_not_actionable",
        status: workstream.status,
      });
    const commandId = body.commandId?.trim() || randomUUID();
    const existing = await this.repository.findResponse(
      workstream.id,
      commandId,
    );
    if (existing) return existing;
    const targetByCommand = {
      pause: "paused",
      resume: "active",
      complete: "completed",
      "emergency-stop": "emergency_stopped",
      "waiting-for-human": "waiting_for_human",
    } as const;
    const target = targetByCommand[command];
    const current = workstream.status as WorkstreamStatus;
    const transitionTarget: WorkstreamStatus =
      command === "pause"
        ? "pausing"
        : command === "resume"
          ? "resuming"
          : command === "complete"
            ? "completing"
            : target;
    if (
      !(command === "emergency-stop" && current !== "archived") &&
      !canTransition(current, transitionTarget)
    )
      throw new WorkstreamCommandError(409, {
        error: "invalid_workstream_transition",
        from: current,
        to: target,
      });
    if (command === "pause") {
      workstream.status = "pausing";
      emit("workstream.pausing", body.reason?.trim() || "Pause requested");
      workstream.status = "paused";
    } else if (command === "resume") {
      workstream.status = "resuming";
      emit("workstream.resuming", body.reason?.trim() || "Resume requested");
      workstream.status = "active";
    } else if (command === "complete") {
      workstream.status = "completing";
      emit(
        "workstream.completing",
        body.reason?.trim() || "Completion requested",
      );
      workstream.status = "completed";
    } else workstream.status = target;
    if (command === "pause" || command === "waiting-for-human")
      workstream.agents.forEach((agent) => {
        if (agent.status === "running" || agent.status === "idle")
          agent.status = "paused";
      });
    if (command === "emergency-stop")
      workstream.agents.forEach((agent) => {
        if (agent.status !== "done") agent.status = "stopped";
      });
    if (command === "complete")
      workstream.agents.forEach((agent) => {
        agent.status = "done";
      });
    if (target === "active")
      workstream.agents.forEach((agent) => {
        if (agent.status !== "done" && agent.status !== "stopped")
          agent.status = "idle";
      });
    emit(
      command === "emergency-stop"
        ? "workstream.emergency_stopped"
        : `workstream.${command.replaceAll("-", "_")}`,
      body.reason?.trim() ||
        `Workstream ${command.replaceAll("-", " ")} requested`,
    );
    const response = {
      commandId,
      workstreamId: workstream.id,
      command,
      status: workstream.status,
      accepted: true,
    };
    await this.repository.commit({
      workstreamId: workstream.id,
      commandId,
      command,
      status: workstream.status,
      agents: workstream.agents,
      response,
    });
    return response;
  }

  async approve(
    workstream: LifecycleWorkstream,
    body: CommandBody,
    emit: EmitLifecycleEvent,
  ): Promise<unknown> {
    if (
      body.decision !== "resume" &&
      body.decision !== "complete" &&
      body.decision !== "reject"
    )
      throw new WorkstreamCommandError(400, { error: "decision_required" });
    const commandId = body.commandId?.trim() || randomUUID();
    const existing = await this.repository.findResponse(
      workstream.id,
      commandId,
    );
    if (existing) return existing;
    const target: WorkstreamStatus =
      body.decision === "resume"
        ? "active"
        : body.decision === "complete"
          ? "completed"
          : "paused";
    const validationTarget: WorkstreamStatus =
      body.decision === "complete"
        ? workstream.status === "completing"
          ? "waiting_for_human"
          : "completing"
        : body.decision === "reject"
          ? "pausing"
          : target;
    if (!canTransition(workstream.status as WorkstreamStatus, validationTarget))
      throw new WorkstreamCommandError(409, {
        error: "invalid_workstream_transition",
        from: workstream.status,
        to: target,
      });
    if (body.decision === "complete") {
      workstream.status = "completing";
      emit(
        "approval.complete",
        body.reason?.trim() || "Human approval: complete",
      );
      workstream.status = "completed";
    } else if (body.decision === "reject") {
      workstream.status = "pausing";
      emit("approval.reject", body.reason?.trim() || "Human approval rejected");
      workstream.status = "paused";
    } else {
      workstream.status = target;
      emit(
        `approval.${body.decision}`,
        body.reason?.trim() || `Human approval: ${body.decision}`,
      );
    }
    const response = {
      commandId,
      workstreamId: workstream.id,
      command: "approval",
      decision: body.decision,
      status: target,
      accepted: true,
    };
    await this.repository.commit({
      workstreamId: workstream.id,
      commandId,
      command: `approval:${body.decision}`,
      status: workstream.status,
      agents: workstream.agents,
      response,
    });
    return response;
  }
}
