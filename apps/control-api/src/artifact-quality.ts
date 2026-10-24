export const minimumArtifactCharacters = 200;
export const maximumQualityAttempts = 2;

export type WrittenArtifact = { path: string; content: string };
export type ArtifactQualityReason = { path: string; reason: string };
export type ArtifactQualityResult =
  | { ok: true }
  | { ok: false; reasons: ArtifactQualityReason[] };

const placeholderPatterns = [
  /\[(?:insert|your|todo|tbd|replace|enter|add|describe|provide|write)[^\]]*\]/gi,
  /\[(?:name|author|date|title|description|summary|section)\]/gi,
  /\blorem ipsum\b/gi,
];

/** Unfilled template variables, e.g. `${agentweave:template}`, `${user.name}`, `${env.FOO}`. */
const templateVariablePattern =
  /\$\{[A-Za-z_][\w:.-]*(?:\s*(?:\||:-)[^}]*)?\}/g;

/** Removes fenced code blocks, where template literals are legitimate content. */
function withoutFencedCode(content: string): string {
  return content.replace(/```[\s\S]*?(?:```|$)/g, " ");
}

function isText(content: string): boolean {
  return !content.includes("\0") && !content.includes("\uFFFD");
}

function nonWhitespaceLength(content: string): number {
  return content.replace(/\s/g, "").length;
}

function protocolRemainder(content: string): string {
  const lines = content.split(/\r?\n/);
  let inAcceptanceCriteria = false;
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\[agentweave\s+template=/i.test(trimmed)) return false;
      if (/^continue the workstream\b/i.test(trimmed)) return false;
      if (/^planned task:\s*$/i.test(trimmed)) return false;
      if (/^acceptance criteria:\s*$/i.test(trimmed)) {
        inAcceptanceCriteria = true;
        return false;
      }
      if (inAcceptanceCriteria && (/^[-*]\s+/.test(trimmed) || !trimmed)) return false;
      inAcceptanceCriteria = false;
      return Boolean(trimmed);
    })
    .join("\n")
    .trim();
}

/** Deterministic content checks for text artifacts written by a completing turn. */
export function checkArtifactQuality(
  artifacts: readonly WrittenArtifact[],
): ArtifactQualityResult {
  const reasons: ArtifactQualityReason[] = [];
  for (const artifact of artifacts) {
    if (!isText(artifact.content)) continue;
    const json = artifact.path.toLowerCase().endsWith(".json");
    const length = nonWhitespaceLength(artifact.content);
    if (!json && length < minimumArtifactCharacters) {
      reasons.push({
        path: artifact.path,
        reason: `artifact too small (${length} chars)`,
      });
    }
    for (const pattern of placeholderPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(artifact.content);
      if (match) {
        reasons.push({
          path: artifact.path,
          reason: `placeholder residue (${JSON.stringify(match[0])})`,
        });
        break;
      }
    }
    const templateVariables = new Set<string>();
    for (const match of withoutFencedCode(artifact.content).matchAll(
      templateVariablePattern,
    )) {
      templateVariables.add(match[0]);
      if (templateVariables.size >= 3) break;
    }
    if (templateVariables.size) {
      reasons.push({
        path: artifact.path,
        reason: `unfilled template placeholders (${[...templateVariables].join(", ")})`,
      });
    }
    if (/\[agentweave\s+template=/i.test(artifact.content)) {
      const substantiveLength = nonWhitespaceLength(protocolRemainder(artifact.content));
      if (substantiveLength < minimumArtifactCharacters) {
        reasons.push({
          path: artifact.path,
          reason: `protocol echo (${substantiveLength} substantive chars)`,
        });
      }
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

type QualityTask = {
  id: string;
  title: string;
  status: string;
  ownerAgentId?: string;
  qualityAttempts: number;
};
type QualityWorkstream = { status: string };
type QualityGateDependencies = {
  persistTask: () => Promise<void>;
  persistWorkstream: () => Promise<void>;
  setAgentIdle: () => Promise<void>;
  emit: (event: { type: string; message: string; taskId?: string }) => void;
  dispatchRework: (input: {
    recipientId: string;
    taskId: string;
    content: string;
  }) => Promise<void>;
};

export type ArtifactQualityGateOutcome = "accepted" | "rework" | "parked";

function rejectionSummary(reasons: readonly ArtifactQualityReason[]): string {
  return reasons.map(({ path, reason }) => `${path}: ${reason}`).join("; ");
}

export function artifactReworkMessage(
  task: Pick<QualityTask, "title">,
  reasons: readonly ArtifactQualityReason[],
): string {
  const failures = reasons.map(({ path, reason }) => `- ${path}: ${reason}`).join("\n");
  return `The artifact quality gate rejected the completion for "${task.title}". Rework the same task and overwrite the failing files.\n\nFailures:\n${failures}\n\nA passing text artifact must contain at least ${minimumArtifactCharacters} characters of non-whitespace deliverable content, contain no template placeholders, and contain substantive deliverable content instead of AgentWeave routing text. The size floor does not apply to JSON, but placeholder and protocol-echo checks still do.`;
}

/** Applies the completion-ingestion transition after the pure checker rejects artifacts. */
export async function applyArtifactQualityGate(
  workstream: QualityWorkstream,
  task: QualityTask,
  artifacts: readonly WrittenArtifact[],
  retryAgentId: string,
  dependencies: QualityGateDependencies,
): Promise<ArtifactQualityGateOutcome> {
  if (!artifacts.length) return "accepted";
  const result = checkArtifactQuality(artifacts);
  if (result.ok) return "accepted";

  task.qualityAttempts += 1;
  task.status = "assigned";
  await dependencies.persistTask();
  await dependencies.setAgentIdle();
  const summary = rejectionSummary(result.reasons);
  dependencies.emit({
    type: "task.quality_rejected",
    taskId: task.id,
    message: `${task.title} quality rejection ${task.qualityAttempts}/${maximumQualityAttempts}: ${summary}`,
  });

  if (task.qualityAttempts >= maximumQualityAttempts) {
    workstream.status = "waiting_for_human";
    await dependencies.persistWorkstream();
    dependencies.emit({
      type: "workstream.waiting_for_human",
      message: `Artifact quality rejected twice for ${task.title}: ${summary}`,
    });
    return "parked";
  }

  await dependencies.dispatchRework({
    recipientId: retryAgentId,
    taskId: task.id,
    content: artifactReworkMessage(task, result.reasons),
  });
  return "rework";
}
