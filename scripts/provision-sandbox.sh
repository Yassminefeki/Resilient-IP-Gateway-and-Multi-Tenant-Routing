#!/usr/bin/env bash
set -Eeuo pipefail

TEAM_NAME="${1:-${TEAM_NAME:-team-demo}}"
PORT="${PORT:-80}"
API_BASE_URL="${CONTROL_PLANE_BASE_URL:-http://127.0.0.1:8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

if [[ ! "$TEAM_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "TEAM_NAME must be a lowercase DNS label of 1-63 characters." >&2
  exit 2
fi
if [[ -n "$ADMIN_TOKEN" && ( ${#ADMIN_TOKEN} -lt 24 || "$ADMIN_TOKEN" == *[[:space:]]* ) ]]; then
  echo "ADMIN_TOKEN must be at least 24 characters and contain no whitespace." >&2
  exit 2
fi
if [[ -z "$ADMIN_TOKEN" && "${AUTH_DISABLED:-false}" != "true" ]]; then
  echo "ADMIN_TOKEN is required unless AUTH_DISABLED=true." >&2
  exit 2
fi

if [[ "$PORT" != "80" ]]; then
  echo "The provision API currently serves sandboxes on port 80; PORT must be 80." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "Required tool not found: curl" >&2
  exit 1
fi

PAYLOAD="$(TEAM_NAME="$TEAM_NAME" python3 -c 'import json, os; print(json.dumps({"team": os.environ["TEAM_NAME"]}))')"
AUTH_HEADER=()
if [[ -n "$ADMIN_TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${ADMIN_TOKEN}")
fi
echo "Requesting sandbox ${TEAM_NAME} through ${API_BASE_URL%/}/api/sandboxes/provision..."
curl --fail-with-body --silent --show-error \
  -X POST "${API_BASE_URL%/}/api/sandboxes/provision" \
  -H 'Content-Type: application/json' \
  "${AUTH_HEADER[@]}" \
  --data "$PAYLOAD"
printf '\n'
