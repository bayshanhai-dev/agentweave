#!/bin/bash
# AgentWeave GCP e2-micro (1GB RAM) one-shot deploy.
# Run as root: curl -sSL <url> | sudo bash
# Installs: Node 22, PostgreSQL 16 (tuned for 1GB), NATS, builds AgentWeave,
# and starts control-api + worker as systemd services.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bayshanhai-dev/agentweave.git}"
APP_DIR="/opt/agentweave"
WORKSPACE_ROOT="/workspaces/agentweave"

echo "=== [1/8] System update & base packages ==="
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg lsb-release > /dev/null

echo "=== [2/8] Node.js 22 ==="
if ! command -v node > /dev/null; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs > /dev/null
fi
node --version
npm install -g pnpm > /dev/null 2>&1 || true

echo "=== [3/8] PostgreSQL 16 (tuned for 1GB RAM) ==="
if ! command -v psql > /dev/null; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
  echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16 > /dev/null
fi
# Tune for 1GB: cut shared_buffers/work_mem way down
PGCONF="$(ls /etc/postgresql/16/main/postgresql.conf)"
grep -q "agentweave-tuning" "$PGCONF" || cat >> "$PGCONF" << 'EOF'
# agentweave-tuning (1GB VM)
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 2MB
maintenance_work_mem = 32MB
max_connections = 40
EOF
systemctl enable --now postgresql > /dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='agentweave'" | grep -q 1 || sudo -u postgres createdb agentweave
echo "postgres ready"

echo "=== [4/8] NATS ==="
if ! command -v nats-server > /dev/null; then
  NATS_VER="2.11.4"
  curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v${NATS_VER}/nats-server-v${NATS_VER}-linux-amd64.tar.gz" -o /tmp/nats.tar.gz
  tar -xzf /tmp/nats.tar.gz -C /tmp
  install -m 755 "/tmp/nats-server-v${NATS_VER}-linux-amd64/nats-server" /usr/local/bin/nats-server
  rm -rf /tmp/nats.tar.gz "/tmp/nats-server-v${NATS_VER}-linux-amd64"
fi
mkdir -p /var/lib/nats
cat > /etc/systemd/system/nats.service << 'EOF'
[Unit]
Description=NATS JetStream
After=network.target
[Service]
ExecStart=/usr/local/bin/nats-server -js -sd /var/lib/nats
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now nats > /dev/null
echo "nats ready"

echo "=== [5/8] Clone & build AgentWeave ==="
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only || true
fi
cd "$APP_DIR"
pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install > /dev/null 2>&1
pnpm run build > /dev/null 2>&1 || pnpm build > /dev/null 2>&1
echo "build done"

echo "=== [6/8] Workspace dir ==="
mkdir -p "$WORKSPACE_ROOT"

echo "=== [7/8] systemd services: control-api + worker ==="
cat > /etc/systemd/system/agentweave-api.service << EOF
[Unit]
Description=AgentWeave Control API
After=postgresql.service nats.service network.target
[Service]
WorkingDirectory=$APP_DIR/apps/control-api
Environment=DATABASE_URL=postgres://postgres@localhost:5432/agentweave
Environment=NATS_URL=nats://localhost:4222
Environment=PORT=3000
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/agentweave-worker.service << EOF
[Unit]
Description=AgentWeave Worker
After=agentweave-api.service network.target
[Service]
WorkingDirectory=$APP_DIR/apps/worker
Environment=CONTROL_API_URL=http://localhost:3000
Environment=NATS_URL=nats://localhost:4222
Environment=AGENTWEAVE_PROVIDER=\${AGENTWEAVE_PROVIDER:-mock}
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agentweave-api > /dev/null
sleep 3
systemctl enable --now agentweave-worker > /dev/null

echo "=== [8/8] Health check ==="
sleep 5
curl -sf http://localhost:3000/api/health > /dev/null && echo "control-api: OK" || echo "control-api: NOT READY (check journalctl -u agentweave-api)"
systemctl is-active agentweave-worker > /dev/null && echo "worker: active" || echo "worker: NOT ACTIVE"
free -m | head -2
echo "=== deploy done ==="
