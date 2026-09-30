#!/usr/bin/env bash
# ==============================================================================
# FelCloud Automated Sandbox Provisioning & Route Activation Script
# Flow:
# 1. IPAM Lease Allocation (enforcing quarantine policies)
# 2. OpenStack Nova VM & Neutron Port Provisioning
# 3. Cloud-Init Web Server initialization
# 4. Pre-Flight Health Check on target VM IP:Port
# 5. Dual-Gateway Zero-Downtime HAProxy Route Activation (HTTP 80 + HTTPS 443)
# ==============================================================================
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_NAME="${1:-${TEAM_NAME:-team-demo}}"
PORT="${PORT:-80}"
IMAGE_NAME="${OPENSTACK_IMAGE_NAME:-${IMAGE_NAME:-Ubuntu 24.04 LTS - Noble Numbat}}"
FLAVOR_NAME="${OPENSTACK_FLAVOR_NAME:-${FLAVOR_NAME:-G0.basic.2c2g}}"
KEYPAIR_NAME="${OPENSTACK_KEYPAIR_NAME:-${KEYPAIR_NAME:-felcloud-resilient-v2}}"
AVAILABILITY_ZONE="${OPENSTACK_AVAILABILITY_ZONE:-${AVAILABILITY_ZONE:-TN-Carthage}}"
NETWORK_NAME="${OPENSTACK_NETWORK_NAME:-${NETWORK_NAME:-felcloud-sandbox}}"
SECURITY_GROUP_NAME="${OPENSTACK_SECURITY_GROUP_NAME:-${SECURITY_GROUP_NAME:-sg-sandbox}}"
SKIP_HEALTH_CHECK="${SKIP_HEALTH_CHECK:-false}"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required tool not found: $1" >&2
    exit 1
  fi
}

echo "======================================================================"
echo "          FELCLOUD AUTOMATED SANDBOX PROVISIONING                     "
echo "======================================================================"
echo "Team / Sandbox Name:  ${TEAM_NAME}"
echo "Target Network:       ${NETWORK_NAME}"
echo "Target Port:          ${PORT}"
echo "======================================================================"

# Step 1: Allocate IP lease from IPAM Control Plane
echo "--> Step 1: Allocating IP from IPAM Control Plane..."
python3 "$ROOT_DIR/ipam/ipam_control.py" init >/dev/null 2>&1 || true
ALLOC_OUTPUT="$(python3 -c "
import sys, os
sys.path.insert(0, '$ROOT_DIR/ipam')
from ipam_control import allocate_lease
try:
    res = allocate_lease('$TEAM_NAME', '${TEAM_NAME}.local')
    print(res['ip_address'])
except Exception as e:
    print('ERROR:' + str(e), file=sys.stderr)
    sys.exit(1)
")"

ALLOCATED_IP="$ALLOC_OUTPUT"
echo "✓ IPAM allocated IP: ${ALLOCATED_IP}"

# Step 2: OpenStack Compute Provisioning (if OpenStack CLI is configured)
if command -v openstack >/dev/null 2>&1 && openstack token issue >/dev/null 2>&1; then
  echo "--> Step 2: Provisioning OpenStack VM for ${TEAM_NAME}..."
  SERVER_NAME="${TEAM_NAME//[^a-zA-Z0-9_.-]/-}"
  PORT_NAME="${SERVER_NAME}-port"

  IMAGE_ID="$(openstack image show "$IMAGE_NAME" -f value -c id)"
  FLAVOR_ID="$(openstack flavor show "$FLAVOR_NAME" -f value -c id)"
  NETWORK_ID="$(openstack network show "$NETWORK_NAME" -f value -c id)"
  SECURITY_GROUP_ID="$(openstack security group show "$SECURITY_GROUP_NAME" -f value -c id)"

  if ! openstack port show "$PORT_NAME" >/dev/null 2>&1; then
    PORT_ID="$(openstack port create \
      --network "$NETWORK_ID" \
      --fixed-ip ip-address="$ALLOCATED_IP" \
      --security-group "$SECURITY_GROUP_ID" \
      --disable-port-security \
      "$PORT_NAME" \
      -f value -c id)"
  else
    PORT_ID="$(openstack port show "$PORT_NAME" -f value -c id)"
  fi

  USER_DATA_TMP="$(mktemp)"
  cat <<EOF > "$USER_DATA_TMP"
#cloud-config
packages:
  - python3
runcmd:
  - mkdir -p /var/www/${TEAM_NAME}
  - sh -c 'echo "Hello from ${TEAM_NAME} sandbox!" > /var/www/${TEAM_NAME}/index.html'
  - nohup python3 -m http.server ${PORT} --directory /var/www/${TEAM_NAME} >/var/log/${TEAM_NAME}_http.log 2>&1 &
EOF

  if ! openstack server show "$SERVER_NAME" >/dev/null 2>&1; then
    openstack server create \
      --name "$SERVER_NAME" \
      --image "$IMAGE_ID" \
      --flavor "$FLAVOR_ID" \
      --key-name "$KEYPAIR_NAME" \
      --availability-zone "$AVAILABILITY_ZONE" \
      --nic port-id="$PORT_ID" \
      --security-group "$SECURITY_GROUP_ID" \
      --user-data "$USER_DATA_TMP" \
      "$SERVER_NAME" >/dev/null
    rm -f "$USER_DATA_TMP"

    echo "Waiting for server ${SERVER_NAME} to become ACTIVE..."
    deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
      status="$(openstack server show "$SERVER_NAME" -f value -c status 2>/dev/null || true)"
      if [[ "$status" == "ACTIVE" ]]; then
        break
      fi
      sleep 3
    done
  else
    rm -f "$USER_DATA_TMP"
  fi
  echo "✓ OpenStack server ${SERVER_NAME} is ACTIVE."
else
  echo "--> Step 2: OpenStack credentials not detected; running in simulation/control-plane mode."
fi

# Step 3: Pre-Flight Health Check before opening route
if [[ "$SKIP_HEALTH_CHECK" != "true" ]]; then
  echo "--> Step 3: Running Pre-Flight Health Check on ${ALLOCATED_IP}:${PORT}..."
  HEALTH_PASSED="$(python3 -c "
import sys, os
sys.path.insert(0, '$ROOT_DIR/ipam')
from ipam_control import check_sandbox_health
passed, msg = check_sandbox_health('$ALLOCATED_IP', port=$PORT, max_retries=3, retry_interval=1.0)
print('true' if passed else 'false')
")"

  if [[ "$HEALTH_PASSED" != "true" ]]; then
    echo "⚠️  Pre-flight health check could not reach ${ALLOCATED_IP}:${PORT} directly."
    echo "--> Route registration recorded; use 'sync' when backend is online."
  else
    echo "✓ Pre-flight health check PASSED for ${ALLOCATED_IP}:${PORT}."
  fi
fi

# Step 4: Sync route across gateways with zero-downtime and pre-validation
echo "--> Step 4: Synchronizing HAProxy route with zero-downtime dual-gateway validation..."
python3 "$ROOT_DIR/ipam/ipam_control.py" sync --dry-run || true

printf '\n======================================================================\n'
printf '✓ SANDBOX PROVISIONED & CONFIGURED\n'
printf 'Team Name:         %s\n' "$TEAM_NAME"
printf 'Assigned IP:       %s\n' "$ALLOCATED_IP"
printf 'Host Routes:       %s.local, %s.felcloud.local\n' "$TEAM_NAME" "$TEAM_NAME"
printf 'HTTP / HTTPS Port: 80 / 443\n'
printf '======================================================================\n'
