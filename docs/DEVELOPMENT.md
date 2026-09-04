# Development Guide

## Local stack

AgentWeave runs as a Docker-first stack. The dashboard and control API are
application services; PostgreSQL and NATS provide durable state and event
delivery; Prometheus, Loki, Promtail, and Grafana provide local observability.

```bash
cp .env.example .env
make install
make up
make doctor
```

Open:

- Dashboard: <http://localhost:5173>
- Control API health: <http://localhost:3000/health>
- NATS monitoring: <http://localhost:8222>
- Grafana: <http://localhost:3001>

Use `make logs` for a bounded recent log tail. Use `docker compose ps` before
restarting anything. If Docker Desktop is unavailable, restart Docker before
diagnosing application failures.

## Demo and Codex bridge

`make demo` starts the Docker stack and creates a disposable, deterministic
mock-provider workstream. It is the fastest smoke test for a fresh clone.

For a real Codex-backed run, set `AGENTWEAVE_PROVIDER=codex` and the two
workspace-root values in `.env`, then keep `make bridge` running in a second
terminal. The bridge uses the host's installed and authenticated `codex`
command; it is intentionally not containerized because it operates on the
host workspace. Keep its workspace root narrow and its token private.

After the bridge is healthy, verify the real provider boundary with a read-only
smoke turn from another terminal:

```bash
CODEX_SMOKE_WORKSPACE=/absolute/path/inside/the/allowed/root pnpm test:smoke:codex
```

The smoke command requires an explicitly selected workspace, asks Codex not to
inspect or modify files, and checks for a deterministic acknowledgement. It is
intentionally local-only: CI runs the credential-free Mock Playwright journey
instead of receiving a maintainer's Codex authentication.

To reset only Docker-managed local state, use `make fresh CONFIRM=YES`. It
removes named Docker volumes but not `AGENTWEAVE_HOST_WORKSPACE`.

## Checks

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run lint
pnpm run test:e2e
```

The repository's E2E checks require Docker and should use a disposable
workstream and workspace. Never run a load or failure test against a user's
real project without an explicit backup and cleanup plan.

## Configuration rules

Start from `.env.example`. Keep secrets in the local environment or a secret
manager. Provider selection belongs to the Worker/execution plane; the
Control Plane should only handle provider-neutral task and event contracts.

Workspace paths must be explicit and allowlisted. Host and container paths are
different namespaces; configure both sides when using the host runtime bridge.

## Observability

Every execution should be diagnosable using structured logs, event IDs,
workstream IDs, task IDs, agent IDs, and run IDs. Do not use provider tokens as
correlation IDs. When investigating retry behavior, check event volume and
consumer lag before starting another test.
