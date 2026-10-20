"""CLI and safety gates shared by individual benchmark entry points."""
import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
RAW = ROOT / "results" / "raw"
TESTS = {
    "t1": ("Provisioning latency", ["POST bench-t1-* sandbox provision", "poll Nova ACTIVE and IPAM lease", "poll each gateway route until HTTP 200", "DELETE each bench-t1-* sandbox in finally cleanup"]),
    "t2": ("Concurrent provisioning stress", ["probe three pre-existing sandboxes", "barrier-start bench-t2-* provisions at configured concurrency", "cross-check IPAM addresses against Neutron ports", "verify host routing returns each sandbox identity", "collect gateway CPU and memory", "teardown every bench-t2-* sandbox"]),
    "t3": ("Gateway failover", ["probe a bench- sandbox through the VIP", "STOP HAProxy or Keepalived on the configured primary gateway", "measure VIP/route recovery and failback", "START the stopped service in finally cleanup"]),
    "t4": ("IP recycling", ["create and delete bench-t4-* sandboxes", "measure IPAM release, Neutron port deletion, and address reuse", "reconcile pool state after cleanup"]),
    "t5": ("Lease expiry and teardown", ["create short-lease bench-t5-* sandboxes", "observe lease expiry and automated cleanup", "restart cleanup worker only on configured test control plane", "verify VM, port, IPAM, route, and DNS cleanup"]),
    "t6": ("Reload and rollback", ["probe bench- routes during config changes", "apply valid candidate config through test control plane", "submit invalid candidates and measure rollback", "verify last-known-good config hash", "restore initial config in finally cleanup"]),
    "t7": ("Network isolation", ["create bench-t7-a, bench-t7-b, bench-t7-c sandboxes", "test prohibited peer and management-plane paths", "verify permitted gateway-to-sandbox service path", "save security-group and host-rule evidence", "teardown every bench-t7-* sandbox"]),
}


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_gates():
    from bench.lib.config import load_config
    cfg = load_config(ROOT / "config.yaml")
    gates = cfg.get("safety_gates", {})
    errors = []
    hosts = gates.get("allowed_gateway_hosts", {})
    if not hosts.get("primary") or not hosts.get("standby"):
        errors.append("Set BENCH_PRIMARY_HOST and BENCH_STANDBY_HOST to the exact permitted gateway SSH destinations.")
    if hosts.get("primary") and hosts.get("primary") == hosts.get("standby"):
        errors.append("Primary and standby gateway destinations must be different.")
    if gates.get("resource_prefix") != "bench-" or gates.get("cleanup_name_prefix") != "bench-":
        errors.append("safety_gates resource_prefix and cleanup_name_prefix must both be exactly 'bench-'.")
    protected = set(gates.get("protected_names", []))
    if not {"team1", "team2"}.issubset(protected):
        errors.append("safety_gates.protected_names must include team1 and team2.")
    if not os.environ.get("ADMIN_TOKEN"):
        errors.append("Set ADMIN_TOKEN in the environment; its value is never printed or written to results.")
    if not cfg["openstack"].get("bastion_host"):
        errors.append("Set BENCH_BASTION_HOST to the SSH bastion host.")
    if not cfg["openstack"].get("ssh_key_path"):
        errors.append("Set SSH_KEY_PATH to the private key used for gateway SSH.")
    if not cfg["openstack"].get("sandbox_flavor"):
        errors.append("Set BENCH_SANDBOX_FLAVOR for quota headroom checks.")
    if not cfg["network"].get("public_vip"):
        errors.append("Set PUBLIC_VIP_IP to the test gateway VIP used for Host-header polling.")
    if not cfg["network"].get("domain"):
        errors.append("Set ROUTING_DOMAIN for the provisioned sandbox hostname.")
    return cfg, errors


def dry_run(test_id, smoke):
    name, actions = TESTS[test_id]
    cfg, gate_errors = load_gates()
    iters = 1 if smoke else cfg["benchmark"].get(f"{test_id}_runs", "configured repetitions")
    print(f"DRY RUN: {test_id.upper()} — {name}")
    print(f"Iterations: {iters} (smoke={str(smoke).lower()})")
    print("No network, API, SSH, or OpenStack command will be issued.")
    print("Planned actions:")
    for i, action in enumerate(actions, 1):
        if test_id == "t3":
            host = cfg.get("safety_gates", {}).get("allowed_gateway_hosts", {}).get("primary") or "<BENCH_PRIMARY_HOST unset>"
            action = action.replace("configured primary gateway", f"configured primary gateway {host}")
        print(f"  {i}. {action}")
    print("Safety gates:")
    print("  resource name prefix: bench-")
    print("  protected cleanup names: team1, team2")
    print(f"  allowed primary gateway: {cfg.get('safety_gates', {}).get('allowed_gateway_hosts', {}).get('primary') or '<unset>'}")
    print(f"  allowed standby gateway: {cfg.get('safety_gates', {}).get('allowed_gateway_hosts', {}).get('standby') or '<unset>'}")
    if gate_errors:
        print("  MISSING GATES (execution will fail closed):")
        for item in gate_errors:
            print(f"    - {item}")
    return 0


def save_not_executed(test_id, reasons):
    RAW.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    row = {"timestamp_utc": timestamp(), "test": test_id, "status": "NOT EXECUTED", "reason": "; ".join(reasons), "sample_n": 0}
    path = RAW / f"{test_id}_{stamp}.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    (RAW / f"{test_id}_{stamp}_summary.json").write_text(json.dumps({**row, "reasons": reasons}, indent=2) + "\n", encoding="utf-8")
    print(f"{test_id.upper()}: NOT EXECUTED")
    for reason in reasons:
        print(f"  - {reason}")


def main(test_id=None):
    if test_id is None:
        test_id = sys.argv[1]
        argv = sys.argv[2:]
    else:
        argv = sys.argv[1:]
    if test_id not in TESTS:
        raise SystemExit(f"Unknown test id: {test_id}")
    parser = argparse.ArgumentParser(description=TESTS[test_id][0])
    parser.add_argument("--smoke", action="store_true", help="limit this test to one iteration and bench- resources")
    parser.add_argument("--dry-run", action="store_true", help="print planned actions without network or system calls")
    args = parser.parse_args(argv)
    if args.dry_run:
        return dry_run(test_id, args.smoke)

    cfg, errors = load_gates()
    if errors:
        save_not_executed(test_id, ["Safety gates are incomplete. No test actions were attempted.", *errors])
        return 2
    if test_id == "t1":
        import asyncio
        from bench.lib.t1 import run_t1
        summary = asyncio.run(run_t1(cfg, smoke=args.smoke))
        return 0 if summary.get("status") == "EXECUTED" else 2
    save_not_executed(test_id, ["Scenario runner is not implemented yet; no live test was attempted.",
                                "Only T1 has been implemented. Run the remaining test after its scenario is implemented."])
    return 2
