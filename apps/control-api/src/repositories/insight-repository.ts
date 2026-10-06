import type { CollaborationRound, Insight } from "@agentweave/domain";
import type { Sql } from "postgres";
import { CollaborationPolicy, type CollaborationDecision } from "../collaboration-policy.js";

const strings = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};
export const insightFrom = (row: Record<string, unknown>): Insight => ({ id: String(row.id), workstreamId: String(row.workstream_id), kind: String(row.kind) as Insight["kind"], lifecycle: String(row.lifecycle) as Insight["lifecycle"], authorAgentId: String(row.author_agent_id), content: String(row.content), confidence: Number(row.confidence), references: strings(row.insight_references), contradictionOf: strings(row.contradiction_of), supersedes: strings(row.supersedes), evidenceIds: strings(row.evidence_ids), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() });
export const roundFrom = (row: Record<string, unknown>): CollaborationRound => ({ id: String(row.id), workstreamId: String(row.workstream_id), topic: String(row.topic), participantAgentIds: strings(row.participant_agent_ids), synthesizerAgentId: String(row.synthesizer_agent_id), maxTurns: Number(row.max_turns), deadline: new Date(String(row.deadline)).toISOString(), completionRule: String(row.completion_rule) as CollaborationRound["completionRule"], status: String(row.status) as CollaborationRound["status"], insightIds: strings(row.insight_ids), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() });

export class InsightRepository {
  constructor(private readonly sql: Sql) {}
  async saveInsight(insight: Insight): Promise<void> { await this.sql`insert into insights (id, workstream_id, kind, lifecycle, author_agent_id, content, confidence, insight_references, contradiction_of, supersedes, evidence_ids, created_at, updated_at) values (${insight.id}, ${insight.workstreamId}, ${insight.kind}, ${insight.lifecycle}, ${insight.authorAgentId}, ${insight.content}, ${insight.confidence}, ${JSON.stringify(insight.references)}, ${JSON.stringify(insight.contradictionOf ?? [])}, ${JSON.stringify(insight.supersedes ?? [])}, ${JSON.stringify(insight.evidenceIds)}, ${insight.createdAt}, ${insight.updatedAt}) on conflict (id) do update set lifecycle = excluded.lifecycle, content = excluded.content, confidence = excluded.confidence, insight_references = excluded.insight_references, contradiction_of = excluded.contradiction_of, supersedes = excluded.supersedes, evidence_ids = excluded.evidence_ids, updated_at = excluded.updated_at`; }
  async saveRound(round: CollaborationRound): Promise<void> { await this.sql`insert into collaboration_rounds (id, workstream_id, topic, participant_agent_ids, synthesizer_agent_id, max_turns, deadline, completion_rule, status, insight_ids, created_at, updated_at) values (${round.id}, ${round.workstreamId}, ${round.topic}, ${JSON.stringify(round.participantAgentIds)}, ${round.synthesizerAgentId}, ${round.maxTurns}, ${round.deadline}, ${round.completionRule}, ${round.status}, ${JSON.stringify(round.insightIds)}, ${round.createdAt}, ${round.updatedAt}) on conflict (id) do update set status = excluded.status, insight_ids = excluded.insight_ids, updated_at = excluded.updated_at`; }
  async listInsights(workstreamId: string): Promise<Insight[]> { return (await this.sql`select * from insights where workstream_id = ${workstreamId} order by created_at asc`).map(insightFrom); }
  async listRounds(workstreamId: string): Promise<CollaborationRound[]> { return (await this.sql`select * from collaboration_rounds where workstream_id = ${workstreamId} order by created_at asc`).map(roundFrom); }
  async activeSynthesisInputs(workstreamId: string): Promise<Insight[]> { return (await this.sql`select * from insights where workstream_id = ${workstreamId} and lifecycle = 'accepted' order by updated_at desc`).map(insightFrom); }
  async opposingInsights(workstreamId: string, insightId: string): Promise<Insight[]> { return (await this.sql`select * from insights where workstream_id = ${workstreamId} and contradiction_of @> ${JSON.stringify([insightId])}::jsonb order by created_at asc`).map(insightFrom); }

  /** Atomically accepts one durable insight into the active round. */
  async advanceRound(workstreamId: string, insightId: string): Promise<CollaborationDecision> {
    return this.sql.begin(async (tx) => {
      const roundRows = await tx`select * from collaboration_rounds where workstream_id = ${workstreamId} order by created_at desc limit 1 for update`;
      if (!roundRows[0]) throw new Error("No active collaboration round");
      const round = roundFrom(roundRows[0] as Record<string, unknown>);
      const insightRows = await tx`select * from insights where workstream_id = ${workstreamId} order by created_at asc`;
      const insights = insightRows.map((row) => insightFrom(row as Record<string, unknown>));
      const candidate = insights.find((insight) => insight.id === insightId);
      if (!candidate) throw new Error("Collaboration insight not found");
      const existing = round.insightIds.map((id) => insights.find((insight) => insight.id === id)).filter((insight): insight is Insight => Boolean(insight));
      if (round.insightIds.includes(candidate.id)) return { accepted: true, next: new CollaborationPolicy().next(existing), round, reason: "Insight already accepted" };
      if (round.status !== "active") throw new Error(`Collaboration round is ${round.status}`);
      const decision = new CollaborationPolicy().evaluate(round, existing, candidate);
      await tx`update collaboration_rounds set status = ${decision.round.status}, insight_ids = ${JSON.stringify(decision.round.insightIds)}, updated_at = ${decision.round.updatedAt} where id = ${round.id}`;
      if (decision.accepted) await tx`update insights set lifecycle = 'accepted', updated_at = ${decision.round.updatedAt} where id = ${candidate.id}`;
      return decision;
    });
  }
}
