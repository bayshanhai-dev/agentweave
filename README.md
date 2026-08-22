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

The initial source files are intentionally thin. The implementation sequence is defined in `docs/TASKS.md`.
