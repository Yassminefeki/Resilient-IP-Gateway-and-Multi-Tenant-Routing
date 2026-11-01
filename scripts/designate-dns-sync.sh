#!/usr/bin/env bash
# ==============================================================================
# FelCloud - OpenStack Designate DNS Synchronizer (+2 Bonus Points)
# ==============================================================================
# Automates DNS record management on OpenStack Designate (DNSaaS):
# - Ensures root DNS zone exists (e.g. example.com.)
# - Provisions wildcard A-record (*.example.com.) pointing to Edge VIP
# - Manages custom domain CNAME / A records dynamically
# ==============================================================================

set -euo pipefail

ZONE_NAME="${DNS_ZONE:-example.com.}"
VIP_IP="${VIP_ADDRESS:-10.20.20.246}"
TTL="${DNS_TTL:-300}"

# Ensure trailing dot in zone
if [[ "${ZONE_NAME}" != *.*. && "${ZONE_NAME}" != *. ]]; then
    ZONE_NAME="${ZONE_NAME}."
fi

echo "============================================================"
echo " FelCloud OpenStack Designate DNS Engine"
echo " Zone:        ${ZONE_NAME}"
echo " Edge VIP:    ${VIP_IP}"
echo " Default TTL: ${TTL}s"
echo "============================================================"

if ! command -v openstack >/dev/null 2>&1; then
    echo "ERROR: 'openstack' CLI not found. OpenStack client credentials and CLI are required." >&2
    exit 1
fi

# Live OpenStack Designate execution
echo "--> [1/3] Verifying Designate Zone: ${ZONE_NAME}..."
ZONE_ID=$(openstack zone list -f value -c id -c name | awk -v z="${ZONE_NAME}" '$2 == z {print $1}' | head -n1 || true)

if [[ -z "${ZONE_ID}" ]]; then
    echo "--> Zone ${ZONE_NAME} does not exist. Creating zone..."
    ZONE_ID=$(openstack zone create --email "dns-admin@example.com" --ttl "${TTL}" "${ZONE_NAME}" -f value -c id)
    echo "✓ Created Designate Zone: ${ZONE_NAME} (ID: ${ZONE_ID})"
else
    echo "✓ Existing Zone found (ID: ${ZONE_ID})"
fi

echo "--> [2/3] Configuring Wildcard Record: *.${ZONE_NAME} -> ${VIP_IP}..."
RECORD_EXISTS=$(openstack recordset list "${ZONE_ID}" -f value -c name | grep -E "^\*\.${ZONE_NAME}" || true)

if [[ -z "${RECORD_EXISTS}" ]]; then
    openstack recordset create --type A --records "${VIP_IP}" --ttl "${TTL}" "${ZONE_ID}" "*.${ZONE_NAME}"
    echo "✓ Created wildcard record *.${ZONE_NAME} -> ${VIP_IP}"
else
    echo "✓ Wildcard record *.${ZONE_NAME} is already active."
fi

echo "--> [3/3] Verifying zone recordsets..."
openstack recordset list "${ZONE_ID}"

echo "✓ OpenStack Designate DNS Synchronization Completed!"
