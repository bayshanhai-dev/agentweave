# AgentWeave

AgentWeave is an open-source runtime and control plane for collaborative AI agent networks.

## Day 1 scope

- Create one durable workstream.
- Register PM, PE, Coder, and QA sessions.
- Route typed human and agent messages through NATS JetStream.
- Persist workstream state and read models in PostgreSQL.
- Display agents, chat, activity, and controls in a React dashboard.
- Run a fixed end-to-end workflow with pause, resume, human review, and completion.

## Repository layout

```text
apps/control-api  HTTP/WebSocket control plane
apps/dashboard    React operator console
apps/worker       Local multi-role worker runtime
packages/protocol Provider-neutral event and command schemas
packages/domain   Workstream state machine and domain rules
docs              Product specification and implementation backlog
```

## Start

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up --build
```

Dashboard: http://localhost:5173  
Control API: http://localhost:3000/health  
NATS monitoring: http://localhost:8222

## Provider adapters

The worker exposes a provider-neutral adapter contract in `apps/worker/src/providers`.
Use `AGENTWEAVE_PROVIDER=mock` (the default), `codex`, or `claude`, with optional
`AGENTWEAVE_MODEL` and `PROVIDER_REQUEST_TIMEOUT_MS`. Codex requires an injected or
configured App Server transport; Claude is invoked with argv (never a shell string)
using `CLAUDE_CODE_COMMAND`. The mock adapter is deterministic and supports delay,
failure, QA output, cancellation, resume, and idempotent completed turns.

Provider credentials remain in environment/configuration and are not part of run
messages or persisted event payloads. Retry classification is normalized at the
adapter boundary; callers should reuse the idempotency key when retrying a turn.
Session persistence should store the `ProviderSession` fields and be implemented by
the worker/control-plane repository when database integration is introduced.
The adapter also exposes `checkpoint(session)`. The database integration point is
`AgentSessionRepository`, which stores runtime state, current turn, checkpoint,
event sequence, and worker lease without storing provider credentials or provider-
specific event payloads. On worker restart, the worker acquires an unexpired lease,
calls `resumeSession`, loads the checkpoint, and continues or safely retries using
the turn idempotency key.

PostgreSQL session state is defined in `db/migrations/001_agent_sessions.sql` and
implemented by `PostgresAgentSessionRepository`. A fresh Docker PostgreSQL volume
initializes this table automatically. Existing volumes need the migration applied
once before enabling runtime recovery. Lease acquisition is atomic, expired leases
can be taken over, and only the owning worker can release its lease.

The initial source files are intentionally thin. The implementation sequence is defined in `docs/TASKS.md`.
