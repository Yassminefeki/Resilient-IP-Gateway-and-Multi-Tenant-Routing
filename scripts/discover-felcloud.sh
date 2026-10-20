#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${DISCOVERY_OUTPUT_DIR:-$ROOT_DIR/output}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/felcloud-discovery-${STAMP}.txt"

if ! command -v openstack >/dev/null 2>&1; then
  echo "openstack CLI is required but was not found in PATH." >&2
  exit 1
fi

if ! openstack --help >/dev/null 2>&1; then
  echo "The OpenStack CLI is installed but failed to initialize; check your cloud environment." >&2
  exit 1
fi

{
  echo "# FelCloud discovery snapshot"
  echo "# Generated: $(date -u)"
  echo
  echo "## openstack server list"
  openstack server list -f table || true
  echo
  echo "## openstack subnet list"
  openstack subnet list -f table || true
  echo
  echo "## openstack router list"
  openstack router list -f table || true
  echo
  echo "## openstack port list --network felcloud-edge"
  openstack port list --network felcloud-edge -f table || true
  echo
  echo "## openstack port list --network felcloud-sandbox"
  openstack port list --network felcloud-sandbox -f table || true
  echo
  echo "## openstack port list --network felcloud-mgmt"
  openstack port list --network felcloud-mgmt -f table || true
  echo
  echo "## openstack security group list"
  openstack security group list -f table || true
  echo
  echo "## openstack floating ip list"
  openstack floating ip list -f table || true
  echo
  echo "## openstack network list"
  openstack network list -f table || true
} > "$OUT_FILE"

echo "Discovery snapshot written to: $OUT_FILE"
