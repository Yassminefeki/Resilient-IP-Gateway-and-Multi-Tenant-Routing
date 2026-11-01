#!/usr/bin/env bash
# ==============================================================================
# FelCloud Automated Docker Smoke Test
# Verifies container build, healthcheck, auth, API, UI, non-root user,
# volume persistence across restarts, and clean teardown.
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== [1/8] Generating test credentials ==="
export ADMIN_TOKEN
ADMIN_TOKEN="$(openssl rand -hex 32)"
echo "Test ADMIN_TOKEN generated: ${ADMIN_TOKEN:0:8}..."

cleanup() {
  echo "=== Teardown test environment ==="
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== [2/8] Building and starting controlplane in mock mode ==="
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --build controlplane

echo "=== [3/8] Waiting for container health ==="
retries=30
until [ "$(docker compose ps --format json controlplane 2>/dev/null | grep -c '"healthy"' || true)" -ge 1 ]; do
  retries=$((retries - 1))
  if [ "$retries" -le 0 ]; then
    echo "[-] FAILED: controlplane did not become healthy within 30s." >&2
    docker compose logs controlplane >&2
    exit 1
  fi
  sleep 1
done
echo "[+] Container is reported healthy by Docker."

echo "=== [4/8] Verifying HTTP endpoints ==="
# 4a. Health check
health_code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/health)
if [ "$health_code" != "200" ]; then
  echo "[-] FAILED: /health returned HTTP ${health_code}, expected 200" >&2
  exit 1
fi
echo "[+] GET /health returned HTTP 200 OK."

# 4b. UI index
ui_body=$(curl -s http://127.0.0.1:8081/ui/)
if ! echo "$ui_body" | grep -q "CloudPulse"; then
  echo "[-] FAILED: GET /ui/ did not contain 'CloudPulse'" >&2
  exit 1
fi
echo "[+] GET /ui/ returned HTTP 200 with SPA index HTML."

# 4c. Auth rejection
unauth_code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/api/sandboxes)
if [ "$unauth_code" != "401" ]; then
  echo "[-] FAILED: unauthenticated GET /api/sandboxes returned HTTP ${unauth_code}, expected 401" >&2
  exit 1
fi
echo "[+] Unauthenticated GET /api/sandboxes rejected with HTTP 401."

# 4d. Authenticated access
auth_code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${ADMIN_TOKEN}" http://127.0.0.1:8081/api/sandboxes)
if [ "$auth_code" != "200" ]; then
  echo "[-] FAILED: authenticated GET /api/sandboxes returned HTTP ${auth_code}, expected 200" >&2
  exit 1
fi
echo "[+] Authenticated GET /api/sandboxes succeeded with HTTP 200."

echo "=== [5/8] Verifying non-root user execution ==="
uid=$(docker compose exec -T controlplane id -u)
if [ "$uid" != "10001" ]; then
  echo "[-] FAILED: Container running as UID ${uid}, expected 10001" >&2
  exit 1
fi
echo "[+] Container is running as non-root user UID 10001."

echo "=== [6/8] Seeding demo data ==="
docker compose --profile seed run --rm seed
sandboxes_resp=$(curl -s -H "Authorization: Bearer ${ADMIN_TOKEN}" http://127.0.0.1:8081/api/sandboxes)
if ! echo "$sandboxes_resp" | grep -q "team-alpha"; then
  echo "[-] FAILED: Seeded sandbox 'team-alpha' not found in /api/sandboxes output: ${sandboxes_resp}" >&2
  exit 1
fi
echo "[+] Seeded data verified: 'team-alpha' present in active sandboxes."

echo "=== [7/8] Verifying SQLite volume persistence across restart ==="
docker compose down
docker compose up -d controlplane

retries=30
until [ "$(docker compose ps --format json controlplane 2>/dev/null | grep -c '"healthy"' || true)" -ge 1 ]; do
  retries=$((retries - 1))
  if [ "$retries" -le 0 ]; then
    echo "[-] FAILED: controlplane did not become healthy after restart." >&2
    exit 1
  fi
  sleep 1
done

persisted_resp=$(curl -s -H "Authorization: Bearer ${ADMIN_TOKEN}" http://127.0.0.1:8081/api/sandboxes)
if ! echo "$persisted_resp" | grep -q "team-alpha"; then
  echo "[-] FAILED: State did not persist after container restart: ${persisted_resp}" >&2
  exit 1
fi
echo "[+] Data persistence verified: 'team-alpha' retained in SQLite volume."

echo "=== [8/8] Testing dry-run benchmark harness ==="
docker compose --profile bench run --rm bench
echo "[+] Benchmark harness container ran in dry-run mode successfully."

echo "======================================================================"
echo "  ALL DOCKER SMOKE TESTS PASSED SUCCESSFULLY"
echo "======================================================================"
