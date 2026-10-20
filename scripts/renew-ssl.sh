#!/usr/bin/env bash
# ==============================================================================
# FelCloud - Automated SSL/TLS Renewal & Zero-Downtime Reload (+2 Bonus Points)
# ==============================================================================
# Inspects certificate remaining lifetime and renews if expiring within 30 days.
# ==============================================================================

set -euo pipefail

CERT_PATH="${1:-/etc/haproxy/certs/felcloud-gateway.pem}"
THRESHOLD_DAYS="${THRESHOLD_DAYS:-30}"
THRESHOLD_SECONDS=$(( THRESHOLD_DAYS * 86400 ))

if [[ ! -f "${CERT_PATH}" ]]; then
    echo "ERROR: Certificate not found at ${CERT_PATH}" >&2
    exit 1
fi

echo "--> Checking certificate expiration for ${CERT_PATH}..."
if openssl x509 -checkend "${THRESHOLD_SECONDS}" -noout -in "${CERT_PATH}" >/dev/null 2>&1; then
    REMAINING_DATE=$(openssl x509 -enddate -noout -in "${CERT_PATH}" | cut -d= -f2)
    echo "✓ Certificate is valid until ${REMAINING_DATE} (greater than ${THRESHOLD_DAYS} days). No renewal needed."
    exit 0
fi

echo "⚠️  Certificate is expiring in less than ${THRESHOLD_DAYS} days. Triggering automated renewal..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$(dirname "${CERT_PATH}")" "${SCRIPT_DIR}/setup-ssl.sh"

echo "--> Triggering HAProxy hot-reload..."
if systemctl is-active --quiet haproxy 2>/dev/null; then
    systemctl reload haproxy
    echo "✓ HAProxy reloaded with renewed certificate."
else
    echo "ℹ️ HAProxy not running locally or non-systemd environment. Reload skipped."
fi
