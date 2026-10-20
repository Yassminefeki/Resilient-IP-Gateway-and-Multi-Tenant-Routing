#!/usr/bin/env python3
"""Measure gateway sync, raw-config validation, and explicit rollback behavior."""
import argparse
import asyncio
import csv
import json
import os
import re
import sqlite3
import sys
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
BASELINE_BACKENDS = {"default_maintenance", "team1_backend", "team2_backend"}
GATEWAYS = {"gw1": "127.0.0.11", "gw2": "127.0.0.12"}
PROBE_INTERVAL_SECONDS = 0.2
SETTINGS = {
    "HEALTH_REGRESSION_WINDOW_SECONDS": "5",
    "GATEWAY_PROBE_TIMEOUT_SECONDS": "30",
    "RATE_LIMIT_PER_MIN": "120",
    "MAX_CONCURRENT_PROVISIONS": "15",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def readonly_db(path):
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def safe_generation(db_path):
    with readonly_db(db_path) as db:
        rows = db.execute("SELECT generation_id, config_snapshot FROM config_generations "
                          "WHERE status='COMMITTED' ORDER BY id DESC").fetchall()
    for generation_id, snapshot in rows:
        if t2.backend_names(snapshot) == BASELINE_BACKENDS:
            return generation_id
    return None


def generation_count(db_path):
    with readonly_db(db_path) as db:
        row = db.execute("SELECT COUNT(*) FROM config_generations").fetchone()
    return int(row[0])


def newest_committed_backends(db_path):
    with readonly_db(db_path) as db:
        row = db.execute("SELECT generation_id, config_snapshot FROM config_generations "
                         "WHERE status='COMMITTED' ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return None, []
    return row[0], sorted(t2.backend_names(row[1]))


async def dpa_request(client, method, gateway, path, password, content=None):
    url = f"http://{GATEWAYS[gateway]}:5555/v3{path}"
    return await client.request(method, url, auth=("admin", password), content=content,
                                headers={"Content-Type": "text/plain"} if content is not None else None)


async def dpa_info_and_version(client, password, gateway):
    info = await dpa_request(client, "GET", gateway, "/info", password)
    version = await dpa_request(client, "GET", gateway, "/services/haproxy/configuration/version", password)
    if info.status_code != 200:
        raise RuntimeError(f"{gateway} DPA /info returned HTTP {info.status_code}: {info.text[:500]}")
    if version.status_code != 200 or not re.fullmatch(r"\s*\d+\s*", version.text):
        raise RuntimeError(f"{gateway} DPA configuration version returned HTTP {version.status_code}: {version.text[:500]}")
    return version.text.strip()


def check_baselines(configs):
    found = {name: sorted(t2.backend_names(content)) for name, content in configs.items()}
    differences = {name: {"missing": sorted(BASELINE_BACKENDS - set(found.get(name, []))),
                          "unexpected": sorted(set(found.get(name, [])) - BASELINE_BACKENDS)}
                   for name in GATEWAYS}
    passed = set(configs) == set(GATEWAYS) and all(not diff["missing"] and not diff["unexpected"]
                                                    for diff in differences.values())
    return passed, {"found": found, "expected": sorted(BASELINE_BACKENDS), "difference": differences}


async def gateway_haproxy_checks(cfg):
    checks = {}
    for gateway, key in (("gw1", "primary"), ("gw2", "standby")):
        try:
            host = cfg["safety_gates"]["allowed_gateway_hosts"][key]
            output = await t2.ssh_remote(cfg, host,
                "sudo haproxy -c -f /etc/haproxy/haproxy.cfg && "
                "printf 'BASELINE_BACKENDS=' && grep -Ec '^backend (default_maintenance|team1_backend|team2_backend)$' /etc/haproxy/haproxy.cfg")
            match = re.search(r"BASELINE_BACKENDS=(\d+)", output)
            checks[gateway] = {"output": output.strip(),
                "haproxy_config_valid": "Configuration file is valid" in output,
                "baseline_backend_count": int(match.group(1)) if match else None,
                "three_baseline_backends": bool(match and int(match.group(1)) == 3)}
        except Exception as exc:
            checks[gateway] = {"status": "NOT EXECUTED", "error": t2.redact_process_error(
                f"{type(exc).__name__}: {exc}")}
    return checks


async def db_inflight(db_path):
    with readonly_db(db_path) as db:
        rows = db.execute("SELECT sandbox_id,status FROM sandboxes "
                          "WHERE UPPER(status) IN ('PROVISIONING','TEARING_DOWN') ORDER BY sandbox_id").fetchall()
    return [{"sandbox_id": row[0], "status": row[1]} for row in rows]


async def preflight(cfg, api, db_path, password, admin_token, vip, domain, vip_client):
    out = {"credentials": {"DPA_PASS": {"set": bool(password), "length": len(password)},
                            "ADMIN_TOKEN": {"set": bool(admin_token), "length": len(admin_token)}}}
    if not password or not admin_token:
        raise RuntimeError("DPA_PASS and ADMIN_TOKEN must both be set")
    servers = await t2.openstack_json(cfg["openstack"]["cloud"], "server", "list")
    names = sorted(str(server.get("Name", "")) for server in servers)
    out["servers"] = {"count": len(servers), "names": names,
                      "only_five_permanent_vms": len(servers) == 5 and not any(n.startswith("bench-") for n in names)}
    configs, errors = await t5.gateway_configs()
    baseline_ok, baseline = check_baselines(configs)
    out["gateway_configs"] = {"passed": baseline_ok, **baseline, "errors": errors}
    out["gateway_haproxy_checks"] = await gateway_haproxy_checks(cfg)
    out["gateway_haproxy_valid"] = all(v.get("haproxy_config_valid") and v.get("three_baseline_backends")
                                         for v in out["gateway_haproxy_checks"].values())
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as dpa:
        out["dpa"] = {}
        for gateway in GATEWAYS:
            version = await dpa_info_and_version(dpa, password, gateway)
            out["dpa"][gateway] = {"info_http_status": 200, "configuration_version": version}
    team1 = await t2.probe(vip_client, t2.RateGate(), f"http://{vip}", f"team1.{domain}")
    out["team1_probe"] = team1
    out["team1_returns_200"] = team1["status"] == 200
    out["provisions_in_flight"] = await db_inflight(db_path)
    out["no_provision_in_flight"] = not out["provisions_in_flight"]
    out["safe_target_generation"] = safe_generation(db_path)
    if not out["safe_target_generation"]:
        raise RuntimeError("no COMMITTED generation has exactly the three baseline backends")
    passed = (out["servers"]["only_five_permanent_vms"] and baseline_ok and out["gateway_haproxy_valid"]
              and out["team1_returns_200"] and out["no_provision_in_flight"])
    out["passed"] = passed
    if not passed:
        raise RuntimeError("T6 preflight failed; see recorded server, gateway, team1, and inflight observations")
    return out


async def background_prober(client, gate, url, host, stop, samples):
    while not stop.is_set():
        due = time.monotonic()
        sample = await t2.probe(client, gate, url, host, timeout=5)
        samples.append(sample)
        delay = max(0.0, PROBE_INTERVAL_SECONDS - (time.monotonic() - due))
        try:
            await asyncio.wait_for(stop.wait(), delay)
        except asyncio.TimeoutError:
            pass


def timestamp_value(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def probe_drops(samples, started_utc, finished_utc):
    started, finished = timestamp_value(started_utc), timestamp_value(finished_utc)
    during = [sample for sample in samples
              if started <= timestamp_value(sample["timestamp_utc"]) <= finished]
    latencies = [float(sample.get("latency_ms") or 0) for sample in during]
    return {"total": len(during),
            "drops": sum(sample["status"] != 200 or bool(sample.get("error")) or sample["status"] == 0
                         for sample in during),
            "non_200": sum(sample["status"] not in (200, 429, 0) for sample in during),
            "429": sum(sample["status"] == 429 for sample in during),
            "connection_errors": sum(sample["status"] == 0 or bool(sample.get("error")) for sample in during),
            "slow_samples_over_500ms": sum(latency > 500 for latency in latencies),
            "max_latency_ms": max(latencies) if latencies else None}


def attribute_all_probe_samples(result):
    calls = result.get("scenario_a_syncs", []) + result.get("scenario_c_rollbacks", [])
    assigned = [set() for _ in calls]
    for sample_index, sample in enumerate(result.get("prober", {}).get("samples", [])):
        stamp = timestamp_value(sample["timestamp_utc"])
        for call_index, call in enumerate(calls):
            if timestamp_value(call["client_started_utc"]) <= stamp <= timestamp_value(call["client_finished_utc"]):
                assigned[call_index].add(sample_index)
                break
    for call_index, call in enumerate(calls):
        call["prober_drops_during_call"] = probe_drops(
            [result["prober"]["samples"][i] for i in sorted(assigned[call_index])],
            call["client_started_utc"], call["client_finished_utc"])
    in_call = set().union(*assigned) if assigned else set()
    outside = [sample for i, sample in enumerate(result.get("prober", {}).get("samples", [])) if i not in in_call]
    result["prober"]["samples_outside_call_windows"] = outside
    error_count = lambda items: sum(sample["status"] == 0 or bool(sample.get("error")) for sample in items)
    call_error_count = sum(call["prober_drops_during_call"]["connection_errors"] for call in calls)
    outside_error_count = error_count(outside)
    total_error_count = error_count(result.get("prober", {}).get("samples", []))
    result["prober"].update({"connection_error_count": total_error_count,
        "connection_error_count_in_call_windows": call_error_count,
        "connection_error_count_outside_call_windows": outside_error_count,
        "connection_error_attribution_matches_total": total_error_count == call_error_count + outside_error_count})


async def gateway_raw_configs(password):
    configs = {}
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        for gateway in GATEWAYS:
            response = await dpa_request(client, "GET", gateway, "/services/haproxy/configuration/raw", password)
            response.raise_for_status()
            configs[gateway] = response.text
    return configs


async def raw_haproxy_validation(cfg, gateway):
    host = cfg["safety_gates"]["allowed_gateway_hosts"]["primary" if gateway == "gw1" else "standby"]
    output = await t2.ssh_remote(cfg, host,
        "sudo haproxy -c -f /etc/haproxy/haproxy.cfg && "
        "printf 'BASELINE_BACKENDS=' && grep -Ec '^backend (default_maintenance|team1_backend|team2_backend)$' /etc/haproxy/haproxy.cfg")
    match = re.search(r"BASELINE_BACKENDS=(\d+)", output)
    return {"output": output.strip(), "haproxy_config_valid": "Configuration file is valid" in output,
            "baseline_backend_count": int(match.group(1)) if match else None,
            "three_baseline_backends": bool(match and int(match.group(1)) == 3)}


async def invalid_config_scenario(cfg, password, vip_client, gate, vip, domain):
    observations = {}
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        for gateway in GATEWAYS:
            before = await dpa_info_and_version(client, password, gateway)
            response = await dpa_request(client, "POST", gateway,
                f"/services/haproxy/configuration/raw?version={before}&only_validate=true",
                password, "this is not a valid haproxy configuration\n")
            after = await dpa_info_and_version(client, password, gateway)
            observations[gateway] = {"status_code": response.status_code, "error_text": response.text,
                "version_before": before, "version_after": after, "version_unchanged": before == after}
    observations["gateway_state_after"] = await raw_haproxy_validation(cfg, "gw1")
    observations["gateway_state_after_gw2"] = await raw_haproxy_validation(cfg, "gw2")
    observations["team1_probe_after"] = await t2.probe(vip_client, gate, f"http://{vip}", f"team1.{domain}")
    observations["rejected_pre_commit"] = all(observations[g]["status_code"] == 400 and
        observations[g]["version_unchanged"] for g in GATEWAYS) and all(
        observations[f"gateway_state_after{suffix}"].get("haproxy_config_valid") and
        observations[f"gateway_state_after{suffix}"].get("three_baseline_backends")
        for suffix in ("", "_gw2")) and observations["team1_probe_after"]["status"] == 200
    return observations


async def run(cfg, smoke):
    cp = cfg["control_plane"]
    base_url = cp["base_url"].rstrip("/")
    if base_url != "http://127.0.0.1:8081":
        raise RuntimeError(f"T6 requires the live control plane at http://127.0.0.1:8081 (got {base_url})")
    token = os.environ.get("ADMIN_TOKEN", "")
    password = os.environ.get("DPA_PASS", "")
    network = cfg["network"]
    vip = str(network.get("public_vip", "")).removeprefix("http://").removesuffix("/")
    domain = str(network.get("domain", ""))
    if not vip or domain != "cloudpulse.cstam.felcloud.tn":
        raise RuntimeError("PUBLIC_VIP_IP and ROUTING_DOMAIN=cloudpulse.cstam.felcloud.tn are required")
    db_path = t2.resolve_live_db_path()
    sync_count, rollback_count = (1, 1) if smoke else (5, 5)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    result = {"test": "T6_reload_rollback", "timestamp_utc": utc_now(),
        "status": "NOT EXECUTED", "mode": "smoke" if smoke else "full", "settings": SETTINGS,
        "health_window_duration_in_rollback": "5 seconds; included in rollback duration",
        "health_window_checks": "Both gateway HAProxy UP, VIP HTTP 2xx, and each previously healthy backend remains present and not DOWN.",
        "content_sha_identical_config_behavior": "No content_sha short-circuit exists; sync calls the gateway deployment runner, which posts config to both DPAs.",
        "scenario_d": {"status": "NOT EXECUTED", "reason": "A valid but unhealthy generated backend cannot be created without changing route data, provisioning a VM, or hand-pushing config; all are excluded by this test's constraints."},
        "preflight": {}, "scenario_a_syncs": [], "scenario_b_invalid_config": {},
        "scenario_c_rollbacks": [], "prober": {"samples": []}, "final_sanity": {}}
    gate = t2.RateGate()
    samples = result["prober"]["samples"]
    stop = asyncio.Event()
    prober_task = None
    RAW.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    try:
        async with AsyncControlPlaneClient(base_url, token, timeout=420) as api, \
                   httpx.AsyncClient(timeout=8, follow_redirects=False) as vip_client:
            result["preflight"] = await preflight(cfg, api, db_path, password, token, vip, domain, vip_client)
            prober_task = asyncio.create_task(background_prober(vip_client, gate, f"http://{vip}",
                f"team1.{domain}", stop, samples))
            async with httpx.AsyncClient(timeout=420, follow_redirects=False) as sync_client:
                for index in range(sync_count):
                    before = generation_count(db_path)
                    started_utc = utc_now()
                    response = await api.request("POST", "/api/gateways/sync", json_body={"dry_run": False})
                    ended_utc = utc_now()
                    after = generation_count(db_path)
                    drops = probe_drops(samples, started_utc, ended_utc)
                    result["scenario_a_syncs"].append({"index": index + 1,
                        "http_status": response.status_code, "response": response.data,
                        "duration_ms": response.elapsed_seconds * 1000,
                        "client_duration_ms": (timestamp_value(ended_utc) - timestamp_value(started_utc)).total_seconds() * 1000,
                        "client_started_utc": started_utc,
                        "client_finished_utc": ended_utc, "success": response.status_code == 200 and
                        response.data.get("success") is True, "generation_count_before": before,
                        "generation_count_after": after, "generation_count_changed": after != before,
                        "prober_drops_during_call": drops})
                result["scenario_b_invalid_config"] = await invalid_config_scenario(
                    cfg, password, vip_client, gate, vip, domain)
                for index in range(rollback_count):
                    started_utc = utc_now()
                    try:
                        response = await api.request("POST", "/api/gateways/rollback",
                            json_body={"target_generation": result["preflight"]["safe_target_generation"]})
                    except Exception as exc:
                        ended_utc = utc_now()
                        result["scenario_c_rollbacks"].append({"index": index + 1, "http_status": None,
                            "success": False, "duration_ms": None, "client_started_utc": started_utc,
                            "client_finished_utc": ended_utc,
                            "client_duration_ms": (timestamp_value(ended_utc) - timestamp_value(started_utc)).total_seconds() * 1000,
                            "error": t2.redact_process_error(f"{type(exc).__name__}: {exc}"), "response": {},
                            "prober_drops_during_call": probe_drops(samples, started_utc, ended_utc)})
                        raise
                    ended_utc = utc_now()
                    drops = probe_drops(samples, started_utc, ended_utc)
                    result["scenario_c_rollbacks"].append({"index": index + 1,
                        "http_status": response.status_code, "success": response.status_code == 200 and
                        response.data.get("success") is True, "duration_ms": response.data.get("duration_ms"),
                        "client_duration_ms": (timestamp_value(ended_utc) - timestamp_value(started_utc)).total_seconds() * 1000,
                        "client_started_utc": started_utc, "client_finished_utc": ended_utc,
                        "new_generation_id": response.data.get("generation"),
                        "response": response.data, "prober_drops_during_call": drops})
            result["status"] = "COMPLETED"
    except Exception as exc:
        result["error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
    finally:
        if prober_task:
            stop.set()
            await prober_task
    attribute_all_probe_samples(result)
    result["prober"].update({"sample_count": len(samples),
        "non_200_count": sum(sample["status"] not in (200, 429, 0) for sample in samples),
        "429_count": sum(sample["status"] == 429 for sample in samples),
        "connection_error_count": sum(sample["status"] == 0 or bool(sample.get("error")) for sample in samples),
        "total_drops": sum(sample["status"] != 200 or bool(sample.get("error")) or sample["status"] == 0
                            for sample in samples),
        "interval_seconds": PROBE_INTERVAL_SECONDS})
    if result.get("preflight", {}).get("passed"):
        try:
            configs, errors = await t5.gateway_configs()
            baseline_ok, backends = check_baselines(configs)
            validations = await gateway_haproxy_checks(cfg)
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as final_vip_client:
                team1 = await t2.probe(final_vip_client, gate, f"http://{vip}", f"team1.{domain}")
            generation, committed_backends = newest_committed_backends(db_path)
            result["final_sanity"] = {"servers": await t2.openstack_json(cfg["openstack"]["cloud"], "server", "list"),
                "gateway_baseline": {"passed": baseline_ok, **backends, "errors": errors},
                "gateway_haproxy_checks": validations, "team1_probe": team1,
                "team1_returns_200": team1["status"] == 200,
                "newest_committed_generation": generation,
                "newest_committed_backends": committed_backends,
                "newest_committed_has_baseline": set(committed_backends) == BASELINE_BACKENDS}
            result["final_sanity"]["only_five_permanent_vms"] = (
                len(result["final_sanity"]["servers"]) == 5 and
                not any(str(server.get("Name", "")).startswith("bench-") for server in result["final_sanity"]["servers"]))
            result["final_sanity"]["passed"] = (result["final_sanity"]["only_five_permanent_vms"] and baseline_ok
                and all(check.get("haproxy_config_valid") and check.get("three_baseline_backends")
                        for check in validations.values()) and result["final_sanity"]["team1_returns_200"]
                and result["final_sanity"]["newest_committed_has_baseline"])
        except Exception as exc:
            result["final_sanity"] = {"passed": False, "error": t2.redact_process_error(
                f"{type(exc).__name__}: {exc}")}
    syncs = result.get("scenario_a_syncs", [])
    rollbacks = result.get("scenario_c_rollbacks", [])
    invalid = result.get("scenario_b_invalid_config", {})
    rollbacks_succeeded = sum(bool(op.get("success")) for op in rollbacks)
    rollbacks_attempted = len(rollbacks)
    any_rollback_failed = rollbacks_succeeded < rollbacks_attempted
    successful_rollbacks = [op for op in rollbacks if op.get("success")]
    all_successful_durations_present = all(isinstance(op.get("duration_ms"), (int, float))
                                            for op in successful_rollbacks)
    rollback_under_1_second = (None if any_rollback_failed or not rollbacks_attempted or
                               not all_successful_durations_present else
        all(float(op["duration_ms"]) < 1000 for op in successful_rollbacks))
    result["rollbacks_succeeded"] = rollbacks_succeeded
    result["rollbacks_attempted"] = rollbacks_attempted
    result["rollback_under_1_second"] = rollback_under_1_second
    result["rollback_under_1_second_status"] = "NOT MEASURED" if rollback_under_1_second is None else "MEASURED"
    result["pass_targets"] = {"zero_sync_prober_drops": bool(syncs) and all(
        op["prober_drops_during_call"]["drops"] == 0 for op in syncs),
        "rollback_under_1_second": rollback_under_1_second,
        "invalid_rejected_pre_commit": invalid.get("rejected_pre_commit") is True}
    if result["status"] == "COMPLETED":
        result["status"] = "PASSED" if all(result["pass_targets"].values()) and \
            result.get("final_sanity", {}).get("passed") else "FAILED"
    elif result.get("scenario_a_syncs") or result.get("scenario_b_invalid_config") or result.get("scenario_c_rollbacks"):
        result["status"] = "FAILED"
    else:
        result["status"] = "NOT EXECUTED"
    result["timestamp_utc_end"] = utc_now()
    return result


def write_outputs(result):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    csv_path = RAW / f"t6_reload_rollback_{stamp}.csv"
    rows = []
    for phase, entries in (("sync", result.get("scenario_a_syncs", [])),
                           ("rollback", result.get("scenario_c_rollbacks", []))):
        for entry in entries:
            rows.append({"row_type": phase, **entry})
    for gateway in ("gw1", "gw2"):
        entry = result.get("scenario_b_invalid_config", {}).get(gateway)
        if entry:
            rows.append({"row_type": "invalid_config", "gateway": gateway, **entry})
    for sample in result.get("prober", {}).get("samples", []):
        rows.append({"row_type": "team1_prober", **sample})
    fields = sorted({key for row in rows for key in row}) or ["row_type"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
                             for key, value in row.items()})
    chart_path = CHARTS / f"t6_reload_rollback_{stamp}.png"
    labels, durations, drops = [], [], []
    for phase, entries in (("sync", result.get("scenario_a_syncs", [])),
                           ("rollback", result.get("scenario_c_rollbacks", []))):
        for index, entry in enumerate(entries, 1):
            labels.append(f"{phase} {index}")
            durations.append(float(entry.get("duration_ms", entry.get("client_duration_ms", 0)) or 0))
            drops.append(int(entry.get("prober_drops_during_call", {}).get("drops", 0)))
    fig, axis = plt.subplots(figsize=(10, 5))
    axis.bar(labels, durations, color=["#1f77b4" if label.startswith("sync") else "#ff7f0e" for label in labels])
    axis.set_ylabel("API duration (ms)")
    axis.set_title("T6 sync and rollback duration; line shows team1 probe drops")
    axis.grid(True, axis="y", alpha=0.3)
    if labels:
        twin = axis.twinx()
        twin.plot(labels, drops, color="#d62728", marker="o", label="probe drops")
        twin.set_ylabel("probe drops")
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150)
    plt.close(fig)
    summary_path = RAW / f"t6_reload_rollback_{stamp}_summary.json"
    result["artifacts"] = {"raw_csv": str(csv_path), "summary_json": str(summary_path), "chart": str(chart_path)}
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description="T6 gateway reload and rollback test")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(BASE / "config.yaml")
        if args.dry_run:
            print(json.dumps({"test": "T6_reload_rollback", "mode": "DRY RUN", "network_calls": False,
                "settings": SETTINGS, "sync_count": 1 if args.smoke else 5,
                "invalid_config_checks": ["gw1", "gw2"], "rollback_count": 1 if args.smoke else 5,
                "rollback_target": "newest COMMITTED SQLite snapshot with exactly the 3 baseline backends",
                "prober_interval_seconds": PROBE_INTERVAL_SECONDS,
                "scenario_d": "NOT EXECUTED: no safe unhealthy-backend trigger without changing route data, provisioning, or hand-pushing config",
                "health_window_checks": "Both gateway HAProxy UP; VIP 2xx; previously healthy backends remain present and not DOWN.",
                "content_sha_behavior": "No content_sha short-circuit; sync calls gateway deployment runner.",
                "rollback_duration_note": "The 5-second health window is included in API duration.",
                "rollback_under_1_second": None, "rollback_under_1_second_status": "NOT MEASURED",
                "outputs": ["raw CSV", "summary JSON", "chart in bench/results"]}, indent=2))
            return 0
        result = write_outputs(asyncio.run(run(cfg, args.smoke)))
        print(json.dumps({"test": result["test"], "status": result["status"], "error": result.get("error"),
            "preflight": result.get("preflight"), "pass_targets": result.get("pass_targets"),
            "final_sanity": result.get("final_sanity"), "artifacts": result.get("artifacts")}, indent=2))
        return 0 if result["status"] == "PASSED" else 2
    except Exception as exc:
        print(f"T6 NOT EXECUTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
