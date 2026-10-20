#!/usr/bin/env python3
"""Read-only readiness checks; regenerates ENVIRONMENT.md from these calls."""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
sys.path.insert(0, str(REPO))
from bench.lib.config import load_config  # noqa: E402
from bench.lib.openstack_client import is_benchmark_resource  # noqa: E402


def run(args, timeout=20):
    try:
        p = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as exc:
        return 127, "", f"{type(exc).__name__}: {exc}"


def scrub(text):
    for key in ("ADMIN_TOKEN", "OS_PASSWORD", "OS_TOKEN", "OS_APPLICATION_CREDENTIAL_SECRET"):
        value = os.environ.get(key)
        if value:
            text = text.replace(value, "[REDACTED]")
    return re.sub(r"(?i)(password|secret|token)\s*[:=]\s*[^\s,;]+", r"\1=[REDACTED]", text)


def quota_rows(payload):
    try:
        data = json.loads(payload)
    except Exception:
        return {}
    if isinstance(data, dict):
        data = data.get("quotas", data.get("quota", data))
        if isinstance(data, dict):
            out = {}
            for key, value in data.items():
                if isinstance(value, dict):
                    out[str(key).lower()] = value
                else:
                    out[str(key).lower()] = {"limit": value, "in use": 0}
            return out
    out = {}
    if isinstance(data, list):
        for row in data:
            if isinstance(row, dict):
                name = row.get("Resource", row.get("resource", row.get("Name", row.get("name", ""))))
                if name:
                    out[str(name).lower()] = {str(k).lower(): v for k, v in row.items()}
    return out


def numbers(row):
    def val(*keys):
        for k in keys:
            v = row.get(k)
            try:
                return int(str(v).replace(",", ""))
            except (TypeError, ValueError):
                pass
        return None
    return val("limit", "value"), val("in use", "in_use", "used") or 0


def absolute_limit_values(payload):
    """Read Nova absolute-limit API fields from OpenStackClient JSON output."""
    try:
        data = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return {}
    fields = {
        "maxTotalInstances", "totalInstancesUsed",
        "maxTotalCores", "totalCoresUsed",
        "maxTotalRAMSize", "totalRAMUsed",
    }
    aliases = {
        "max_total_instances": "maxTotalInstances",
        "total_instances_used": "totalInstancesUsed",
        "max_total_cores": "maxTotalCores",
        "total_cores_used": "totalCoresUsed",
        "max_total_ram_size": "maxTotalRAMSize",
        "total_ram_used": "totalRAMUsed",
    }
    values = {}
    if isinstance(data, dict):
        for key, value in data.items():
            canonical = aliases.get(str(key), str(key))
            if canonical in fields:
                values[canonical] = value
        for key in ("absolute", "limits", "data"):
            nested = data.get(key)
            if isinstance(nested, dict):
                for nested_key, value in nested.items():
                    canonical = aliases.get(str(nested_key), str(nested_key))
                    if canonical in fields:
                        values[canonical] = value
    elif isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            name = row.get("Name", row.get("name", row.get("Property", row.get("property"))))
            canonical = aliases.get(str(name), str(name))
            if canonical in fields:
                values[canonical] = row.get("Value", row.get("value"))
    return values


def quota_check(label, limit_value, used_value, needed):
    def integer(value):
        try:
            return int(str(value).replace(",", ""))
        except (TypeError, ValueError):
            return None

    limit = integer(limit_value)
    used = integer(used_value)
    if limit is None or used is None:
        return f"{label}: UNKNOWN (unreadable limit or usage; needed={needed}, limit={limit_value}, used={used_value})", False
    available = limit - used
    passed = needed <= available
    return (f"{label}: {'PASS' if passed else 'FAIL'} "
            f"(needed={needed}, available={available}, limit={limit}, used={used})"), passed


def check_quota(label, data, resource, needed):
    row = data.get(resource.lower())
    if not row:
        return f"{label}: UNKNOWN (quota resource '{resource}' missing from response)", False
    limit, used = numbers(row)
    if limit is None:
        return f"{label}: UNKNOWN (could not parse limit for {resource})", False
    available = "unlimited" if limit < 0 else str(limit - used)
    ok = limit < 0 or limit - used >= needed
    return f"{label}: {'PASS' if ok else 'FAIL'} (needed {needed}, available {available}; used {used}, limit {limit})", ok


def markdown_table(rows):
    lines = ["| Check | Result |", "|---|---|"]
    for label, result in rows:
        safe_label = str(label).replace("|", "\\|").replace("\n", " ")
        safe_result = scrub(str(result)).replace("|", "\\|").replace("\n", "<br>")
        lines.append(f"| {safe_label} | {safe_result} |")
    return "\n".join(lines)


def main():
    cfg = load_config(ROOT / "config.yaml")
    results = []
    all_ok = True

    token_present = bool(os.environ.get("ADMIN_TOKEN"))
    results.append(("ADMIN_TOKEN present", "PASS (value not displayed)" if token_present else "FAIL (unset; value is never displayed)"))
    all_ok &= token_present

    url = cfg["control_plane"]["base_url"].rstrip("/") + "/health"
    try:
        import httpx
        response = httpx.get(url, timeout=5)
        health_ok = response.status_code == 200
        health_result = f"{'PASS' if health_ok else 'FAIL'} (HTTP {response.status_code})"
    except Exception as exc:
        health_ok = False
        health_result = f"FAIL ({type(exc).__name__}: {exc})"
    results.append((f"Control plane {url}", health_result))
    all_ok &= health_ok

    cloud = cfg["openstack"]["cloud"]
    rc, stdout, stderr = run(["openstack", "--os-cloud", cloud, "token", "issue", "-f", "json"])
    os_ok = rc == 0
    results.append((f"OpenStack token issue ({cloud})", "PASS" if os_ok else f"FAIL ({scrub(stderr or stdout or f'exit={rc}')})"))
    all_ok &= os_ok

    ssh_cfg = cfg["openstack"]
    gates = cfg["safety_gates"]
    user, bastion, key = ssh_cfg.get("ssh_user", ""), ssh_cfg.get("bastion_host", ""), ssh_cfg.get("ssh_key_path", "")
    ssh_ok = bool(user and bastion and key and gates["allowed_gateway_hosts"].get("primary") and gates["allowed_gateway_hosts"].get("standby"))
    gateway_outputs = {}
    if ssh_ok:
        for role in ("primary", "standby"):
            host = gates["allowed_gateway_hosts"][role]
            command = ["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=30",
                       "-o", "StrictHostKeyChecking=accept-new", "-J", f"{user}@{bastion}",
                       f"{user}@{host}", "printf 'SSH_OK\\n'; haproxy -v 2>&1 | head -1; keepalived --version 2>&1 | head -1; nproc; free -b"]
            role_ok = False
            for attempt in range(1, 5):  # initial attempt plus up to three retries
                rc, out, err = run(command, timeout=40)
                passed = rc == 0 and out.startswith("SSH_OK")
                results.append((f"SSH via bastion to {role} gateway {host}, attempt {attempt}/4",
                                "PASS" if passed else f"FAIL ({scrub(err or out or f'exit={rc}')})"))
                if passed:
                    role_ok = True
                    gateway_outputs[role] = out
                    break
            all_ok &= role_ok
    else:
        results.append(("SSH to both gateways", "FAIL (set BENCH_SSH_USER, BENCH_BASTION_HOST, SSH_KEY_PATH, BENCH_PRIMARY_HOST, BENCH_STANDBY_HOST)"))
        all_ok = False

    planned = int(cfg["benchmark"]["planned_concurrency"])
    results.append(("Planned max concurrency", f"{planned} sandboxes (needed={planned})"))
    flavor = ssh_cfg.get("sandbox_flavor", "")
    vcpus = ram_mb = 0
    if flavor:
        rc_f, out_f, err_f = run(["openstack", "--os-cloud", cloud, "flavor", "show", flavor, "-f", "json"])
        try:
            flavor_data = json.loads(out_f) if rc_f == 0 else {}
            vcpus, ram_mb = int(flavor_data.get("vcpus", 0)), int(flavor_data.get("ram", 0))
            if vcpus <= 0 or ram_mb <= 0:
                raise ValueError("vcpus/ram missing or not positive")
            results.append((f"Sandbox flavor {flavor}", f"PASS (vCPUs={vcpus}, RAM={ram_mb} MB)"))
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            results.append((f"Sandbox flavor {flavor}", f"FAIL ({scrub(err_f or str(exc))})"))
            all_ok = False
    else:
        results.append(("Sandbox flavor", "FAIL (set BENCH_SANDBOX_FLAVOR; vCPU/RAM are read from OpenStack)"))
        all_ok = False
    rc_c, out_c, err_c = run(["openstack", "--os-cloud", cloud, "limits", "show", "--absolute", "-f", "json"])
    rc_n, out_n, err_n = run(["openstack", "--os-cloud", cloud, "quota", "show", "--network", "-f", "json"])
    nova_limits = absolute_limit_values(out_c) if rc_c == 0 else {}
    network = quota_rows(out_n) if rc_n == 0 else {}
    if rc_c == 0:
        raw_usage = ", ".join(f"{raw_key}={nova_limits.get(key, 'MISSING')}" for raw_key, key in (
            ("total_instances_used", "totalInstancesUsed"),
            ("total_cores_used", "totalCoresUsed"),
            ("total_ram_used", "totalRAMUsed")))
        results.append(("Nova limits API raw usage", raw_usage))
    quota_checks = []
    if rc_c == 0:
        nova_quota_checks = (
            ("Nova instances", "maxTotalInstances", "totalInstancesUsed", planned),
            ("Nova vCPU cores", "maxTotalCores", "totalCoresUsed", planned * vcpus),
            ("Nova RAM MB", "maxTotalRAMSize", "totalRAMUsed", planned * ram_mb),
        )
        for label, limit_key, used_key, needed in nova_quota_checks:
            message, passed = quota_check(label, nova_limits.get(limit_key), nova_limits.get(used_key), needed)
            quota_checks.append(message)
            results.append((f"Quota headroom: {label}", message))
            all_ok &= passed
    else:
        results.append(("Nova limits API query", f"FAIL ({scrub(err_c or out_c)})"))
        all_ok = False
        for label in ("Nova instances", "Nova vCPU cores", "Nova RAM MB"):
            quota_checks.append(f"{label}: NOT AVAILABLE (Nova limits API query failed)")
    message, passed = check_quota("Neutron ports", network, "ports", planned)
    quota_checks.append(message)
    results.append(("Quota headroom: Neutron ports", message))
    all_ok &= passed
    if rc_n != 0:
        results.append(("Neutron quota query", f"FAIL ({scrub(err_n or out_n)})")); all_ok = False

    # Validate the same exact allow-list logic cleanup must use.
    prefix = gates.get("cleanup_name_prefix", "")
    protected = set(gates.get("protected_names", []))
    hosts = gates.get("allowed_gateway_hosts", {})
    gate_issues = []
    if not hosts.get("primary") or not hosts.get("standby") or hosts.get("primary") == hosts.get("standby"):
        gate_issues.append("configure distinct BENCH_PRIMARY_HOST and BENCH_STANDBY_HOST")
    if not ssh_cfg.get("bastion_host") or not ssh_cfg.get("ssh_key_path"):
        gate_issues.append("configure BENCH_BASTION_HOST and SSH_KEY_PATH")
    if not ssh_cfg.get("sandbox_flavor"):
        gate_issues.append("configure BENCH_SANDBOX_FLAVOR")
    safe_filter_ok = (prefix == "bench-" and gates.get("resource_prefix") == "bench-"
                      and {"team1", "team2"}.issubset(protected)
                      and not is_benchmark_resource("team1", prefix, protected)
                      and not is_benchmark_resource("team2", prefix, protected))
    if gate_issues:
        results.append(("Mandatory safety gate configuration", "FAIL (" + "; ".join(gate_issues) + ")"))
        all_ok = False
    results.append(("Cleanup filter excludes team1/team2", "PASS" if safe_filter_ok else "FAIL (prefix/protected-name gate mismatch)"))
    all_ok &= safe_filter_ok

    commit_rc, commit, _ = run(["git", "-C", str(REPO), "rev-parse", "HEAD"])
    commit = commit if commit_rc == 0 else "unknown"
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    environment = ["# Benchmark environment (generated by `python3 bench/preflight.py`)", "",
        f"Generated UTC: `{now}`", f"Git commit: `{commit}`", "",
        "This file is overwritten by each preflight run. Values below come only from the checks performed in that run; no values are carried forward from earlier discovery.", "",
        "## Preflight results", "", markdown_table(results), "",
        "## Gateway observations from SSH calls", ""]
    if gateway_outputs:
        for role, output in gateway_outputs.items():
            environment += [f"### {role}", "", "```text", scrub(output), "```", ""]
    else:
        environment += ["No gateway SSH observations were collected.", ""]
    environment += ["## Quota checks", "", *[f"- {line}" for line in quota_checks], ""]
    (ROOT / "ENVIRONMENT.md").write_text("\n".join(environment), encoding="utf-8")

    print("Benchmark preflight:")
    for label, result in results:
        level = "INFO" if label == "Planned max concurrency" else ("PASS" if "PASS" in result else "FAIL")
        print(f"[{level}] {label}: {result}")
    print(f"ENVIRONMENT.md regenerated from this preflight run: {ROOT / 'ENVIRONMENT.md'}")
    if not all_ok:
        print("Preflight failed. Resolve the FAIL checks before running tests.")
        return 2
    print("Preflight passed. This command performed read-only checks only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
