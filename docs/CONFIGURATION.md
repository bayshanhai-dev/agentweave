# Configuration Reference

The committed `.env.example` is the safe starting point for local development.
The following settings are the core Docker configuration:

| Variable | Purpose | Example |
| --- | --- | --- |
| `CONTROL_API_PORT` | Control API port | `3000` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://...` |
| `NATS_URL` | NATS connection | `nats://nats:4222` |
| `VITE_CONTROL_API_URL` | Browser API URL | `http://localhost:3000` |
| `VITE_CONTROL_WS_URL` | Browser event stream URL | `ws://localhost:3000/events` |
| `WORKER_ID` | Stable worker identity | `worker-local-1` |
| `WORKER_ROLES` | Worker role capability list | `pm,pe,coder,qa` |
| `WORKSPACE_ROOT` | Container workspace root | `/workspaces` |
| `AGENTWEAVE_PROVIDER` | Provider adapter | `mock` |
| `AGENTWEAVE_MODEL` | Provider model override | provider-specific |
| `PROVIDER_REQUEST_TIMEOUT_MS` | Provider turn timeout | `120000` |

Provider credentials and bridge tokens are intentionally not included in the
committed example. Configure them only in the local `.env`, Docker secrets, or
an equivalent secret manager. Never put them in task messages, event payloads,
evidence, screenshots, or Git.

For host-backed workspaces, configure the host root, container root, and
allowlist consistently. A path valid inside the worker container is not
automatically a valid host path.
