# Configuration Reference

The committed `.env.example` is the safe starting point for local development.
The following settings are the core Docker configuration:

| Variable | Purpose | Example |
| --- | --- | --- |
| `CONTROL_API_HOST` | Control API bind address (`127.0.0.1` for host-local runs) | `0.0.0.0` |
| `CONTROL_API_PORT` | Control API port | `3000` |
| `CONTROL_API_URL` | Worker → Control API base URL (defaults to the Docker hostname `http://control-api:3000`; set it when the worker runs outside Docker, e.g. `http://127.0.0.1:3000`) | `http://127.0.0.1:3000` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://...` |
| `NATS_URL` | NATS connection | `nats://nats:4222` |
| `VITE_CONTROL_API_URL` | Browser API URL | `http://localhost:3000` |
| `VITE_CONTROL_WS_URL` | Browser event stream URL | `ws://localhost:3000/events` |
| `WORKER_ID` | Stable worker identity | `worker-local-1` |
| `WORKER_ROLES` | Worker role capability list | `pm,pe,coder,qa` |
| `WORKSPACE_ROOT` | Container workspace root | `/workspaces` |
| `AGENTWEAVE_HOST_WORKSPACE` | Narrow host directory mounted into Worker | `./workspaces` |
| `AGENTWEAVE_PROVIDER` | Provider adapter (`mock`, `codex`, `claude`, `kiro`, or `ollama`) | `mock` |
| `AGENTWEAVE_MODEL` | Provider model override | provider-specific |
| `KIRO_CLI_COMMAND` | Kiro CLI executable used by the `kiro` provider | `kiro-cli` |
| `OLLAMA_BASE_URL` | Ollama API base URL | `http://127.0.0.1:11434` |
| `CODEX_HOST_WORKSPACE_ROOT` | Host root resolved by the Codex bridge | `./workspaces` |
| `CODEX_CONTAINER_WORKSPACE_ROOT` | Matching root inside Worker container | `/workspaces` |
| `CODEX_APP_SERVER_URL` | Worker-to-bridge URL for Codex | `http://host.docker.internal:3010` |
| `CODEX_BRIDGE_TOKEN` | Optional bearer token for the bridge | unique local secret |
| `PROVIDER_REQUEST_TIMEOUT_MS` | Provider turn timeout | `120000` |

Provider credentials and bridge tokens are intentionally not included in the
committed example. Configure them only in the local `.env`, Docker secrets, or
an equivalent secret manager. Never put them in task messages, event payloads,
evidence, screenshots, or Git.

For host-backed workspaces, configure `AGENTWEAVE_HOST_WORKSPACE`,
`CODEX_HOST_WORKSPACE_ROOT`, and `CODEX_CONTAINER_WORKSPACE_ROOT`
consistently. A path valid inside the Worker container is not automatically a
valid host path. Relative values are resolved from the repository root; use an
absolute path only when you need to mount a specific project.

Never mount your home directory. AgentWeave only needs the one repository or
demo directory that the current Workstream operates on.

`WORKSPACE_ALLOWED_ROOTS` is optional and applies to the host bridge. Use it
when you need to permit more than one narrow root; values are comma-separated.
If omitted, it uses `CODEX_HOST_WORKSPACE_ROOT` (or the repository's
`./workspaces` directory).
