#!/usr/bin/env python3
"""Measure sandbox network isolation from a directly-created probe VM."""
import argparse
import asyncio
import csv
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bench.lib.api_client import AsyncControlPlaneClient
from bench.lib.config import load_config
from bench.tests import t2_concurrent_stress as t2
from bench.tests import t5_lease_expiry as t5

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "results" / "raw"
CHARTS = BASE / "results" / "charts"
CONTROL_PLANE = "http://127.0.0.1:8081"
IMAGE = "Ubuntu 24.04 LTS - Noble Numbat"
FLAVOR = "G0.basic.1c1g"
DEFAULT_NETWORK_ID = "7d1b48ee-0b28-449b-aba4-869364e72623"
DEFAULT_NETWORK_NAME = "felcloud-sandbox"
DEFAULT_KEYPAIR = "felcloud-resilient-v2"
SECURITY_GROUP = "sg-sandbox"
RESULT_DEADLINE_SECONDS = 300
RESULT_POLL_INTERVAL_SECONDS = 5
CONNECT_TIMEOUT_SECONDS = 3
MAX_SCRIPT_SECONDS = 110
SETTINGS = ("MAX_CONCURRENT_PROVISIONS", "HEALTH_REGRESSION_WINDOW_SECONDS",
            "GATEWAY_PROBE_TIMEOUT_SECONDS", "RATE_LIMIT_PER_MIN", "PROVISION_TIMEOUT_SECONDS")
BASE_PROBES = [
    ("gw1", "10.20.30.86", port, "gateway_sandbox") for port in (22, 80, 443, 5555)
]+[
    ("gw2", "10.20.30.224", port, "gateway_sandbox") for port in (22, 80, 443, 5555)
]+[
    ("team1", "10.20.30.37", port, "permanent_sandbox") for port in (22, 80, 8080)
]+[
    ("team2", "10.20.30.15", port, "permanent_sandbox") for port in (22, 80, 8080)
]+[
    ("bastion_edge", "10.20.20.177", 22, "management"),
    ("bastion_mgmt", "10.20.10.246", 22, "management"),
    ("metadata", "169.254.169.254", 80, "metadata"),
    ("gw1_mgmt", "10.20.10.24", 22, "gateway_management"),
    ("gw1_mgmt", "10.20.10.24", 5555, "gateway_management"),
    ("gw2_mgmt", "10.20.10.164", 22, "gateway_management"),
    ("gw2_mgmt", "10.20.10.164", 5555, "gateway_management"),
]


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def process_settings():
    return {key: os.environ.get(key, "unset") for key in SETTINGS}


def classify_probe(target, port, kind):
    if kind == "metadata":
        return "record_only"
    if kind == "gateway_sandbox" and port in (80, 443):
        return "allowed"
    return "forbidden"


def full_probes(target_b_ip):
    return BASE_PROBES[:8] + [("sandbox_b", target_b_ip, port, "peer_sandbox") for port in (22, 80, 8080)] + BASE_PROBES[8:]


def smoke_probes():
    return BASE_PROBES[:8]


def target_userdata():
    script = """#cloud-config
write_files:
  - path: /etc/systemd/system/t7-target-http.service
    content: |
      [Unit]
      Description=T7 target HTTP listener
      After=network.target
      [Service]
      ExecStart=/usr/bin/python3 -m http.server 80 --directory /var/www/t7-target
      Restart=always
      [Install]
      WantedBy=multi-user.target
runcmd:
  - [mkdir, -p, /var/www/t7-target]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, t7-target-http.service]
"""
    return script


def prober_shell_script(probes, result_path="/var/www/t7/result.json"):
    rows = []
    for name, address, port, kind in probes:
        address = address if address.startswith("<") else str(ipaddress.ip_address(address))
        classification = classify_probe(name, port, kind)
        rows.append(f"{name}|{address}|{port}|{classification}")
    body = f"""#!/usr/bin/env bash
set +e
started=$SECONDS
mkdir -p "$(dirname {result_path})"
results=""
separator=""
while IFS='|' read -r target address port classification; do
  if [ -z "$target" ]; then continue; fi
  if [ "$((SECONDS-started))" -ge {MAX_SCRIPT_SECONDS} ]; then
    result="timeout"
  else
    timeout {CONNECT_TIMEOUT_SECONDS} bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$address" "$port" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then result="open"
    elif [ "$rc" -eq 124 ]; then result="timeout"
    else result="refused"
    fi
  fi
  printf -v item '{{"target":"%s","ip":"%s","port":%s,"result":"%s","classification":"%s"}}' \\
    "$target" "$address" "$port" "$result" "$classification"
  results="${{results}}${{separator}}${{item}}"
  separator="," 
done <<'T7_PROBES'
""" + "\n".join(rows) + "\nT7_PROBES\n" + f"""printf -v json '{{\"results\":[%s],\"duration_seconds\":%s}}' "$results" "$((SECONDS-started))"
result_tmp="{result_path}.tmp.$$"
printf '%s\\n' "$json" > "$result_tmp" && mv -f "$result_tmp" "{result_path}"
"""
    return body


def prober_userdata(probes):
    body = prober_shell_script(probes)
    indented = "\n".join("      " + line if line else "" for line in body.rstrip("\n").splitlines())
    return ("#cloud-config\nwrite_files:\n"
            "  - path: /etc/systemd/system/t7-prober-http.service\n"
            "    content: |\n"
            "      [Unit]\n"
            "      Description=T7 result HTTP transport\n"
            "      After=network-online.target\n"
            "      Wants=network-online.target\n"
            "      [Service]\n"
            "      ExecStart=/usr/bin/python3 -m http.server 80 --directory /var/www/t7\n"
            "      Restart=always\n"
            "      [Install]\n"
            "      WantedBy=multi-user.target\n"
            "  - path: /usr/local/bin/t7-probe.sh\n"
            "    permissions: '0755'\n    content: |\n" + indented +
            "\nruncmd:\n  - [mkdir, -p, /var/www/t7]\n"
            "  - [systemctl, daemon-reload]\n"
            "  - [systemctl, enable, --now, t7-prober-http.service]\n"
            "  - [bash, /usr/local/bin/t7-probe.sh]\n")


def dry_run_self_test():
    closed_ports = (1, 2)
    probes = [(f"loopback_closed_{index}", "127.0.0.1", port, "peer_sandbox")
              for index, port in enumerate(closed_ports, 1)]
    with tempfile.TemporaryDirectory(prefix="t7-dry-run-") as temp_dir:
        script_path = Path(temp_dir) / "prober.sh"
        result_path = Path(temp_dir) / "result.json"
        script = prober_shell_script(probes, str(result_path))
        script_path.write_text(script, encoding="utf-8")
        syntax = subprocess.run(["bash", "-n", str(script_path)], capture_output=True, text=True, timeout=10)
        if syntax.returncode:
            raise RuntimeError(f"bash -n failed: {(syntax.stderr or syntax.stdout).strip()}")
        execution = subprocess.run(["bash", str(script_path)], capture_output=True, text=True, timeout=20)
        if execution.returncode:
            raise RuntimeError(f"offline prober failed ({execution.returncode}): {execution.stderr.strip()}")
        parsed = json.loads(result_path.read_text(encoding="utf-8"))
        if len(parsed.get("results", [])) != 2:
            raise RuntimeError("offline prober JSON did not contain two loopback results")
        return {"passed": True, "bash_n": {"passed": True, "returncode": syntax.returncode,
                "stderr": syntax.stderr.strip()}, "parsed_result": parsed}


async def run_preflight(cfg, api, db_path):
    observation = await t5.preflight(cfg, api, db_path)
    rules, errors = {}, {}
    for group in ("sg-sandbox", "sg-gateway"):
        try:
            rules[group] = await t2.openstack_json(cfg["openstack"]["cloud"], "security", "group", "rule", "list", group)
        except Exception as exc:
            errors[group] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
    observation["security_group_rules"] = rules
    observation["security_group_rule_errors"] = errors
    observation["security_group_rules_read"] = set(rules) == {"sg-sandbox", "sg-gateway"}
    observation["passed"] = bool(observation.get("passed")) and observation["security_group_rules_read"]
    return observation


async def openstack_text(cloud, *args):
    cmd = ["openstack", "--os-cloud", cloud, *args]
    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode:
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"{' '.join(cmd)} failed: {detail}")
    return proc.stdout


def get_fixed_ip(port):
    fixed = port.get("fixed_ips", port.get("Fixed IP Addresses", []))
    if isinstance(fixed, list):
        for entry in fixed:
            if isinstance(entry, dict) and entry.get("ip_address"):
                return str(ipaddress.ip_address(entry["ip_address"]))
            match = re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", str(entry))
            if match:
                return str(ipaddress.ip_address(match.group(0)))
    match = re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", str(fixed))
    if match:
        return str(ipaddress.ip_address(match.group(0)))
    raise RuntimeError(f"Neutron port {port.get('name', port.get('Name', ''))} has no fixed IP in response: {fixed}")


async def create_port(cloud, name, network, sg_id):
    port = await t2.openstack_json(cloud, "port", "create", "--network", network,
                                   "--security-group", sg_id, name)
    actual_name = str(port.get("name", port.get("Name", "")))
    if actual_name != name:
        raise RuntimeError(f"created port name mismatch: expected {name}, got {actual_name!r}")
    return {"id": str(port.get("id", port.get("ID", ""))), "name": actual_name,
            "fixed_ip": get_fixed_ip(port),
            "security_group_ids": port.get("security_group_ids", port.get("Security Groups", [])),
            "raw": port}


async def verify_port_security_group(cloud, port, expected_id):
    values = port.get("security_group_ids", port.get("Security Groups", []))
    if isinstance(values, str):
        values = re.findall(r"[0-9a-fA-F-]{36}", values) or ([SECURITY_GROUP] if SECURITY_GROUP in values else [])
    if not values:
        observed = await t2.openstack_json(cloud, "port", "show", port["id"])
        values = observed.get("security_group_ids", observed.get("Security Groups", []))
        if isinstance(values, str):
            values = re.findall(r"[0-9a-fA-F-]{36}", values) or ([SECURITY_GROUP] if SECURITY_GROUP in values else [])
    normalized = {str(item.get("id", item.get("name", ""))) if isinstance(item, dict) else str(item)
                  for item in values}
    if normalized not in ({expected_id}, {SECURITY_GROUP}):
        raise RuntimeError(f"port {port['name']} must have only {SECURITY_GROUP}; found {sorted(normalized)}")
    return sorted(normalized)


async def create_server(cloud, name, port_id, userdata, keypair):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".yaml", delete=False) as handle:
        handle.write(userdata)
        user_data_path = handle.name
    try:
        server = await t2.openstack_json(cloud, "server", "create", "--image", IMAGE,
            "--flavor", FLAVOR, "--port", port_id, "--key-name", keypair,
            "--user-data", user_data_path, name)
    finally:
        Path(user_data_path).unlink(missing_ok=True)
    actual_name = str(server.get("name", server.get("Name", "")))
    if actual_name != name:
        raise RuntimeError(f"created server name mismatch: expected {name}, got {actual_name!r}")
    return {"id": str(server.get("id", server.get("ID", ""))), "name": actual_name, "raw": server}


async def create_probe_vm(cfg, name, port_name, userdata, resources):
    cloud = cfg["openstack"]["cloud"]
    network_id = os.environ.get("SANDBOX_NETWORK_ID", "").strip() or DEFAULT_NETWORK_ID
    sg = await t2.openstack_json(cloud, "security", "group", "show", SECURITY_GROUP)
    sg_id = str(sg.get("id", sg.get("ID", "")))
    if not sg_id or sg.get("name", sg.get("Name")) != SECURITY_GROUP:
        raise RuntimeError(f"could not resolve exact security group {SECURITY_GROUP!r}")
    port = await create_port(cloud, port_name, network_id, sg_id)
    if not port["id"]:
        raise RuntimeError(f"Neutron did not return an ID for port {port_name}")
    resources.append({"kind": "port", "id": port["id"], "name": port["name"], "created_by_this_run": True})
    port["security_group_ids"] = await verify_port_security_group(cloud, port, sg_id)
    server = await create_server(cloud, name, port["id"], userdata,
        os.environ.get("SANDBOX_KEYPAIR", "").strip() or DEFAULT_KEYPAIR)
    resources.append({"kind": "server", "id": server["id"], "name": server["name"], "created_by_this_run": True})
    return {"server": server, "port": port}


async def read_http_result(cfg, prober_ip):
    deadline = time.monotonic() + RESULT_DEADLINE_SECONDS
    last_curl_result = ""
    last_http_code = None
    gateway = cfg["safety_gates"]["allowed_gateway_hosts"]["primary"]
    url = f"http://{ipaddress.ip_address(prober_ip)}/result.json"
    while time.monotonic() < deadline:
        try:
            last_curl_result = await t2.ssh_remote(cfg, gateway,
                f"curl -s -m 5 -o - -w '\\n%{{http_code}}' {url}")
            body, separator, code = last_curl_result.rstrip("\n").rpartition("\n")
            last_http_code = code if separator and code.isdigit() else None
            if last_http_code == "200":
                parsed = json.loads(body)
                return {"status": "READ", "result": parsed, "last_curl_result": last_curl_result,
                        "last_http_code": last_http_code}
        except Exception as exc:
            last_curl_result = f"{type(exc).__name__}: {exc}"
            last_http_code = None
        await asyncio.sleep(RESULT_POLL_INTERVAL_SECONDS)
    return {"status": "NOT EXECUTED", "error": "HTTP result.json did not return valid JSON with HTTP 200 within 300 seconds",
            "last_curl_result": last_curl_result, "last_http_code": last_http_code}


def readonly_ipam_counts(db_path, ids):
    with t5.readonly_db(db_path) as db:
        marks = ",".join("?" for _ in ids)
        ipam = db.execute(f"SELECT COUNT(*) FROM ip_allocations WHERE entity_name IN ({marks})", tuple(ids)).fetchone()[0]
        sandbox = db.execute(f"SELECT COUNT(*) FROM sandboxes WHERE sandbox_id IN ({marks})", tuple(ids)).fetchone()[0]
    return {"ip_allocations_rows": int(ipam), "sandbox_rows": int(sandbox),
            "no_ipam_rows_exist": ipam == 0 and sandbox == 0}


async def cleanup_resources(cfg, resources, expected_names):
    result = {"status": "COMPLETED", "deleted_servers": [], "deleted_ports": [], "errors": []}
    if any(not str(item.get("name", "")).startswith("bench-t7-") or item.get("name") not in expected_names
           for item in resources):
        result["status"] = "ABORTED"
        result["error"] = "cleanup name guard rejected a resource not matching this run's exact bench-t7-* names"
        return result
    cloud = cfg["openstack"]["cloud"]
    servers = [item for item in reversed(resources) if item["kind"] == "server"]
    ports = [item for item in reversed(resources) if item["kind"] == "port"]
    deleted_server_names = set()
    for item in servers:
        if not item.get("id") or not item["name"].startswith("bench-t7-"):
            result["status"] = "ABORTED"
            result["errors"].append(f"refused server cleanup for invalid exact name {item.get('name')!r}")
            return result
        try:
            await openstack_text(cloud, "server", "delete", item["id"])
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                live = await t2.openstack_json(cloud, "server", "list")
                if not any(str(row.get("Name", "")) == item["name"] for row in live):
                    break
                await asyncio.sleep(2)
            else:
                raise RuntimeError("server still appears in OpenStack server list after 120 seconds")
            deleted_server_names.add(item["name"])
            result["deleted_servers"].append(item["name"])
        except Exception as exc:
            result["errors"].append(f"{item['name']}: {type(exc).__name__}: {exc}")
    for item in ports:
        if not item.get("id") or not item["name"].startswith("bench-t7-"):
            result["status"] = "ABORTED"
            result["errors"].append(f"refused port cleanup for invalid exact name {item.get('name')!r}")
            return result
        server_name = item["name"].removesuffix("-port")
        if server_name in {server["name"] for server in servers} and server_name not in deleted_server_names:
            result["errors"].append(f"skipped {item['name']}: matching server was not confirmed deleted")
            continue
        try:
            await openstack_text(cloud, "port", "delete", item["id"])
            result["deleted_ports"].append(item["name"])
        except Exception as exc:
            result["errors"].append(f"{item['name']}: {type(exc).__name__}: {exc}")
    if result["errors"]:
        result["status"] = "FAILED"
    return result


async def final_sanity(cfg):
    output = {}
    cloud = cfg["openstack"]["cloud"]
    servers = await t2.openstack_json(cloud, "server", "list")
    ports = await t2.openstack_json(cloud, "port", "list")
    configs, gateway_errors = await t5.gateway_configs()
    guard, baseline = t5.check_baseline(configs)
    output.update({"openstack_server_count": len(servers),
        "only_five_permanent_vms": len(servers) == 5 and not any(str(x.get("Name", "")).startswith("bench-") for x in servers),
        "bench_ports": [x for x in ports if str(x.get("Name", "")).startswith("bench-")],
        "no_bench_ports": not any(str(x.get("Name", "")).startswith("bench-") for x in ports),
        "gateway_baseline_guard": {"passed": guard, **baseline, "errors": gateway_errors}})
    public_vip = os.environ.get("PUBLIC_VIP_IP", "")
    domain = os.environ.get("ROUTING_DOMAIN", "cloudpulse.cstam.felcloud.tn")
    gate = t2.RateGate()
    async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
        team1 = await t2.probe(client, gate, f"http://{public_vip}", f"team1.{domain}")
    output["team1_probe"] = team1
    output["team1_returns_200"] = team1["status"] == 200
    for gateway, host in (("gw1", "primary"), ("gw2", "standby")):
        try:
            remote = cfg["safety_gates"]["allowed_gateway_hosts"][host]
            text = await t2.ssh_remote(cfg, remote,
                "sudo haproxy -c -f /etc/haproxy/haproxy.cfg && "
                "printf 'BASELINE_BACKENDS=' && grep -Ec '^backend (default_maintenance|team1_backend|team2_backend)$' /etc/haproxy/haproxy.cfg")
            match = re.search(r"BASELINE_BACKENDS=(\d+)", text)
            output.setdefault("gateway_validation", {})[gateway] = {
                "output": text.strip(), "haproxy_config_valid": "Configuration file is valid" in text,
                "baseline_backend_count": int(match.group(1)) if match else None,
                "three_baseline_backends": bool(match and int(match.group(1)) == 3)}
        except Exception as exc:
            output.setdefault("gateway_validation", {})[gateway] = {"status": "NOT EXECUTED",
                "error": t2.redact_process_error(f"{type(exc).__name__}: {exc}")}
    output["passed"] = (output["only_five_permanent_vms"] and output["no_bench_ports"] and guard and
        output["team1_returns_200"] and all(x.get("haproxy_config_valid") and x.get("three_baseline_backends")
            for x in output["gateway_validation"].values()))
    return output


async def execute(cfg, smoke):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = stamp.lower()
    ids = [f"bench-t7-{suffix}-a"] if smoke else [f"bench-t7-{suffix}-a", f"bench-t7-{suffix}-b"]
    expected_names = set(ids) | {f"{sid}-port" for sid in ids}
    result = {"test": "T7_network_isolation", "timestamp_utc": utc_now(),
        "status": "NOT EXECUTED", "mode": "smoke" if smoke else "full",
        "result_channel": "HTTP via gateway", "console_log_finding": "console log empty on this cloud",
        "probe_vms_created_directly": False,
        "creation_method": "direct OpenStack port and server create; provisioning API is not used",
        "probe_vm_names": ids, "probe_vm_specs": {"image": IMAGE, "flavor": FLAVOR,
            "network_id": os.environ.get("SANDBOX_NETWORK_ID", "").strip() or DEFAULT_NETWORK_ID,
            "network_name": os.environ.get("SANDBOX_NETWORK_NAME", "").strip() or DEFAULT_NETWORK_NAME,
            "security_group": SECURITY_GROUP, "keypair": os.environ.get("SANDBOX_KEYPAIR", "").strip() or DEFAULT_KEYPAIR},
        "process_environment": process_settings(), "preflight": {}, "port_records": [],
        "ipam_rows": {"no_ipam_rows_exist": None}, "probe_results": [],
        "forbidden_open_connections": [], "cleanup": {"status": "NOT EXECUTED"},
        "final_sanity": {"status": "NOT EXECUTED"}}
    resources = []
    db_path = None
    preflight_passed = False
    probes_complete = False
    cloud = cfg["openstack"]["cloud"]
    try:
        token = os.environ.get("ADMIN_TOKEN", "")
        if not token:
            raise RuntimeError("ADMIN_TOKEN is unset")
        if not os.environ.get("DPA_PASS", ""):
            raise RuntimeError("DPA_PASS is unset")
        if os.environ.get("ROUTING_DOMAIN") != "cloudpulse.cstam.felcloud.tn":
            raise RuntimeError("ROUTING_DOMAIN must be cloudpulse.cstam.felcloud.tn")
        if not os.environ.get("PUBLIC_VIP_IP", ""):
            raise RuntimeError("PUBLIC_VIP_IP is unset")
        if cfg.get("control_plane", {}).get("base_url", "").rstrip("/") != CONTROL_PLANE:
            raise RuntimeError(f"T7 requires control plane at {CONTROL_PLANE}")
        db_path = t2.resolve_live_db_path()
        result["live_db_path"] = db_path
        async with AsyncControlPlaneClient(CONTROL_PLANE, token, timeout=30) as api:
            code, health = await t2.api_json(api, "GET", "/health")
            if code != 200:
                raise RuntimeError(f"control plane /health returned HTTP {code}: {health}")
            result["preflight"] = await run_preflight(cfg, api, db_path)
        preflight_passed = bool(result["preflight"].get("passed"))
        if not preflight_passed:
            result["error"] = "T7 preflight failed; no probe VM was created"
        else:
            sg = await t2.openstack_json(cloud, "security", "group", "show", SECURITY_GROUP)
            sg_id = str(sg.get("id", sg.get("ID", "")))
            if not sg_id or sg.get("name", sg.get("Name")) != SECURITY_GROUP:
                raise RuntimeError(f"could not resolve exact security group {SECURITY_GROUP!r}")
            target_vm = None
            if not smoke:
                target_vm = await create_probe_vm(cfg, ids[1], f"{ids[1]}-port", target_userdata(), resources)
                result["port_records"].append(target_vm["port"])
            prober_port_name = f"{ids[0]}-port"
            # Create the prober port first so its fixed IP and attached SG are auditable.
            prober_port = await create_port(cloud, prober_port_name,
                os.environ.get("SANDBOX_NETWORK_ID", "").strip() or DEFAULT_NETWORK_ID, sg_id)
            if not prober_port["id"]:
                raise RuntimeError(f"Neutron did not return an ID for port {prober_port_name}")
            resources.append({"kind": "port", "id": prober_port["id"], "name": prober_port["name"], "created_by_this_run": True})
            prober_port["security_group_ids"] = await verify_port_security_group(cloud, prober_port, sg_id)
            result["port_records"].append(prober_port)
            probes = smoke_probes() if smoke else full_probes(target_vm["port"]["fixed_ip"])
            userdata = prober_userdata(probes)
            prober = await create_server(cloud, ids[0], prober_port["id"], userdata,
                os.environ.get("SANDBOX_KEYPAIR", "").strip() or DEFAULT_KEYPAIR)
            resources.append({"kind": "server", "id": prober["id"], "name": prober["name"], "created_by_this_run": True})
            result["probe_vms_created"] = [item["name"] for item in resources if item["kind"] == "server"]
            result["probe_vms_created_directly"] = set(result["probe_vms_created"]) == set(ids)
            result["user_data"] = {"prober": userdata, "target": None if smoke else target_userdata()}
            result["probe_vm_ids"] = {"prober": prober["id"],
                "target": target_vm["server"]["id"] if target_vm else None}
            result["probe_vm_ips"] = {"prober": prober_port["fixed_ip"],
                "target": target_vm["port"]["fixed_ip"] if target_vm else None}
            result["ipam_rows"] = readonly_ipam_counts(db_path, ids)
            http_result = await read_http_result(cfg, prober_port["fixed_ip"])
            result["http_result"] = http_result
            if http_result["status"] != "READ":
                result["status"] = "NOT EXECUTED"
                result["error"] = http_result["error"]
            else:
                parsed_results = http_result["result"].get("results", [])
                result["probe_results"] = parsed_results
                result["forbidden_open_connections"] = [item for item in parsed_results
                    if item.get("classification") == "forbidden" and item.get("result") == "open"]
                expected_count = 8 if smoke else 24
                probes_complete = len(parsed_results) == expected_count
                result["probe_result_count"] = len(parsed_results)
                result["probe_result_count_expected"] = expected_count
                result["team2_dead_web_server_note"] = "closed and filtered both appear as refused/timeout from this probe"
                result["status"] = ("PASSED" if probes_complete and not result["forbidden_open_connections"]
                                    else "FAILED" if probes_complete else "NOT EXECUTED")
                if not probes_complete:
                    result["error"] = f"probe result contained {len(parsed_results)} entries; expected {expected_count}"
    except Exception as exc:
        result["error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
        result["status"] = "FAILED" if resources else "NOT EXECUTED"
    finally:
        if resources:
            result["cleanup"] = await cleanup_resources(cfg, resources, expected_names)
        if db_path and preflight_passed:
            try:
                result["ipam_rows_after_cleanup"] = readonly_ipam_counts(db_path, ids)
            except Exception as exc:
                result["ipam_rows_after_cleanup"] = {"error": t2.redact_process_error(f"{type(exc).__name__}: {exc}")}
        if preflight_passed:
            try:
                final = await final_sanity(cfg)
                result["final_sanity"] = final
            except Exception as exc:
                result["final_sanity"] = {"status": "FAILED", "error": t2.redact_process_error(f"{type(exc).__name__}: {exc}")}
        if result["status"] == "PASSED" and (result.get("cleanup", {}).get("status") != "COMPLETED" or
                not result.get("ipam_rows", {}).get("no_ipam_rows_exist") or
                not result.get("ipam_rows_after_cleanup", {}).get("no_ipam_rows_exist") or
                not result.get("final_sanity", {}).get("passed")):
            result["status"] = "FAILED"
    rows = result.get("probe_results", [])
    return await write_results(result, rows, stamp)


async def write_results(result, rows, stamp):
    RAW.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    csv_path = RAW / f"t7_isolation_{stamp}.csv"
    if not rows:
        rows = [{"status": result.get("status", "NOT EXECUTED"), "reason": result.get("error", ""),
                 "result": "NOT EXECUTED", "classification": "not observed"}]
    fields = sorted({key for row in rows for key in row})
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
                             for key, value in row.items()})
    chart_path = CHARTS / f"t7_isolation_{stamp}.png"
    fig, axis = plt.subplots(figsize=(11, 6))
    if result.get("probe_results"):
        observations = result["probe_results"]
        labels = [f"{item.get('target')}:{item.get('port')}" for item in observations]
        colors = ["#d62728" if item.get("classification") == "forbidden" and item.get("result") == "open"
                  else "#2ca02c" if item.get("result") == "open" else "#7f7f7f" for item in observations]
        axis.bar(range(len(labels)), [1 if item.get("result") == "open" else 0 for item in observations], color=colors)
        axis.set_xticks(range(len(labels)), labels, rotation=70, ha="right")
        axis.set_ylabel("TCP connection open (1=yes)")
    else:
        axis.text(0.5, 0.55, result.get("status", "NOT EXECUTED"), ha="center", va="center",
                  fontsize=18, transform=axis.transAxes)
        axis.text(0.5, 0.38, result.get("error", ""), ha="center", va="center", wrap=True,
                  transform=axis.transAxes)
        axis.set_axis_off()
    axis.set_title("T7 network isolation: probe results")
    axis.grid(True, axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150)
    plt.close(fig)
    summary_path = RAW / f"t7_isolation_{stamp}_summary.json"
    result["artifacts"] = {"raw_csv": str(csv_path), "summary_json": str(summary_path), "chart": str(chart_path)}
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description="T7 network-isolation test")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(BASE / "config.yaml")
        smoke = args.smoke
        names = ["bench-t7-<timestamp>-a"] if smoke else ["bench-t7-<timestamp>-a", "bench-t7-<timestamp>-b"]
        probes = smoke_probes() if smoke else full_probes("<target-b-fixed-ip>")
        specs = {"image": IMAGE, "flavor": FLAVOR,
                 "network_id": os.environ.get("SANDBOX_NETWORK_ID", "").strip() or DEFAULT_NETWORK_ID,
                 "network_name": os.environ.get("SANDBOX_NETWORK_NAME", "").strip() or DEFAULT_NETWORK_NAME,
                 "security_group": SECURITY_GROUP, "keypair": os.environ.get("SANDBOX_KEYPAIR", "").strip() or DEFAULT_KEYPAIR,
                 "ports": [f"{name}-port" for name in names]}
        if args.dry_run:
            offline_self_test = dry_run_self_test()
            print(json.dumps({"test": "T7_network_isolation", "mode": "DRY RUN", "network_calls": False,
                "smoke": smoke, "status": "PLAN READY", "creation_method": "direct OpenStack CLI; no provisioning API",
                "result_channel": "HTTP via gateway", "console_log_finding": "console log empty on this cloud",
                "offline_self_test": offline_self_test,
                "vm_names": names, "vm_specs": specs, "prober_user_data": prober_userdata(probes),
                "target_user_data": None if smoke else target_userdata(),
                "planned_probe_count": len(probes),
                "planned_probes": [{"target": name, "ip": address, "port": port,
                    "classification": classify_probe(name, port, kind)} for name, address, port, kind in probes],
                "connect_timeout_seconds": CONNECT_TIMEOUT_SECONDS, "user_data_max_runtime_seconds": MAX_SCRIPT_SECONDS,
                "result_poll_interval_seconds": RESULT_POLL_INTERVAL_SECONDS,
                "result_deadline_seconds": RESULT_DEADLINE_SECONDS,
                "process_environment": process_settings(), "security_groups_to_record": ["sg-sandbox", "sg-gateway"],
                "cleanup_name_guard": "only exact VM/port names for this run beginning bench-t7-",
                "pass_condition": "zero forbidden connections open",
                "outputs": ["raw CSV", "summary JSON", "chart in bench/results"]}, indent=2))
            return 0
        result = asyncio.run(execute(cfg, smoke))
        print(json.dumps({"test": result["test"], "status": result["status"], "error": result.get("error"),
            "forbidden_open_connections": result.get("forbidden_open_connections"),
            "preflight": result.get("preflight"), "cleanup": result.get("cleanup"),
            "final_sanity": result.get("final_sanity"), "artifacts": result.get("artifacts")}, indent=2))
        return 0 if result["status"] == "PASSED" else 2
    except Exception as exc:
        print(f"T7 NOT EXECUTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
