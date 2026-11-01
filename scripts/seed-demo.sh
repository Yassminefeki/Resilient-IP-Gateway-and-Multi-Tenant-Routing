#!/usr/bin/env bash
# ==============================================================================
# FelCloud Demo Seed Script
# Idempotently provisions sample sandboxes and custom domain bindings.
# ==============================================================================
set -euo pipefail

BASE_URL="${CONTROL_PLANE_BASE_URL:-http://127.0.0.1:8081}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "[-] ERROR: ADMIN_TOKEN environment variable is required." >&2
  exit 1
fi

echo "[+] Target control plane: ${BASE_URL}"

# 1. Health check wait loop
echo "[+] Checking control plane health..."
max_retries=30
retry=0
until curl -s -f "${BASE_URL}/health" >/dev/null 2>&1; do
  retry=$((retry + 1))
  if [[ ${retry} -ge ${max_retries} ]]; then
    echo "[-] ERROR: Control plane at ${BASE_URL} not healthy after ${max_retries} attempts." >&2
    exit 1
  fi
  echo "    Waiting for control plane... (${retry}/${max_retries})"
  sleep 1
done
echo "[+] Control plane is healthy."

AUTH_HEADER="Authorization: Bearer ${ADMIN_TOKEN}"

# 2. Provision demo sandboxes
demo_sandboxes=("team-alpha" "team-beta" "team-gamma")

for sandbox in "${demo_sandboxes[@]}"; do
  echo "[+] Provisioning sandbox '${sandbox}'..."
  http_code=$(curl -s -o /tmp/seed_resp.json -w "%{http_code}" \
    -X POST "${BASE_URL}/api/sandboxes/provision" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER}" \
    -d "{\"name\":\"${sandbox}\",\"ttl_hours\":24}")

  if [[ "${http_code}" =~ ^(200|201|202)$ ]]; then
    echo "    Successfully provisioned '${sandbox}' (HTTP ${http_code})."
  elif [[ "${http_code}" == "409" ]]; then
    echo "    Sandbox '${sandbox}' already exists (HTTP 409, idempotent skip)."
  else
    echo "[-] WARNING: Unexpected status ${http_code} provisioning '${sandbox}':" >&2
    cat /tmp/seed_resp.json >&2
    echo "" >&2
  fi
  rm -f /tmp/seed_resp.json
done

# 3. Bind custom domain to team-alpha
echo "[+] Binding custom domain 'app.alpha.sandbox.example.com' to 'team-alpha'..."
domain_code=$(curl -s -o /tmp/seed_domain.json -w "%{http_code}" \
  -X POST "${BASE_URL}/api/sandboxes/custom-domain" \
  -H "Content-Type: application/json" \
  -H "${AUTH_HEADER}" \
  -d '{"sandbox_id":"team-alpha","custom_domain":"app.alpha.sandbox.example.com"}')

if [[ "${domain_code}" =~ ^(200|201)$ ]]; then
  echo "    Successfully bound custom domain (HTTP ${domain_code})."
elif [[ "${domain_code}" == "409" ]]; then
  echo "    Custom domain already bound (HTTP 409, idempotent skip)."
else
  echo "[-] WARNING: Unexpected status ${domain_code} binding custom domain:" >&2
  cat /tmp/seed_domain.json >&2
  echo "" >&2
fi
rm -f /tmp/seed_domain.json

echo "[+] Seeding complete!"
