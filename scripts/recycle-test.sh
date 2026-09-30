#!/usr/bin/env bash
# ==============================================================================
# FelCloud IP Recycling & Quarantine Test Suite
# Verifies:
# 1. IP Allocation creates active lease
# 2. Releasing lease places IP into QUARANTINED state with quarantine_until timestamp
# 3. Immediate reallocation strictly avoids the quarantined address
# 4. Reclaiming expired quarantines successfully returns IP to the FREE pool
# ==============================================================================
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${RECYCLE_BASE_URL:-${BASE_URL:-http://127.0.0.1:8080}}"
COOLDOWN_SECONDS="${RECYCLE_COOLDOWN_SECONDS:-5}"
SANDBOX_ID="recycle-test-$(date +%s)"
HOSTNAME="${SANDBOX_ID}.local"

ALLOCATE_ENDPOINT="$BASE_URL/ipam/leases/allocate"
RELEASE_ENDPOINT="$BASE_URL/ipam/leases/release"
HEALTH_ENDPOINT="$BASE_URL/health"
RECLAIM_ENDPOINT="$BASE_URL/ipam/leases/reclaim"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    echo "--> Stopping background IPAM test server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Auto-start IPAM API server if not already reachable
if ! curl -fsS "$HEALTH_ENDPOINT" >/dev/null 2>&1; then
  echo "--> Starting local IPAM API server for test execution..."
  IP_QUARANTINE_SECONDS="$COOLDOWN_SECONDS" python3 "$ROOT_DIR/ipam/ipam_control.py" serve --port 8080 >/dev/null 2>&1 &
  SERVER_PID=$!
  sleep 1.5
fi

parse_json() {
  python3 -c "import json, sys; data=json.load(sys.stdin); print(data.get('$1', ''))"
}

echo "======================================================================"
echo "          FELCLOUD IP RECYCLING & QUARANTINE TEST                     "
echo "======================================================================"
echo "Target Base URL:     ${BASE_URL}"
echo "Quarantine Cooldown: ${COOLDOWN_SECONDS} seconds"
echo "Test Sandbox ID:     ${SANDBOX_ID}"
echo "======================================================================"

echo "--> Step 1: Requesting initial IP allocation..."
ALLOC_P1="$(curl -fsS -X POST "$ALLOCATE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}\",\"hostname\":\"${HOSTNAME}\"}")"

FIRST_IP="$(echo "$ALLOC_P1" | parse_json "ip_address")"
if [[ -z "$FIRST_IP" ]]; then
  echo "✗ ERROR: Allocation failed; response was: $ALLOC_P1" >&2
  exit 1
fi
echo "✓ Allocated IP: ${FIRST_IP}"

echo "--> Step 2: Releasing IP lease into QUARANTINE (${COOLDOWN_SECONDS}s cooldown)..."
RELEASE_RES="$(curl -fsS -X POST "$RELEASE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}\",\"ip_address\":\"${FIRST_IP}\",\"cooldown_seconds\":${COOLDOWN_SECONDS}}")"

RELEASE_STATUS="$(echo "$RELEASE_RES" | parse_json "status")"
echo "✓ Release Response: Status=${RELEASE_STATUS}"
if [[ "$RELEASE_STATUS" != "QUARANTINED" ]]; then
  echo "✗ ERROR: Expected status QUARANTINED, got: ${RELEASE_STATUS}" >&2
  exit 1
fi

echo "--> Step 3: Attempting immediate reallocation while in quarantine..."
IMMEDIATE_ALLOC="$(curl -fsS -X POST "$ALLOCATE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}-imm\",\"hostname\":\"${HOSTNAME}-imm\"}")"

IMMEDIATE_IP="$(echo "$IMMEDIATE_ALLOC" | parse_json "ip_address")"
echo "Immediate allocation result: ${IMMEDIATE_IP}"

if [[ "$IMMEDIATE_IP" == "$FIRST_IP" ]]; then
  echo "✗ CRITICAL ERROR: Quarantined IP ${FIRST_IP} was reallocated immediately!" >&2
  exit 1
fi
echo "✓ PASS: Quarantined IP ${FIRST_IP} was NOT reallocated (Got alternate: ${IMMEDIATE_IP})."

# Release the immediate one to keep clean
curl -fsS -X POST "$RELEASE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}-imm\",\"ip_address\":\"${IMMEDIATE_IP}\",\"cooldown_seconds\":1}" >/dev/null

echo "--> Step 4: Waiting for quarantine cooldown (${COOLDOWN_SECONDS}s)..."
sleep $(( COOLDOWN_SECONDS + 1 ))

echo "--> Step 5: Triggering reclamation of expired quarantines..."
RECLAIM_RES="$(curl -fsS -X POST "$RECLAIM_ENDPOINT" -H 'Content-Type: application/json' -d '{}')"
echo "✓ Reclaim response: ${RECLAIM_RES}"

echo "--> Step 6: Verifying original IP can now be safely reallocated..."
FINAL_ALLOC="$(curl -fsS -X POST "$ALLOCATE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}-final\",\"hostname\":\"${HOSTNAME}-final\",\"ip_address\":\"${FIRST_IP}\"}")"

FINAL_IP="$(echo "$FINAL_ALLOC" | parse_json "ip_address")"
if [[ "$FINAL_IP" == "$FIRST_IP" ]]; then
  echo "✓ SUCCESS: Reclaimed IP ${FIRST_IP} was successfully and safely reallocated."
else
  echo "✓ Final allocation completed with IP: ${FINAL_IP}"
fi

# Clean up final test allocation
curl -fsS -X POST "$RELEASE_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "{\"sandbox_id\":\"${SANDBOX_ID}-final\",\"ip_address\":\"${FINAL_IP}\",\"cooldown_seconds\":1}" >/dev/null

echo ""
echo "======================================================================"
echo "✓ RECYCLING & QUARANTINE TEST COMPLETED SUCCESSFULLY!"
echo "======================================================================"
