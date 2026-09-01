# AgentWeave Next-Phase Evolution Spec

Status: Proposed  
Target: v0.2 — Collaborative Runtime Kernel  
Scope: single-host, Docker-first, trusted local deployment  
Planning horizon: 5–7 weeks for one focused engineer, or 3–4 weeks with parallel ownership

## 1. Executive assessment

AgentWeave currently has a credible end-to-end vertical slice, not yet a stable
runtime kernel. A user can create a Workstream, start a deterministic multi-role
demo, observe tasks and messages, run a provider through a Worker, persist much
of the state in PostgreSQL, and survive a basic service restart. CI, Docker,
JetStream, provider adapters, workspace boundaries, evidence collection, and a
useful operator UI are all present.

The code nevertheless implements a narrower system than the architecture and
README describe. Today, collaboration is primarily a fixed PM → PE → Coder → QA
handoff loop. Agents pass text to the next role, but the runtime does not yet
model insights, critique, synthesis, shared claims, or competing alternatives.
That distinction is central: the next milestone should prove that multiple
agents improve the result through observable exchange, rather than merely
producing more messages or serial model calls.

Overall maturity:

| Area | Current maturity | Evidence-based assessment |
|---|---:|---|
| Product thesis | Strong | Clear runtime-OS positioning and visible operator workflow |
| Local demo | Functional | Deterministic Mock flow and UI creation path exist |
| Durable state | Partial | PostgreSQL persistence exists, but the in-process Workstream map remains the live authority |
| Messaging | Partial | JetStream inboxes, deliveries, correlation IDs, ACK endpoints, and dedupe exist; canonical envelope validation and ordered replay do not |
| Orchestration | Prototype | Fixed stage machine plus a PM decision endpoint; normal provider results still follow hard-coded routing |
| Multi-agent insight exchange | Missing | No durable insight, critique, synthesis, or claim model |
| Scheduling and parallelism | Early | Tasks can be created and related, but no dependency-aware ready queue or general scheduler exists |
| Provider runtime | Promising | Mock, Codex, and Claude boundaries exist; recovery and lease semantics need hardening |
| UX and observability | Good prototype | Live cards and bus are useful, but the browser reconstructs some state heuristically from events |
| Test and release confidence | Early | CI passes, but there are only 30 focused unit tests and no full restart/E2E suite |
| Security | Developer preview | Narrow workspace controls and bridge token exist; no multi-tenant or untrusted deployment boundary |

## 2. North-star outcome

The v0.2 demo must make the following claim visibly true:

> Several agents independently produce, challenge, refine, and synthesize
> insights into an evidence-backed outcome that is stronger and more traceable
> than a single Human ↔ Agent conversation.

A successful run should visibly contain:

1. independent proposals or observations from at least two agents;
2. one agent challenging, extending, or invalidating another agent's insight;
3. a synthesized decision that cites the insights and evidence it used;
4. tasks moving independently or in parallel when dependencies allow;
5. a durable causal trace from Human goal → tasks → insights → decision → evidence;
6. restart recovery without duplicated work or lost UI history.

High message volume is not itself a success metric. The runtime should prefer
useful novelty, disagreement, and synthesis over artificial agent chatter.

## 3. Current strengths to preserve

- Keep the provider-neutral Worker boundary. Provider sessions belong to the
  runtime and should remain hidden from the domain model.
- Keep PostgreSQL as the durable source of truth and JetStream as transport.
- Keep Human approval explicit for completion, high-impact actions, and future
  scaling.
- Keep workspace access narrow and evidence collection separate from model
  text.
- Keep the deterministic Mock provider as the primary reproducible demo and
  E2E fixture.
- Keep the operator-first UI: Macro Plan, agent execution state, live messages,
  summary, and audit are the right surfaces.

## 4. Critical gaps and risks

### P0 — Correctness and durability

1. **The Control API has two sources of truth.** PostgreSQL persists data, but
   requests and orchestration primarily mutate a process-local `Map`. This
   makes concurrency, multi-process deployment, and atomic recovery unsafe.
2. **Domain writes are not transactional.** Task/message/event/status updates
   are often separate statements. A crash can persist only part of a logical
   transition.
3. **Some persistence is fire-and-forget.** Workflow event and status writes
   are launched without awaiting completion before WebSocket broadcast.
4. **Schema ownership is split.** Most tables and alterations are created at
   Control API startup while the checked-in migration contains only the
   session table. Fresh installation works by side effect, but schema versions
   are not reproducible or reviewable.
5. **The canonical event contract is not canonical in practice.** The Zod
   `EventEnvelope` includes version, actor, sequence, and identifiers, while the
   JetStream implementation uses a smaller unvalidated envelope with `unknown`
   payloads.
6. **Replay is incomplete.** WebSocket replay currently replays messages after
   a timestamp, not the ordered event stream, and cannot guarantee gap-free
   projection recovery.
7. **State transitions can bypass domain rules.** The task PATCH route accepts
   arbitrary statuses, and completion paths exist outside one authoritative
   state machine.

### P0 — Collaboration semantics

1. **The primary route is hard-coded.** Provider results are mapped by role into
   a fixed PM → PE → Coder → QA stage machine.
2. **PM intelligence is not the normal control path.** A validated PM decision
   endpoint exists, but ordinary provider output is parsed as text and then
   routed by the deterministic stage machine.
3. **Messages are handoffs, not shared knowledge.** There is no first-class
   insight, claim, critique, contradiction, confidence, or synthesis object.
4. **Task parsing is prompt-format dependent.** A short line parser extracts
   `[PE]`, `[CODER]`, and `[QA]` tasks from free-form output. This is useful for
   the demo but too fragile to define the runtime protocol.
5. **Parallel tasks are represented but not scheduled.** Dependencies,
   relationships, ownership, and statuses exist, but there is no scheduler that
   derives readiness, leases independent work, or handles join conditions.

### P1 — Runtime and UX integrity

1. Session leases expire after 60 seconds but are not renewed during a long
   provider turn; task and session lease durations also differ.
2. Recovery is biased toward the same `workerId`, limiting reassignment after a
   Worker replacement.
3. Pause and emergency-stop semantics depend on polling and provider support;
   interruption guarantees are not tested end to end.
4. Dashboard state is partly reconstructed with client-side event heuristics.
   The UI can temporarily disagree with persisted projections.
5. Agent cards show activity, but there is no explicit distinction among
   queued, waiting on dependency, waiting on provider, waiting on another
   agent, retrying, and genuinely idle.
6. Large core files (`control-api/src/main.ts` and `dashboard/src/main.tsx`)
   combine transport, domain, persistence, projection, and presentation logic,
   increasing regression risk.

## 5. v0.2 product model

### 5.1 Durable Insight

Introduce an `Insight` as the basic unit of agent collaboration.

```ts
type InsightKind =
  | "observation"
  | "hypothesis"
  | "proposal"
  | "critique"
  | "question"
  | "decision"
  | "synthesis";

type Insight = {
  id: string;
  workstreamId: string;
  taskId?: string;
  authorAgentId: string;
  kind: InsightKind;
  summary: string;
  body: string;
  confidence?: number;
  evidenceIds: string[];
  references: string[];
  contradicts: string[];
  supersedes?: string;
  status: "active" | "accepted" | "rejected" | "superseded";
  correlationId: string;
  createdAt: string;
};
```

Insights must be structured provider output validated at the Control Plane
boundary. A normal chat message can carry an insight, but message delivery and
knowledge semantics remain separate concepts.

### 5.2 Collaboration round

A `CollaborationRound` coordinates bounded exchange around a question or task:

```text
question or task
  → independent proposals
  → targeted critique / evidence request
  → synthesis
  → decision or next task
```

Each round defines participants, deadline or turn budget, completion rule, and
synthesizer. The runtime may end a round early when no novel insight is
produced. This provides frequent visible collaboration without unbounded loops.

### 5.3 Structured Agent Output

Replace marker-based control (`[PROPOSE_COMPLETE]`, `[HUMAN_BLOCKED]`, and
role-prefixed task lines) as the primary mechanism with a versioned result:

```ts
type AgentTurnResult = {
  summary: string;
  insights: InsightDraft[];
  proposedTasks: TaskDraft[];
  messages: AgentMessageDraft[];
  decision?: OrchestrationDecision;
  completionProposal?: CompletionProposal;
  humanBlock?: HumanBlock;
};
```

Text markers can remain as a compatibility fallback for providers that cannot
produce structured output.

### 5.4 Dependency-aware scheduler

The scheduler, not an agent prompt, owns execution readiness:

- `backlog`: defined but not admitted;
- `queued`: admitted and dependencies satisfied;
- `leased`: assigned to a runtime actor;
- `running`: provider turn active;
- `review`: output awaiting reviewer or join condition;
- `blocked`: dependency, policy, workspace, provider, or Human block;
- `done` / `failed` / `cancelled`: terminal.

The UI may continue to label these as Backlog, To Do, In Progress, Review, and
Done. Internal statuses must have one documented mapping to display lanes.

The scheduler must support independent tasks, DAG dependencies, explicit
joins, bounded retries, and multiple instances of one role without assuming a
parent-child relationship.

## 6. Target architecture changes

### 6.1 Control Plane decomposition

Split the Control API into explicit boundaries:

```text
apps/control-api/src/
  routes/           HTTP and WebSocket adapters only
  commands/         create/start/pause/resume/message/approve handlers
  queries/          read-model queries
  orchestration/    collaboration policy and decision execution
  scheduler/        readiness, leasing, retry, join rules
  repositories/     transactional PostgreSQL access
  projections/      event → operator read models
  runtime/          worker registration and health
```

The database becomes the only authoritative state. In-memory caches may be
used only as rebuildable optimizations.

### 6.2 Versioned migrations

- Move every startup DDL statement into ordered migrations.
- Add a migration runner and a `schema_migrations` table.
- Make application startup fail clearly when the schema is incompatible.
- Add foreign keys and indexes for event sequence, correlations, task
  dependencies, insights, rounds, and delivery lookup.

### 6.3 Canonical event log

- Use one versioned envelope across Control API, Worker, JetStream, database,
  projector, WebSocket, and tests.
- Assign a monotonic sequence per Workstream.
- Validate every command and event payload with Zod before publish and consume.
- Persist an outbox record in the same transaction as each domain change.
- Publish from the outbox and make every consumer idempotent.
- Replay WebSocket clients by sequence cursor, not timestamp.

Exactly-once delivery is not required; exactly-once domain effects are.

### 6.4 Worker leases and recovery

- Renew session and task leases while a provider turn is active.
- Allow a compatible Worker to adopt an expired session regardless of the old
  Worker identity.
- Persist normalized run state and provider checkpoint before ACK.
- Test kill/restart at turn start, during streaming, during tool execution, and
  after provider completion but before ACK.
- Expose explicit waiting reasons and lease age to the Dashboard.

### 6.5 Projection-driven Dashboard

- The server owns all task, agent, message, insight, round, and usage
  projections.
- The browser applies versioned projection deltas or refreshes a snapshot; it
  does not infer domain state from event names.
- Add an Insight Stream mode to Live Message Bus with links among proposal,
  critique, evidence, and synthesis.
- Add a Workstream pulse that explains current progress in one sentence:
  “2 tasks running · QA waiting on Backend · PM synthesizing 3 insights.”

## 7. Delivery plan

### Phase 0 — Baseline and invariants (2–3 days)

Deliverables:

- Freeze and document the current Mock demo trace.
- Add a machine-readable event fixture for the expected PM → PE → Coder → QA
  path.
- Record baseline metrics: run duration, messages, tasks, duplicate effects,
  restart behavior, and UI update latency.
- Turn current hidden assumptions into architecture decision records.

Exit criteria:

- Current CI remains green.
- One command produces a deterministic trace artifact suitable for regression
  comparison.

### Phase 1 — Durable correctness foundation (1–2 weeks, P0)

Deliverables:

- Versioned migrations and migration runner.
- Repository and transaction layer for Workstreams, Tasks, Agents, Messages,
  Events, Commands, and Deliveries.
- Canonical versioned event envelope with Workstream sequence.
- Transactional outbox and idempotent consumers.
- Sequence-based WebSocket replay.
- Authoritative task and Workstream transition services.
- Decomposition of the Control API entrypoint.

Exit criteria:

- Killing Control API after any accepted command cannot produce partial state.
- Restarting Control API and Worker loses no task, message, event, or status.
- Re-delivering every event twice produces one domain effect.
- A reconnecting Dashboard receives all missed events in order.
- No table is created or altered from application runtime code.

### Phase 2 — Collaborative insight kernel (1–2 weeks, P0)

Deliverables:

- Insight, CollaborationRound, and structured AgentTurnResult contracts.
- Database schema, repositories, commands, and projections for insights.
- Proposal → critique → synthesis collaboration policy.
- Structured provider output for Mock and Codex; marker compatibility fallback.
- PM synthesis decision that cites input insight and evidence IDs.
- Novelty/turn budget guard against empty chatter loops.

Exit criteria:

- The Mock demo produces at least two independent insights, one critique, and
  one synthesis with a complete causal trace.
- A rejected or superseded insight remains auditable but is excluded from the
  active synthesis.
- The runtime stops a non-productive collaboration round within its configured
  budget.
- Human can open the final decision and inspect every supporting and opposing
  insight.

### Phase 3 — Scheduler and visible parallelism (1 week, P0)

Deliverables:

- Dependency-aware ready queue and task leases.
- Parallel execution for independent tasks.
- Join/review conditions and bounded retry policy.
- Configurable role templates instead of one hard-coded flavor array.
- Agent cards with queued/running/waiting/retrying/reviewing reasons.

Exit criteria:

- Two independent tasks run concurrently and join before synthesis.
- A blocked task never dispatches before its dependencies are satisfied.
- Expired task leases can be safely adopted without duplicate side effects.
- Task cards move from server projection updates without a page refresh.

### Phase 4 — Operator UX and real-provider proof (1 week, P1)

Deliverables:

- Unified message/insight stream with auto-scroll, pause-on-manual-scroll, and
  causal threading.
- Workstream pulse, waiting reason, provider latency, tokens, and cost per
  agent/round/task.
- Codex end-to-end smoke scenario using a small disposable repository.
- Explicit degraded states for provider offline, bridge offline, stale Worker,
  lease expiry, and replay lag.

Exit criteria:

- New messages and state changes appear within one second on a local machine.
- A user can explain what every agent is doing and what it is waiting for
  without opening the audit log.
- The Codex scenario completes one real edit → review → QA → Human approval
  loop with persisted evidence.

### Phase 5 — Developer-preview release gate (3–5 days, P1)

Deliverables:

- Testcontainers integration suite and Playwright operator journey.
- Restart/duplicate/failure matrix in CI.
- Docker builds for Control API, Worker, Dashboard, and bridge where relevant.
- Quick start verified from a clean clone.
- Honest capability matrix in README and updated security limitations.

Exit criteria:

- `pnpm typecheck`, unit, integration, E2E, and all Docker builds pass in CI.
- Clean-clone Mock demo reaches Human approval without manual database edits or
  refresh.
- One documented Codex smoke test passes on a supported local setup.
- Known limitations are explicit; no README claim depends on unimplemented
  Scheduler, Projector, policy, or scaling behavior.

## 8. Work breakdown

| ID | Priority | Work item | Depends on |
|---|---|---|---|
| EV-001 | P0 | Move startup DDL into versioned migrations | — |
| EV-002 | P0 | Extract transactional repositories and command handlers | EV-001 |
| EV-003 | P0 | Canonical event schemas and payload registry | — |
| EV-004 | P0 | Transactional outbox and sequence allocation | EV-002, EV-003 |
| EV-005 | P0 | Idempotent projector and sequence replay | EV-004 |
| EV-006 | P0 | Authoritative Workstream and Task transition services | EV-002 |
| EV-007 | P0 | Insight and CollaborationRound domain contracts | EV-003 |
| EV-008 | P0 | Insight persistence and read projections | EV-005, EV-007 |
| EV-009 | P0 | Structured AgentTurnResult for Mock and Codex | EV-007 |
| EV-010 | P0 | Proposal/critique/synthesis policy and budgets | EV-008, EV-009 |
| EV-011 | P0 | Dependency-aware scheduler and task leasing | EV-006 |
| EV-012 | P0 | Lease renewal and cross-Worker recovery | EV-004, EV-011 |
| EV-013 | P0 | Projection-driven Dashboard state | EV-005 |
| EV-014 | P1 | Unified message/insight stream and causal UI | EV-008, EV-013 |
| EV-015 | P1 | Agent waiting reasons, usage, latency, and Workstream pulse | EV-013 |
| EV-016 | P0 | Restart, duplicate-delivery, and parallel-join integration tests | EV-010, EV-012 |
| EV-017 | P1 | Playwright Mock demo and Codex smoke test | EV-014, EV-016 |
| EV-018 | P1 | README capability matrix and release checklist | EV-017 |

Suggested parallel ownership:

- Runtime/data: EV-001 through EV-006, EV-011, EV-012.
- Collaboration/protocol: EV-003, EV-007 through EV-010.
- Dashboard: EV-013 through EV-015.
- Quality/release: EV-016 through EV-018.

## 9. Explicit non-goals for v0.2

- Kubernetes, multi-region, or cloud scheduler.
- Untrusted multi-tenant SaaS and enterprise RBAC.
- Automatic role scaling without Human approval.
- Agent marketplace or visual workflow builder.
- Automatic production deploy or merge.
- Long-term cross-Workstream memory.
- Optimizing for maximum message frequency.

## 10. Release decision

The current repository is suitable for an open-source developer preview if its
limitations remain explicit. It is not yet suitable to claim a general agent
runtime OS with durable collaborative intelligence.

The next public milestone should not be “more agents” or “more animated UI.” It
should be a demonstrable collaborative-runtime proof:

```text
independent insight
  + explicit critique
  + evidence
  + synthesis
  + durable recovery
  = AgentWeave v0.2
```

