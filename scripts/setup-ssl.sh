#!/usr/bin/env bash
# ==============================================================================
# FelCloud - Automated SSL/TLS Certificate Provisioner (+2 Bonus Points)
# ==============================================================================
# Provides automated issuance and deployment of wildcard TLS certificates:
# - Self-Signed / Internal CA mode (for isolated sandboxes / staging)
# - Let's Encrypt / Certbot mode (production DNS-01 / HTTP-01)
# ==============================================================================

set -euo pipefail

DOMAIN="${DOMAIN:-cstam.felcloud.tn}"
OUTPUT_DIR="${OUTPUT_DIR:-/etc/haproxy/certs}"
BUNDLE_FILE="${OUTPUT_DIR}/felcloud-gateway.pem"
MODE="${MODE:-self-signed}" # 'self-signed' or 'letsencrypt'
DAYS_VALID="${DAYS_VALID:-365}"
VIP="${VIP_ADDRESS:-10.20.20.246}"
GW1_EDGE="${GW1_EDGE_IP:-10.20.20.82}"
GW2_EDGE="${GW2_EDGE_IP:-10.20.20.190}"

echo "============================================================"
echo " FelCloud Automated SSL/TLS Engine"
echo " Domain:        *.${DOMAIN}"
echo " Mode:          ${MODE}"
echo " Output Target: ${BUNDLE_FILE}"
echo "============================================================"

mkdir -p "${OUTPUT_DIR}"
TMP_DIR=$(mktemp -d /tmp/felcloud-ssl-XXXXXX)
trap 'rm -rf "${TMP_DIR}"' EXIT

if [[ "${MODE}" == "self-signed" ]]; then
    echo "--> [1/4] Generating Internal Certificate Authority (CA)..."
    openssl req -x509 -nodes -new -sha256 -days 1825 \
        -newkey rsa:2048 \
        -keyout "${TMP_DIR}/felcloud-ca.key" \
        -out "${TMP_DIR}/felcloud-ca.crt" \
        -subj "/C=TN/ST=Tunis/O=FelCloud/OU=Infrastructure/CN=FelCloud Root CA"

    echo "--> [2/4] Generating Private Key and CSR for *.${DOMAIN}..."
    openssl req -nodes -new -sha256 \
        -newkey rsa:2048 \
        -keyout "${TMP_DIR}/server.key" \
        -out "${TMP_DIR}/server.csr" \
        -subj "/C=TN/ST=Tunis/O=FelCloud/OU=Edge Gateways/CN=*.${DOMAIN}"

    echo "--> [3/4] Preparing SAN Extension configuration..."
    cat > "${TMP_DIR}/san.cnf" <<EOF
basicConstraints = CA:FALSE
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.${DOMAIN}
DNS.2 = ${DOMAIN}
DNS.3 = *.local
DNS.4 = *.felcloud.local
IP.1 = ${VIP}
IP.2 = ${GW1_EDGE}
IP.3 = ${GW2_EDGE}
IP.4 = 127.0.0.1
EOF

    echo "--> [4/4] Signing Certificate with FelCloud CA..."
    openssl x509 -req -sha256 \
        -days "${DAYS_VALID}" \
        -in "${TMP_DIR}/server.csr" \
        -CA "${TMP_DIR}/felcloud-ca.crt" \
        -CAkey "${TMP_DIR}/felcloud-ca.key" \
        -CAcreateserial \
        -out "${TMP_DIR}/server.crt" \
        -extfile "${TMP_DIR}/san.cnf"

    # Assemble combined PEM bundle for HAProxy: [cert] + [intermediate/CA] + [key]
    cat "${TMP_DIR}/server.crt" "${TMP_DIR}/felcloud-ca.crt" "${TMP_DIR}/server.key" > "${BUNDLE_FILE}"
    chmod 600 "${BUNDLE_FILE}"

    echo "✓ Wildcard certificate successfully assembled at ${BUNDLE_FILE}"

elif [[ "${MODE}" == "letsencrypt" ]]; then
    echo "--> Running Certbot for *.${DOMAIN}..."
    if ! command -v certbot >/dev/null 2>&1; then
        echo "ERROR: certbot executable not found. Install certbot or use MODE=self-signed." >&2
        exit 1
    fi

    certbot certonly \
        --manual \
        --preferred-challenges=dns \
        -d "*.${DOMAIN}" \
        -d "${DOMAIN}" \
        --agree-tos \
        --non-interactive \
        --config-dir "${TMP_DIR}/letsencrypt" \
        --work-dir "${TMP_DIR}/work" \
        --logs-dir "${TMP_DIR}/logs"

    LIVE_DIR="${TMP_DIR}/letsencrypt/live/${DOMAIN}"
    cat "${LIVE_DIR}/fullchain.pem" "${LIVE_DIR}/privkey.pem" > "${BUNDLE_FILE}"
    chmod 600 "${BUNDLE_FILE}"
    echo "✓ Let's Encrypt certificate successfully installed to ${BUNDLE_FILE}"
else
    echo "ERROR: Unsupported mode: ${MODE}" >&2
    exit 1
fi

echo ""
echo "=== Certificate Verification Details ==="
openssl x509 -in "${BUNDLE_FILE}" -noout -subject -issuer -dates -ext subjectAltName

echo ""
echo "✓ SSL/TLS Setup Completed Successfully!"
