# Troubleshooting

Real issues encountered running AgentWeave, with fixes.

## Worker stuck at startup (no inbox consumer)

**Symptom:** Worker logs `worker.started` but never logs `worker.inbox.ready`. Tasks stay `assigned`, never dispatched.

**Cause:** `CONTROL_API_URL` defaults to `http://control-api:3000` (Docker hostname). When running the worker outside Docker, it loops forever in `registerWorker()` trying to reach an unresolvable host.

**Fix:** Set `CONTROL_API_URL=http://localhost:3000` (or wherever your control-api runs).

## Collaboration round stuck at proposals (0 insights)

**Symptom:** Proposal tasks complete (`done`), but no critique/synthesis tasks are created. Round never advances. Insights count is 0.

**Cause:** The LLM's output didn't parse into a structured result. The worker only attempted JSON parsing when the text started with `{` or ```` ```json ```` — real LLMs often add prose before/after the JSON ("Here's my proposal: {...}"), so `structuredResult` was `undefined` and no insights were created.

**Fix:** (Fixed in PR #57) The worker now tries to extract JSON from anywhere in the output: code fence → full text → largest embedded `{...}` block.

**Debug:** Open the dashboard's **Trace debug** button to see the event chain by correlationId and inspect the raw `task.completed` payload.

## Task fails with `ENOENT: no such file or directory, access '/workspaces/...'`

**Symptom:** `worker.message.failed_terminal` with ENOENT on the workspace path.

**Cause:** The workstream's `workspaceRoot` doesn't exist on the worker's filesystem. In Docker it's `/workspaces`; locally you must create it.

**Fix:** Create the directory (e.g. `mkdir -p /workspaces/agentweave`) or set a valid `workspaceRoot` when creating the workstream.

## NATS "unexpected response from server"

**Symptom:** Node.js NATS client throws `unexpected response from server` on connect. Raw TCP shows a truncated `INFO` response.

**Cause:** Corrupted JetStream data directory (often after a hard kill).

**Fix:** Stop NATS, delete the data directory (`-sd` path), restart. The stream and consumers are recreated on connect.

## Postgres refuses to run as root

**Symptom:** `initdb: error: cannot be run as root`

**Cause:** PostgreSQL refuses to run as root for security.

**Fix:** Run as an unprivileged user (e.g. `nobody` or a dedicated `postgres` user). If installing from `.deb` without sudo, extract with `dpkg-deb -x` and set `LD_LIBRARY_PATH` to the extracted `libpq`.

## Session lease lost mid-run

**Symptom:** `task.failed` with `Session lease lost`.

**Cause:** The 60-second session lease expired during a long multi-turn run and another worker acquired it. (Fixed in PR #56: lease is now renewed after every turn; if renewal fails the run fails cleanly instead of continuing with a stolen lease.)

## Dashboard shows no events

**Symptom:** Workstream exists but Live Events / Trace Debugger are empty.

**Cause:** The control-api's event projector hasn't processed the NATS stream, or the workstream was created but never started (status `draft`).

**Fix:** Start the workstream via `POST /api/workstreams/:id/start`. Check control-api logs for projector errors.
