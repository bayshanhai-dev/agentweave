# AgentWeave implementation backlog

This backlog converts the product specification into executable work. Each task has one category, one primary component label, explicit dependencies, and binary acceptance criteria.

## Current implementation status

- [x] AW-001 — TypeScript monorepo scaffold and workspace scripts
- [x] AW-002 — Docker Compose topology for core services and observability
- [x] AW-003 — Initial provider-neutral protocol schemas
- [x] AW-020 — Initial Workstream create/query API
- [x] AW-021 — Default PM / PE / Coder / QA bootstrap
- [x] AW-025 — Deterministic mock-provider happy path
- [x] AW-040 — Dashboard application shell
- [x] AW-041 — Persisted Workstream list and expandable Workstream groups
- [x] AW-043 — Initial Activity and Task views
- [x] AW-044 — Initial realtime WebSocket event gateway
- [x] AW-053 — Initial structured logs, Prometheus metrics, Grafana/Loki stack
- [ ] AW-030 — Durable task model and evidence-backed task board
- [ ] AW-042 — Full per-agent typed chat and message inboxes
- [ ] AW-054 — Full Playwright/Testcontainers E2E workflow

模块 breakdown 已覆盖 foundation/docker、protocol/domain、PostgreSQL、NATS、projector、Control API/WebSocket、orchestrator、worker、provider、workspace、dashboard、human-input、summary/tokens、observability 和 E2E/performance。完整架构图保存在 docs/architecture.mmd，并嵌入 PRODUCT_SPEC.md。

## Labels

### Category labels

| Label | Meaning |
|---|---|
| `category:foundation` | Repository, toolchain, Docker, CI |
| `category:domain` | Domain models, state machines, invariants |
| `category:data` | PostgreSQL schema, queries, projections |
| `category:messaging` | NATS streams, subjects, delivery semantics |
| `category:runtime` | Workers, sessions, leases, orchestration |
| `category:provider` | Codex and future model adapters |
| `category:api` | HTTP and WebSocket control plane |
| `category:frontend` | React dashboard and operator interaction |
| `category:workflow` | PM → PE → Coder → QA → Human loop |
| `category:reliability` | Recovery, idempotency, pause/resume |
| `category:performance` | Latency, throughput, rendering, token efficiency |
| `category:quality` | Tests, E2E validation, documentation |

### Component labels

| Label | Owner boundary |
|---|---|
| `component:repo` | Root workspace and developer tooling |
| `component:docker` | Compose files, images, health checks |
| `component:protocol` | Provider-neutral schemas and event contracts |
| `component:domain` | Workstream and task state machines |
| `component:postgres` | SQL schema and repositories |
| `component:nats` | JetStream configuration and client adapter |
| `component:projector` | Event-to-read-model projections |
| `component:control-api` | REST commands and queries |
| `component:websocket` | Realtime dashboard gateway |
| `component:orchestrator` | Workflow transitions and routing |
| `component:worker` | Worker registration, inbox and execution |
| `component:codex` | Codex App Server integration |
| `component:workspace` | Git repository and worktree operations |
| `component:dashboard` | React application shell and views |
| `component:human-input` | Typed intent, scope, lifetime and confirmation |
| `component:summary` | Workstream Summary Report So Far |
| `component:tokens` | Token ledger, total budget and suppression |
| `component:observability` | Logs, metrics and correlation IDs |
| `component:e2e` | End-to-end workflow and load tests |

### Priority labels

| Label | Definition |
|---|---|
| `priority:P0` | Required for the first end-to-end vertical slice |
| `priority:P1` | Required before relying on the MVP for personal projects |
| `priority:P2` | Post-MVP extension |

## Milestone D1: skeleton and contracts

### AW-001 — Bootstrap the TypeScript monorepo

- Category: `category:foundation`
- Component: `component:repo`
- Priority: `priority:P0`
- Depends on: none
- Deliverable: pnpm/Turborepo workspace with root scripts.
- Acceptance:
  - `pnpm install` succeeds.
  - `pnpm build`, `pnpm typecheck`, and `pnpm test` execute from the root.
  - Apps and packages are discovered through `pnpm-workspace.yaml`.

### AW-002 — Define Docker Compose topology

- Category: `category:foundation`
- Component: `component:docker`
- Priority: `priority:P0`
- Depends on: AW-001
- Deliverable: PostgreSQL, NATS, control API, worker, and dashboard services.
- Acceptance:
  - `docker compose config` succeeds.
  - PostgreSQL and NATS have persistent named volumes.
  - PostgreSQL and NATS expose health checks.
  - Application services wait for healthy infrastructure.

### AW-003 — Define canonical identifiers and event envelope

- Category: `category:domain`
- Component: `component:protocol`
- Priority: `priority:P0`
- Depends on: AW-001
- Deliverable: versioned Zod schemas and TypeScript types.
- Acceptance:
  - Event includes event ID, type, version, workstream, actor, correlation, sequence, timestamp, and payload.
  - Invalid events fail schema validation.
  - Protocol package has no dependency on NATS, PostgreSQL, Codex, or Fastify.

### AW-004 — Define typed human input contract

- Category: `category:domain`
- Component: `component:human-input`
- Priority: `priority:P0`
- Depends on: AW-003
- Deliverable: input schemas for question, request, directive, command, and decision.
- Acceptance:
  - Every input includes target, intent, scope, lifetime, content, and status.
  - Ordinary input defaults to one-time semantics.
  - Persistent directives and high-impact commands expose a confirmation-required flag.

### AW-005 — Implement the workstream state machine

- Category: `category:domain`
- Component: `component:domain`
- Priority: `priority:P0`
- Depends on: AW-001
- Deliverable: transition rules and unit tests.
- Acceptance:
  - Start, active, waiting-for-human, pause, resume, complete, and archive paths are represented.
  - Invalid transitions fail without changing state.
  - Every allowed and denied transition has a unit test.

## Milestone D2: durable event and state backbone

### AW-010 — Create the PostgreSQL schema

- Category: `category:data`
- Component: `component:postgres`
- Priority: `priority:P0`
- Depends on: AW-003, AW-005
- Deliverable: migrations for workstreams, agents, sessions, tasks, messages, events, token ledger, processed events, and checkpoints.
- Acceptance:
  - Migrations apply to an empty database.
  - Event ID and provider session ID uniqueness is enforced.
  - Indexes exist for workstream sequence, session sequence, task timestamp, event type, and correlation ID.

### AW-011 — Implement database repositories

- Category: `category:data`
- Component: `component:postgres`
- Priority: `priority:P0`
- Depends on: AW-010
- Deliverable: typed repositories for P0 entities.
- Acceptance:
  - Workstreams, agents, sessions, tasks, messages, and events can be created and queried.
  - Writes use transactions where multiple records must remain consistent.
  - Repository integration tests run against a real PostgreSQL container.

### AW-012 — Configure JetStream streams and subject taxonomy

- Category: `category:messaging`
- Component: `component:nats`
- Priority: `priority:P0`
- Depends on: AW-003
- Deliverable: idempotent startup provisioning for streams and consumers.
- Acceptance:
  - Subjects cover workstream events, agent inboxes, worker commands, session events, and dead letters.
  - Restarting provisioning does not duplicate streams or consumers.
  - Messages remain available while a consumer is offline.

### AW-013 — Implement the NATS event-bus adapter

- Category: `category:messaging`
- Component: `component:nats`
- Priority: `priority:P0`
- Depends on: AW-012
- Deliverable: publish, pull-consume, ACK, retry, and dead-letter operations.
- Acceptance:
  - A published event can be consumed and ACKed.
  - An unacknowledged event is redelivered.
  - Retry attempts carry the original event ID.
  - Payloads are validated against the protocol package.

### AW-014 — Implement idempotent event handling

- Category: `category:reliability`
- Component: `component:postgres`
- Priority: `priority:P0`
- Depends on: AW-011, AW-013
- Deliverable: processed-event guard keyed by consumer ID and event ID.
- Acceptance:
  - Delivering the same event twice produces one domain side effect.
  - The second delivery returns the previous outcome or a no-op result.
  - Idempotency survives process and Docker restarts.

### AW-015 — Build the read-model projector

- Category: `category:data`
- Component: `component:projector`
- Priority: `priority:P0`
- Depends on: AW-011, AW-013, AW-014
- Deliverable: event projections for workstream, agent, task, message, and activity views.
- Acceptance:
  - Projection processing is checkpointed by event sequence.
  - Projector restart resumes from the last committed checkpoint.
  - Events are processed in configurable batches.

## Milestone D3: control plane and local workers

### AW-020 — Implement workstream command API

- Category: `category:api`
- Component: `component:control-api`
- Priority: `priority:P0`
- Depends on: AW-011, AW-013
- Deliverable: create, start, pause, resume, complete, and query endpoints.
- Acceptance:
  - Commands validate expected current state.
  - Every accepted command emits an event.
  - Duplicate commands are idempotent.
  - Query endpoints read from PostgreSQL projections.

### AW-021 — Bootstrap the default agent team

- Category: `category:runtime`
- Component: `component:orchestrator`
- Priority: `priority:P0`
- Depends on: AW-020
- Deliverable: PM, PE, Coder, and QA registrations for a new workstream.
- Acceptance:
  - The first goal session is registered as PM.
  - PE, Coder, and QA receive unique agent and session IDs.
  - Repeating bootstrap does not create duplicate default roles.

### AW-022 — Implement worker registration and heartbeat

- Category: `category:runtime`
- Component: `component:worker`
- Priority: `priority:P0`
- Depends on: AW-012
- Deliverable: local worker capability registration and health state.
- Acceptance:
  - Worker publishes identity, roles, provider, and capabilities.
  - Missed heartbeat changes the worker projection to offline.
  - Returning worker can reuse its stable identity.

### AW-023 — Implement per-agent durable inboxes

- Category: `category:runtime`
- Component: `component:worker`
- Priority: `priority:P0`
- Depends on: AW-013, AW-014, AW-022
- Deliverable: pull-consumer loop routing messages by agent ID.
- Acceptance:
  - Each default agent receives only addressed or subscribed messages.
  - Paused agents retain undelivered messages.
  - ACK occurs only after the run outcome is persisted.

### AW-024 — Implement the provider-neutral session interface

- Category: `category:provider`
- Component: `component:worker`
- Priority: `priority:P0`
- Depends on: AW-003
- Deliverable: create, resume, send, cancel, and stream provider API.
- Acceptance:
  - Mock and Codex providers can implement the same interface.
  - Provider-specific thread IDs do not leak into the domain package.
  - Provider output maps to versioned AgentWeave events.

### AW-025 — Implement deterministic mock provider

- Category: `category:provider`
- Component: `component:worker`
- Priority: `priority:P0`
- Depends on: AW-024
- Deliverable: predictable PM, PE, Coder, and QA responses for E2E tests.
- Acceptance:
  - The provider can deliberately produce QA pass or one QA-fail/retry path.
  - It emits streaming, completion, and cancellation events.
  - No external API or model is required.

### AW-026 — Implement Codex App Server adapter

- Category: `category:provider`
- Component: `component:codex`
- Priority: `priority:P1`
- Depends on: AW-024, AW-025
- Deliverable: thread start/resume, turn start, streaming, cancellation, and reconnect.
- Acceptance:
  - Four independent Codex sessions can be created.
  - A session survives worker restart through its persisted thread ID.
  - Human and agent messages can be injected into the correct thread.
  - Adapter failure does not corrupt workstream state.

## Milestone D4: fixed end-to-end workflow

### AW-030 — Implement workflow task model

- Category: `category:workflow`
- Component: `component:domain`
- Priority: `priority:P0`
- Depends on: AW-005, AW-011
- Deliverable: objective, owner, status, acceptance criteria, dependencies, evidence, and review state.
- Acceptance:
  - Tasks transition through ready, assigned, running, review, blocked, done, and cancelled.
  - Task completion requires evidence references.
  - QA failure can return a task to implementation.

### AW-031 — Implement PM → PE → Coder → QA routing

- Category: `category:workflow`
- Component: `component:orchestrator`
- Priority: `priority:P0`
- Depends on: AW-021, AW-023, AW-025, AW-030
- Deliverable: fixed vertical-slice workflow.
- Acceptance:
  - Human goal wakes PM.
  - PM creates one task and requests PE design.
  - PE result is routed to Coder.
  - Coder result triggers QA review.
  - QA pass triggers human review.
  - QA fail triggers one or more Coder/QA iterations without losing history.

### AW-032 — Implement waiting-for-human gate

- Category: `category:workflow`
- Component: `component:human-input`
- Priority: `priority:P0`
- Depends on: AW-004, AW-020, AW-031
- Deliverable: structured review request, decision, and resume path.
- Acceptance:
  - PM can request human review with summary, options, recommendation, and evidence.
  - Workstream enters waiting-for-human without dropping messages.
  - Human decision resumes or completes the workflow.

### AW-033 — Implement workstream total token budget

- Category: `category:performance`
- Component: `component:tokens`
- Priority: `priority:P0`
- Depends on: AW-011, AW-024
- Deliverable: token ledger, total budget, soft limit, and hard limit.
- Acceptance:
  - Every provider run records input, output, cached tokens, model, task, agent, and wake reason.
  - Soft limit emits a human-attention event.
  - Hard limit blocks new provider runs and enters waiting-for-human.
  - Human can increase or remove the budget.

### AW-034 — Implement wake-up suppression and loop detection

- Category: `category:performance`
- Component: `component:orchestrator`
- Priority: `priority:P0`
- Depends on: AW-023, AW-031, AW-033
- Deliverable: relevance filter, deterministic ACKs, message hash deduplication, and no-progress circuit breaker.
- Acceptance:
  - Pure ACKs never invoke a provider.
  - Duplicate evidence/action messages are suppressed.
  - A conversation chain with no new evidence and no state progress is stopped and surfaced to PM/Human.
  - Necessary conversations are not subject to a universal fixed run count.

### AW-035 — Generate Summary Report So Far

- Category: `category:workflow`
- Component: `component:summary`
- Priority: `priority:P0`
- Depends on: AW-015, AW-030, AW-033
- Deliverable: deterministic snapshot plus optional PM narrative.
- Acceptance:
  - Summary includes goal, status, task counts, agents, blockers, decisions, artifacts, QA, errors, next actions, token use, and through-sequence.
  - Manual, human-review, pause, and completion triggers are supported.
  - Deterministic summary requires no LLM call.
  - Optional narrative receives only the fixed summary snapshot and evidence references.

## Milestone D5: dashboard P0

### AW-040 — Build the dashboard application shell

- Category: `category:frontend`
- Component: `component:dashboard`
- Priority: `priority:P0`
- Depends on: AW-001
- Deliverable: responsive three-column workstream view.
- Acceptance:
  - Agent list, selected chat, activity feed, and global controls are visible.
  - Layout remains usable at desktop and tablet widths.

### AW-041 — Build workstream create and list views

- Category: `category:frontend`
- Component: `component:dashboard`
- Priority: `priority:P0`
- Depends on: AW-020, AW-040
- Deliverable: create form and persisted workstream list.
- Acceptance:
  - Human can enter name, repository path, goal, and total token budget.
  - Starting creates and displays PM, PE, Coder, and QA.
  - Refreshing the page preserves the list and selected workstream.

### AW-042 — Build agent chat and typed composer

- Category: `category:frontend`
- Component: `component:human-input`
- Priority: `priority:P0`
- Depends on: AW-004, AW-023, AW-040
- Deliverable: per-agent chat with explicit input mode.
- Acceptance:
  - Human can select PM, PE, Coder, or QA.
  - Composer supports Ask once, Request action, Set directive, and Control.
  - Persistent directives and high-impact commands display confirmation before dispatch.
  - Human-to-agent and agent-to-agent messages show sender and recipient.

### AW-043 — Build activity and task views

- Category: `category:frontend`
- Component: `component:dashboard`
- Priority: `priority:P0`
- Depends on: AW-015, AW-030, AW-040
- Deliverable: chronological activity feed and simple task list.
- Acceptance:
  - Activity distinguishes messages, tasks, reviews, errors, and human attention.
  - Task list displays owner, status, acceptance criteria, and evidence.
  - Lists use cursor pagination and virtualization for large histories.

### AW-044 — Implement realtime event gateway

- Category: `category:api`
- Component: `component:websocket`
- Priority: `priority:P0`
- Depends on: AW-013, AW-015, AW-040
- Deliverable: one WebSocket connection per open workstream.
- Acceptance:
  - New events appear without refresh.
  - Reconnect requests events after the last observed sequence.
  - The same event ID is rendered once.

### AW-045 — Build workstream controls and human-attention panel

- Category: `category:frontend`
- Component: `component:dashboard`
- Priority: `priority:P0`
- Depends on: AW-020, AW-032, AW-040
- Deliverable: pause, resume, complete, emergency stop, and review controls.
- Acceptance:
  - Controls reflect the current state and disable invalid transitions.
  - Human-review requests show summary, evidence, options, and recommendation.
  - Destructive or workstream-wide commands require confirmation.

### AW-046 — Display Summary Report and token budget

- Category: `category:frontend`
- Component: `component:summary`
- Priority: `priority:P0`
- Depends on: AW-033, AW-035, AW-040
- Deliverable: live progress summary and total token usage.
- Acceptance:
  - Human can generate Summary So Far on demand.
  - Used, remaining, soft-limit, and hard-limit values are visible.
  - Usage can be broken down by Agent and Task without enforcing sub-budgets.

## Milestone D6: pause, recovery, workspace, and verification

### AW-050 — Implement pause barrier

- Category: `category:reliability`
- Component: `component:orchestrator`
- Priority: `priority:P0`
- Depends on: AW-020, AW-022, AW-023, AW-035
- Deliverable: stop leases, checkpoint agents, summarize, and enter paused.
- Acceptance:
  - No new task lease is issued after pausing begins.
  - Active agents ACK or become interrupted after timeout.
  - Session cursor, task state, and message sequence are persisted.
  - Summary Report is generated before paused state is committed.

### AW-051 — Implement resume from checkpoint

- Category: `category:reliability`
- Component: `component:orchestrator`
- Priority: `priority:P0`
- Depends on: AW-050
- Deliverable: restore sessions, consumers, task state, and queued messages.
- Acceptance:
  - Docker restart while paused does not lose state.
  - Resume delivers queued messages exactly once at the domain-effect level.
  - Agents receive goal, summary, current task, decisions, and queued messages.

### AW-052 — Implement repository registration and basic worktree isolation

- Category: `category:runtime`
- Component: `component:workspace`
- Priority: `priority:P0`
- Depends on: AW-011, AW-030
- Deliverable: validate a mounted repository and create a task worktree.
- Acceptance:
  - Only explicitly mounted repositories are accepted.
  - Coder receives a task-specific branch and worktree.
  - Worktree path and current commit are persisted.
  - Existing user changes are not overwritten.

### AW-053 — Add structured logging and metrics

- Category: `category:performance`
- Component: `component:observability`
- Priority: `priority:P0`
- Depends on: AW-013, AW-020, AW-022
- Deliverable: logs and Prometheus-format metrics.
- Acceptance:
  - Logs carry workstream, event, correlation, causation, agent, task, and run IDs when available.
  - Metrics expose API latency, event delivery latency, consumer lag, projector lag, queue depth, active runs, retries, CPU, and memory.
  - Secrets and model credentials are not logged.

### AW-054 — Implement fixed workflow E2E test

- Category: `category:quality`
- Component: `component:e2e`
- Priority: `priority:P0`
- Depends on: AW-031, AW-032, AW-035, AW-041, AW-042, AW-045, AW-050, AW-051
- Deliverable: Playwright/Testcontainers scenario using mock provider.
- Acceptance:
  - Human creates `/health` goal.
  - PM, PE, Coder, and QA complete the workflow.
  - QA fail/retry and QA pass paths are covered.
  - Human review completes the workstream.
  - Pause, Docker-service restart, resume, refresh, and history recovery are verified.

### AW-055 — Implement Day 1 load test

- Category: `category:performance`
- Component: `component:e2e`
- Priority: `priority:P0`
- Depends on: AW-013, AW-015, AW-044, AW-053
- Deliverable: reproducible benchmark report.
- Acceptance:
  - Registers 32 agents in one workstream.
  - Publishes 10,000 events and 1,000 concurrent messages.
  - Reports throughput, P50/P95/P99, lag, memory, duplicates, and missing events.
  - No message loss or duplicate dashboard event is observed.

## P1 reliability tasks

| ID | Task | Category | Component | Depends on |
|---|---|---|---|---|
| AW-060 | Codex reconnect and thread recovery test matrix | `category:reliability` | `component:codex` | AW-026 |
| AW-061 | Transactional outbox for database-to-NATS atomicity | `category:reliability` | `component:postgres` | AW-011, AW-013 |
| AW-062 | Dead-letter inspection and replay UI | `category:reliability` | `component:dashboard` | AW-013, AW-043 |
| AW-063 | Forced pause and stuck-tool termination | `category:reliability` | `component:worker` | AW-050 |
| AW-064 | Worktree recovery and stale lease cleanup | `category:reliability` | `component:workspace` | AW-052 |
| AW-065 | Provider contract test suite | `category:quality` | `component:e2e` | AW-024, AW-026 |

## P2 extensions

| ID | Task | Category | Component |
|---|---|---|---|
| AW-100 | Versioned skill registry and dynamic assignment | `category:runtime` | `component:worker` |
| AW-101 | Full multi-agent Self-Retro | `category:workflow` | `component:summary` |
| AW-102 | Distributed worker authentication and scheduling | `category:runtime` | `component:worker` |
| AW-103 | Claude Code provider adapter | `category:provider` | `component:worker` |
| AW-104 | Local OpenAI-compatible provider adapter | `category:provider` | `component:worker` |
| AW-105 | Dynamic agent-team expansion | `category:workflow` | `component:orchestrator` |
| AW-106 | Interactive network and dependency graph | `category:frontend` | `component:dashboard` |

## One-night critical path

The shortest path to a real, persistent vertical slice is:

```text
AW-001 → AW-002
AW-003 → AW-004 → AW-005
AW-010 → AW-011
AW-012 → AW-013 → AW-014 → AW-015
AW-020 → AW-021 → AW-022 → AW-023 → AW-024 → AW-025
AW-030 → AW-031 → AW-032 → AW-035
AW-040 → AW-041 → AW-042 → AW-043 → AW-044 → AW-045 → AW-046
AW-050 → AW-051 → AW-054
```

For the first overnight build, AW-026, AW-052, AW-053, and AW-055 may follow immediately after the mock-provider workflow is green. The mock-provider E2E is the integration safety net; Codex is connected only after that backbone works.
