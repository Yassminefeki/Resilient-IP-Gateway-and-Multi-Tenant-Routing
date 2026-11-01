#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
if [[ -x "bench/.venv/bin/python" ]]; then
  python=bench/.venv/bin/python
elif [[ -x ".venv/bin/python" ]]; then
  python=.venv/bin/python
else
  python=python3
fi

for arg in "$@"; do
  case "$arg" in
    --smoke|--dry-run) ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Ordered as requested; each test records preflight failures without mutations.
status=0
for test in \
  bench/tests/t1_provisioning_latency.py \
  bench/tests/t2_concurrent_stress.py \
  bench/tests/t4_ip_recycling.py \
  bench/tests/t5_lease_expiry_teardown.py \
  bench/tests/t6_reload_rollback.py \
  bench/tests/t7_isolation_security.py \
  bench/tests/t3_gateway_failover.py; do
  "$python" "$test" "$@" || status=1
done

if [[ " $* " != *" --dry-run "* ]]; then
  "$python" bench/report/generate_report.py
fi
exit "$status"
