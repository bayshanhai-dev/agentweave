---
name: agentweave-local-development
description: "Develop, test, and contribute to the AgentWeave Docker-first TypeScript monorepo, including local runtime checks and the contributor branch/PR workflow."
---

# AgentWeave Local Development

Use this skill when working on the AgentWeave repository for implementation, debugging, tests, Docker runtime validation, or an open-source contribution.

## Project shape

- `apps/control-api`: Fastify control plane, PostgreSQL repositories, orchestration, and WebSocket events.
- `apps/worker`: NATS/JetStream consumer, provider adapters, durable sessions, and workspace evidence.
- `apps/dashboard`: Vite/React/Mantine operator UI.
- `apps/host-runtime-bridge`: host-side bridge for Codex runtimes; intentionally outside Docker.
- `packages/domain` and `packages/protocol`: shared contracts and event transport.
- `db/migrations`: PostgreSQL migrations applied at Control API startup.

## Preflight

Before changing code, run:

```bash
git status --short --branch
git remote -v
git config --local user.name
git config --local user.email
gh api user --jq .login
```

For the external-contributor workflow, stop before commit/push unless the GitHub login is `Lamer0125`, the commit identity is `Lamer0125 <Lamer0125@users.noreply.github.com>`, `origin` is the contributor fork (HTTPS or its contributor SSH alias), and `upstream` fetches `https://github.com/bayshanhai-dev/agentweave.git` with no push URL.

Preserve unrelated user changes. Never modify, restore, or commit `EVOLUTION_SPEC.md` unless the user explicitly changes that rule. Do not use destructive Git commands.

## Branch and contribution workflow

For a new task, fetch `upstream/main` and create a focused `codex/*` branch from it. Keep changes small and add tests. Run tests before committing. Verify the final commit with:

```bash
git show -1 --format=fuller
```

Push only to `origin`, then create a PR targeting `bayshanhai-dev/agentweave:main`. Do not merge the PR or switch to an owner account. If GitHub requires first-contributor CI approval, report the PR/CI status and wait.

## Docker-first development

The normal local stack is Docker Compose:

```bash
make up
make doctor
docker compose ps
```

Useful checks:

```bash
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:5173/
make logs
```

Rebuild only affected services when possible. Use `docker compose up -d --build <service>` after source or dependency changes. Keep the host runtime bridge separate for real Codex; Mock is the deterministic default and must not require provider credentials.

## Verification

Run the narrowest relevant checks first, then repository-wide checks for cross-cutting changes:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run lint
```

If host Node/pnpm is unavailable, run equivalent commands inside the relevant Docker build/run context. For runtime changes, verify health, logs, and the public API. For event/recovery changes, inspect event IDs, workstream/task IDs, sequence/cursor behavior, redelivery, and worker heartbeats.

## Safety and scope

- Control API is provider-neutral; do not leak Codex/Claude details into domain contracts.
- Worker count is independent of Agent count; do not encode one-worker-per-agent assumptions.
- Use Mock for deterministic tests; real Codex/Claude requires explicit credentials and the host bridge.
- Keep Git optional in the generic runtime; require it only for workflows that declare the capability.
- Do not reset volumes or delete data without explicit authorization and a named disposable target.
