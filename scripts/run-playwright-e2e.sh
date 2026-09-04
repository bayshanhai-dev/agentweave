#!/usr/bin/env bash
set -euo pipefail

compose_project="${COMPOSE_PROJECT_NAME:-agentweave-ev17-e2e}"
export COMPOSE_PROJECT_NAME="$compose_project"
export AGENTWEAVE_PROVIDER=mock
export MOCK_PROVIDER_DELAY_MS="${MOCK_PROVIDER_DELAY_MS:-250}"
export POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-15432}"
export NATS_HOST_PORT="${NATS_HOST_PORT:-14222}"
export NATS_MONITOR_HOST_PORT="${NATS_MONITOR_HOST_PORT:-18222}"
export CONTROL_API_HOST_PORT="${CONTROL_API_HOST_PORT:-13000}"
export DASHBOARD_HOST_PORT="${DASHBOARD_HOST_PORT:-15173}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:${DASHBOARD_HOST_PORT}}"
export E2E_CONTROL_API_URL="${E2E_CONTROL_API_URL:-http://localhost:${CONTROL_API_HOST_PORT}}"

mkdir -p test-results

cleanup() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    docker compose logs --no-color > test-results/docker-compose.log 2>&1 || true
  fi
  if [[ "${E2E_KEEP_STACK:-0}" != "1" ]]; then
    docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

docker compose up --build --detach postgres nats control-api worker dashboard

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts=60
  until curl --fail --silent --show-error "$url" >/dev/null; do
    attempts=$((attempts - 1))
    if [[ $attempts -eq 0 ]]; then
      echo "Timed out waiting for ${name} at ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_url "Control API" "${E2E_CONTROL_API_URL}/health"
wait_for_url "Dashboard" "${E2E_BASE_URL}/"
pnpm exec playwright test
