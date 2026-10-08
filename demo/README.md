# AgentWeave VC Demo — Recording Runbook

Reproducible pipeline for the 87-second VC pitch video.

## Prerequisites (demo stack)

All services must be running natively (Docker is unavailable in this sandbox):

| Service     | Address                  | Start command (from repo root) |
|-------------|--------------------------|--------------------------------|
| PostgreSQL  | 127.0.0.1:5432           | pg_ctl via pgserver (see below) |
| NATS        | 127.0.0.1:4222           | `nats-server -js -sd /tmp/nats-data -p 4222 -m 8222` |
| Control API | http://localhost:3000    | `cd apps/control-api && DATABASE_URL=... NATS_URL=nats://127.0.0.1:4222 CONTROL_API_PORT=3000 node dist/main.js` |
| Worker      | —                        | `cd apps/worker && NATS_URL=nats://127.0.0.1:4222 CONTROL_API_URL=http://localhost:3000 AGENTWEAVE_PROVIDER=mock WORKER_ID=worker-demo-1 WORKER_ROLES=pm,pe,backend,frontend,qa MOCK_PROVIDER_DELAY_MS=800 node dist/main.js` |
| Dashboard   | http://localhost:5173    | `cd apps/dashboard && ./node_modules/.bin/vite preview --host 0.0.0.0 --port 5173` |

**Critical quirks:**
- Use `NATS_URL=nats://127.0.0.1:4222` — `localhost` resolves to a sandbox
  firewall address in the NATS Node client.
- `/workspaces/agentweave` must exist (worker tasks fail with ENOENT otherwise).
- **Only ONE worker may run.** Competing workers steal inbox messages and
  produce mixed old/new mock content. Kill duplicates by PID (never `pkill -f`
  with a pattern that matches your own shell).
- Wipe workstreams between takes: `DELETE FROM workstreams;` + restart control-api
  (it holds workstreams in memory).

## Recording

```bash
cd ~/workspace/agentweave
rm -rf demo/output
xvfb-run -a -s "-screen 0 1920x1080x24" \
  ./node_modules/.bin/playwright test -c demo/playwright.demo.config.ts --headed
```

- Uses Playwright's bundled Chromium (the system Chromium 152 blocks localhost
  via Local Network Access checks in this sandbox).
- `xvfb-run --headed` gives a visible cursor in the recording.
- Video: 1920×1080 webm at `demo/output/*/video.webm`.
- The mock provider serves deterministic CRDT-vs-OT narrative content, so the
  take is flake-free. Dashboard, control API, Postgres and NATS are all real.

## Post-production

```bash
# 1. webm -> mp4
ffmpeg -y -i demo/output/*/video.webm -c:v libx264 -pix_fmt yuv420p -crf 20 -c:a aac demo/output/raw-demo.mp4

# 2. Title/close cards (HTML -> PNG via Chromium) -> 5s / 8s clips
# 3. Voiceover segments: /opt/hatch/bin/tts speak --voice avocado_v2:MAI_03
#    (segments in /tmp/vo/, script in demo/VOICEOVER.md)
# 4. Assemble: title(5s) + establishing-loop(12s) + raw(62s) + close(8s) = 87s
# 5. Mix VO at 0.8s / 5.5s / 23s / 35s / 67s / 79.5s via adelay+amix
```

See `demo/VOICEOVER.md` for the narration script with footage timestamps.

## Files

- `demo/vc-pitch.spec.ts` — paced recording script
- `demo/playwright.demo.config.ts` — 1080p video-on config
- `demo/VOICEOVER.md` — narration script (v2: fictional launch story)
- `demo/output/agentweave-vc-demo-v2.mp4` — final 88s video (v2)
- `demo/output/raw-demo-v2.mp4` — raw 63s screen capture (v2)

## Narrative versions

- **v1**: CRDT vs OT technical debate (realtime sync architecture).
- **v2** (current): Fictional startup launch strategy — Product Hunt vs paid ads,
  reviewer challenges on retention, lead synthesizes "100 design partners,
  gated by 40% week-4 retention". Fully fictional per Steven's direction
  ("随便, 只是demo, 不要用真实例子").

## VM reset recovery (2026-10-06)

The sandbox VM was replaced mid-session, wiping `/usr/local/bin`, `/tmp`,
and `/workspaces`. Recovery:
- Reinstalled nats-server to `~/workspace/bin/` (persistent).
- Reinstalled pgserver via pip; data dir `/tmp/pgdata-agentweave` recreated.
- Postgres runs via pgserver Python API (Unix socket); a Python TCP→socket
  forwarder exposes 127.0.0.1:5432 for the control-api.
- Recreated `/workspaces/agentweave` (worker ENOENT otherwise).
- Full DB wipe between takes: TRUNCATE all tables CASCADE (the control-api
  crashes with a `workflow_events` unique-constraint violation if stale
  events survive a workstream DELETE).
