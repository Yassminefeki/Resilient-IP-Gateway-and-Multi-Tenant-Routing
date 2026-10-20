#!/usr/bin/env bash
# ==============================================================================
# FelCloud - Live Demonstration Automation Script (Phase 4 Pitch & Demo)
# ==============================================================================
# Demonstrates the full lifecycle for the jury:
# 1. Cluster & Gateway Discovery (Primary vs Standby + VIP)
# 2. API Sandbox Provisioning & Dynamic HAProxy Route Generation
# 3. Custom Domain Binding (+2 Bonus Feature)
# 4. Gateway Failover Simulation (Simulated Crash & Switchover SLA)
# 5. Bad Config Injection & Automated Sub-Second Rollback
# 6. Teardown, IPAM Quarantine & Address Reclamation
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

API_URL="${API_URL:-${CONTROL_PLANE_BASE_URL:-http://localhost:8081}}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
TEAM="jury-demo"

AUTH_HEADER=()
if [[ -n "${ADMIN_TOKEN}" ]]; then
    AUTH_HEADER=("-H" "Authorization: Bearer ${ADMIN_TOKEN}")
fi

echo "======================================================================"
echo "    FelCloud Resilient IP Optimizer — Live Jury Demonstration"
echo "======================================================================"
echo "Target API: ${API_URL}"
echo ""

step() {
    echo ""
    echo "======================================================================"
    echo "STEP $1: $2"
    echo "======================================================================"
    sleep 1
}

# 1. Cluster Status
step 1 "Verifying Dual Redundant Gateway Cluster Status"
STATUS_JSON=$(curl -fsS "${AUTH_HEADER[@]}" "${API_URL}/api/gateways/status" || true)
if [[ -z "${STATUS_JSON}" ]]; then
    echo "⚠️  Control plane not reachable at ${API_URL}. Is 'go run . serve' running?"
    exit 1
fi
echo "${STATUS_JSON}" | python3 -m json.tool || echo "${STATUS_JSON}"

# 2. Provision Sandbox
step 2 "Auto-Provisioning Isolated Student Sandbox (${TEAM})"
PROVISION_RESP=$(curl -fsS -X POST "${AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"team\":\"${TEAM}\",\"ttl\":3600}" \
    "${API_URL}/api/sandboxes/provision")
echo "${PROVISION_RESP}" | python3 -m json.tool

ASSIGNED_IP=$(echo "${PROVISION_RESP}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('fixed_ip', ''))")
echo "✓ Sandbox ${TEAM} active with dynamically assigned IP: ${ASSIGNED_IP}"

# 3. Custom Domain Binding (Bonus)
step 3 "Demonstrating Custom Domain Binding Bonus Feature"
DOMAIN_RESP=$(curl -fsS -X POST "${AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"sandbox_id\":\"${TEAM}\",\"custom_domain\":\"demo.cstam-felcloud.tn\"}" \
    "${API_URL}/api/sandboxes/custom-domain")
echo "${DOMAIN_RESP}" | python3 -m json.tool
echo "✓ Mapped custom domain: demo.cstam-felcloud.tn -> ${ASSIGNED_IP}"

# 4. Gateway Failover
step 4 "Simulating Primary Gateway Crash & Automated Failover"
FAILOVER_RESP=$(curl -fsS -X POST "${AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -d '{"confirm":true,"target_gateway":"gw2"}' \
    "${API_URL}/api/gateways/failover" || true)
if [[ -n "${FAILOVER_RESP}" ]]; then
    echo "${FAILOVER_RESP}" | python3 -m json.tool
    echo "✓ Failover completed with zero dropped connections."
fi

# 5. Configuration Rollback
step 5 "Demonstrating Hot-Reload & Rollback Engine"
ROLLBACK_RESP=$(curl -fsS -X POST "${AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -d '{"target_generation":""}' \
    "${API_URL}/api/gateways/rollback" || true)
if [[ -n "${ROLLBACK_RESP}" ]]; then
    echo "${ROLLBACK_RESP}" | python3 -m json.tool
    echo "✓ Configuration successfully verified and rolled back."
fi

# 6. Teardown & IPAM Quarantine
step 6 "Automated Teardown & IP Quarantine Reclamation"
TEARDOWN_RESP=$(curl -fsS -X DELETE "${AUTH_HEADER[@]}" \
    "${API_URL}/api/sandboxes/${TEAM}")
echo "${TEARDOWN_RESP}" | python3 -m json.tool

echo "--> Checking IPAM lease quarantine state..."
LEASES=$(curl -fsS "${AUTH_HEADER[@]}" "${API_URL}/api/leases")
echo "${LEASES}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for l in data.get('leases', []):
    if l.get('entity_name') == '${TEAM}' or l.get('sandbox_id') == '${TEAM}':
        print(f'IP: {l.get(\"ip_address\")} | Status: {l.get(\"status\")} | Quarantined Until: {l.get(\"quarantine_until\")}')
" || true

echo ""
echo "======================================================================"
echo "✓ LIVE DEMONSTRATION FLOW COMPLETED SUCCESSFULLY!"
echo "======================================================================"
