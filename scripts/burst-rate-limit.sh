#!/usr/bin/env bash
# ==============================================================================
# FelCloud - HAProxy Rate Limiting Burst Test Tool
# ==============================================================================
# Sends concurrent HTTP requests to verify HAProxy 429 Too Many Requests response.
#
# Environment variables:
#   BASTION_IP        (Required) SSH jump host IP address.
#   SSH_KEY_PATH      (Optional) Path to SSH private key (default: ansible/.ssh/id_rsa_felcloud).
#   VIP_ADDRESS       (Optional) Gateway VIP address (default: 10.20.20.246).
#   ROUTING_DOMAIN    (Optional) Target routing base domain (default: sandbox.example.com).
#   TARGET_HOST       (Optional) Target hostname with Host header (default: live1.<ROUTING_DOMAIN>).
#   CONCURRENCY       (Optional) Number of concurrent requests to fire (default: 120).
#
# Usage:
#   BASTION_IP=203.0.113.10 ./scripts/burst-rate-limit.sh
# ==============================================================================
set -e

KEY_PATH="${SSH_KEY_PATH:-ansible/.ssh/id_rsa_felcloud}"
BASTION_IP="${BASTION_IP:?BASTION_IP environment variable must be set}"
VIP_IP="${VIP_ADDRESS:-10.20.20.246}"
ROUTING_DOMAIN="${ROUTING_DOMAIN:-sandbox.example.com}"
TARGET_HOST="${TARGET_HOST:-live1.${ROUTING_DOMAIN}}"
CONCURRENCY="${CONCURRENCY:-120}"

echo "==> Firing burst of ${CONCURRENCY} rapid requests from bastion to VIP ${VIP_IP} (${TARGET_HOST})..."
ssh -i "${KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "ansible@${BASTION_IP}" \
  "for i in {1..${CONCURRENCY}}; do curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: ${TARGET_HOST}' http://${VIP_IP}/ & done; wait" \
  | sort | uniq -c

echo "==> Burst complete. Check Observability -> HAProxy access logs for HTTP 429 lines."
