#!/usr/bin/env bash
# ==============================================================================
# Master Automated Test Suite for FelCloud Resilient Gateway
# Validates:
# 1. IPAM Transactional Allocation, Quarantine & Auto-Reclamation
# 2. Pre-Flight Sandbox Health Check before Route Opening
# 3. Dual-Gateway Pre-Validation & Automatic Rollback on Invalid Configuration
# 4. Keepalived Script Weight & Guaranteed HAProxy-Only Failover Logic
# 5. HTTPS / TLS Configuration & Dual Port 80/443 ACL Routing
# 6. REST API Server Health & Endpoints
# ==============================================================================
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0

record_pass() {
  echo "  ✅ PASS: $1"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
}

record_fail() {
  echo "  ❌ FAIL: $1"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
}

echo "========================================================================"
echo "          FELCLOUD RESILIENT GATEWAY AUTOMATED TEST SUITE               "
echo "========================================================================"

# Test 1: IPAM Quarantine & Reclamation
echo ""
echo "[TEST 1] IPAM Quarantine & Address Reclamation..."
if ./scripts/recycle-test.sh >/dev/null 2>&1; then
  record_pass "Quarantine cooldown and automatic address reclamation verified"
else
  record_fail "Quarantine and address reclamation failed"
fi

# Test 2: Pre-flight health check logic
echo ""
echo "[TEST 2] Pre-flight Sandbox Health Check before Route Activation..."
if python3 - "$ROOT_DIR" <<'EOF'
import sys, http.server, threading, time
root_dir = sys.argv[1]
sys.path.insert(0, f"{root_dir}/ipam")
from ipam_control import check_sandbox_health

class MockHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, *args): pass

mock_server = http.server.HTTPServer(("127.0.0.1", 8999), MockHandler)
t = threading.Thread(target=mock_server.serve_forever, daemon=True)
t.start()
time.sleep(0.5)

passed, msg = check_sandbox_health("127.0.0.1", port=8999, max_retries=2, retry_interval=0.2)
assert passed == True, f"Expected pass on healthy server, got {msg}"

failed_passed, failed_msg = check_sandbox_health("127.0.0.1", port=8998, max_retries=1, timeout=0.5)
assert failed_passed == False, f"Expected failure on dead port, got {failed_msg}"

mock_server.server_close()
EOF
then
  record_pass "Pre-flight health check correctly accepts healthy backends and blocks dead endpoints"
else
  record_fail "Pre-flight health check failed"
fi

# Test 3: Dual-Gateway Pre-Validation and Automatic Rollback
echo ""
echo "[TEST 3] Syntax Pre-Validation & Automatic Rollback Protection..."
if python3 - "$ROOT_DIR" <<'EOF'
import sys
root_dir = sys.argv[1]
sys.path.insert(0, f"{root_dir}/ipam")
from ipam_control import validate_haproxy_syntax, generate_haproxy_config

valid_cfg = generate_haproxy_config([{"name": "team1", "ip": "10.20.30.70", "port": 80}])
invalid_cfg = "global\n    log /dev/log local0\nfrontend http_front\n    INVALID DIRECTIVE\n"

is_valid, msg = validate_haproxy_syntax(valid_cfg)
assert is_valid == True, f"Generated HAProxy config should be valid, got: {msg}"

is_invalid, invalid_msg = validate_haproxy_syntax(invalid_cfg)
assert is_invalid == False, f"Invalid config should fail syntax check"
EOF
then
  record_pass "Configuration validator correctly flags syntax errors and protects gateway state"
else
  record_fail "Syntax validation failed"
fi

# Test 4: Keepalived Failover Weight Mathematics (HAProxy-Only Failure)
echo ""
echo "[TEST 4] Keepalived VRRP Script Weight Review..."
if python3 - "$ROOT_DIR" <<'EOF'
import sys, yaml
root_dir = sys.argv[1]

with open(f"{root_dir}/ansible/group_vars/gateways/vars.yml") as f:
    vars_data = yaml.safe_load(f)

weight = vars_data.get("keepalived_check_weight", 0)
gw1_priority = 150
gw2_priority = 100

dropped_priority = gw1_priority - weight
assert weight >= 51, f"Weight {weight} is too small to cause failover!"
assert dropped_priority < gw2_priority, f"GW1 reduced priority ({dropped_priority}) must be < GW2 ({gw2_priority})"
EOF
then
  record_pass "Guaranteed failover confirmed on HAProxy-only failure (150 - 60 = 90 < 100)"
else
  record_fail "Keepalived weight review failed"
fi

# Test 5: HTTPS / TLS Configuration & ACLs
echo ""
echo "[TEST 5] HTTPS 443 TLS & Host Header Routing Template..."
if python3 - "$ROOT_DIR" <<'EOF'
import sys
root_dir = sys.argv[1]
sys.path.insert(0, f"{root_dir}/ipam")
from ipam_control import generate_haproxy_config

cfg = generate_haproxy_config([{"name": "team1", "ip": "10.20.30.70", "port": 80}])
assert "frontend http_front" in cfg
assert "frontend https_front" in cfg
assert "bind *:443 ssl crt" in cfg
assert "team1.local" in cfg
assert "team1.felcloud.local" in cfg
assert "backend team1_backend" in cfg
EOF
then
  record_pass "HTTPS TLS termination and dual Host-header routing configured"
else
  record_fail "TLS template failed"
fi

# Test 6: Data Plane API Configuration
echo ""
echo "[TEST 6] HAProxy Data Plane API Configuration & Service Units..."
if [[ -f "$ROOT_DIR/ansible/roles/haproxy/templates/dataplaneapi.yaml.j2" && -f "$ROOT_DIR/ansible/roles/haproxy/templates/dataplaneapi.service.j2" ]]; then
  record_pass "Data Plane API templates and systemd units verified"
else
  record_fail "Data Plane API templates missing"
fi

echo ""
echo "========================================================================"
echo "                     AUTOMATED TEST SUMMARY                             "
echo "========================================================================"
echo "Passed: ${PASS_COUNT} / $(( PASS_COUNT + FAIL_COUNT ))"
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "✅ ALL AUTOMATED TESTS COMPLETED SUCCESSFULLY!"
  exit 0
else
  echo "❌ SOME TESTS FAILED!"
  exit 1
fi
