#!/usr/bin/env python3
"""Measure live lease expiry, reaper teardown, and IP reclamation."""
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

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "results" / "raw"
CHARTS = BASE / "results" / "charts"
PERMANENT_VM_COUNT = 5
BASELINE_BACKENDS = {"default_maintenance", "team1_backend", "team2_backend"}
TIMEOUT = 420.0
TEARDOWN_DEADLINE_MARGIN_SECONDS = 180
RECLAIM_WAIT_MARGIN_SECONDS = 60
KNOWN_STALE_ROWS = {
    "bench-t1-20261017t214147z-01",
    "bench-t1-20261017t222905z-01",
    "bench-t1-20261018t082213z-01",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def env_settings(default_ttl):
    return {
        "DEFAULT_TTL_SECONDS": default_ttl if default_ttl is not None else "unset",
        "MAX_CONCURRENT_PROVISIONS": os.environ.get("MAX_CONCURRENT_PROVISIONS", "unset"),
        "HEALTH_REGRESSION_WINDOW_SECONDS": os.environ.get("HEALTH_REGRESSION_WINDOW_SECONDS", "unset"),
        "GATEWAY_PROBE_TIMEOUT_SECONDS": os.environ.get("GATEWAY_PROBE_TIMEOUT_SECONDS", "unset"),
        "RATE_LIMIT_PER_MIN": os.environ.get("RATE_LIMIT_PER_MIN", "unset"),
    }


def readonly_db(path):
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def read_sandbox_rows(db_path, sandbox_ids):
    if not sandbox_ids:
        return {}
    marks = ",".join("?" for _ in sandbox_ids)
    with readonly_db(db_path) as db:
        rows = db.execute(f"""SELECT sandbox_id, status, expires_at, private_ip, server_id, port_id,
            teardown_last_error, teardown_step, teardown_started_at, teardown_route_removed_at,
            teardown_resources_deleted_at, teardown_verified_gone_at, teardown_released_at
            FROM sandboxes WHERE sandbox_id IN ({marks})""", tuple(sandbox_ids)).fetchall()
        ip_rows = db.execute(f"""SELECT entity_name, ip_address, status, quarantine_until, assigned_at
            FROM ip_allocations WHERE entity_name IN ({marks})""", tuple(sandbox_ids)).fetchall()
    result = {row[0]: {"sandbox_id": row[0], "status": row[1], "expires_at": row[2],
        "private_ip": row[3], "server_id": row[4], "port_id": row[5], "teardown_last_error": row[6],
        "teardown_step": row[7], "teardown_started_at": row[8], "teardown_route_removed_at": row[9],
        "teardown_resources_deleted_at": row[10], "teardown_verified_gone_at": row[11],
        "teardown_released_at": row[12]} for row in rows}
    for owner, ip, status, until, assigned in ip_rows:
        result.setdefault(owner, {"sandbox_id": owner})
        result[owner].update({"ip_address": ip, "ipam_status": status,
                              "quarantine_until": until, "ip_assigned_at": assigned})
    return result


def read_events(db_path, sandbox_ids):
    if not sandbox_ids:
        return {}
    marks = ",".join("?" for _ in sandbox_ids)
    with readonly_db(db_path) as db:
        rows = db.execute(f"""SELECT sandbox_id, ts_ms, type, detail, duration_ms FROM events
            WHERE sandbox_id IN ({marks}) ORDER BY ts_ms, id""", tuple(sandbox_ids)).fetchall()
    result = {sid: [] for sid in sandbox_ids}
    for sid, ts_ms, kind, detail, duration in rows:
        result.setdefault(sid, []).append({"ts_ms": ts_ms, "type": kind, "detail": detail,
                                           "duration_ms": duration})
    return result


def event_timestamps(events):
    desired = {"TEARDOWN_STARTED", "ROUTE_REMOVED", "SERVER_DELETED", "PORT_DELETED",
               "RESOURCES_DELETED", "VERIFIED_GONE", "RELEASED"}
    timestamps = {}
    for event in events:
        kind = str(event["type"]).upper()
        if kind in desired and kind not in timestamps:
            timestamps[kind] = event["ts_ms"] / 1000
    return timestamps


def iso_epoch(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        try:
            return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            return None


def event_utc(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if epoch else ""


def step_seconds(start, end):
    return round(end - start, 3) if start is not None and end is not None else None


def sample_in_any_teardown(sample, rows):
    sample_epoch = iso_epoch(sample["timestamp_utc"])
    for row in rows:
        timestamps = row.get("event_timestamps_utc", {})
        start = iso_epoch(timestamps.get("TEARDOWN_STARTED"))
        end = iso_epoch(timestamps.get("RELEASED"))
        if start is not None and end is not None and start <= sample_epoch <= end:
            return True
    return False


def openstack_names(rows):
    return {str(row.get("Name", "")): row for row in rows}


async def api_call(client, method, path, **kwargs):
    response = await client.request(method, path, **kwargs)
    return response.status_code, response.data


async def read_sandbox_list(api):
    status, data = await api_call(api, "GET", "/api/sandboxes")
    if status != 200:
        raise RuntimeError(f"GET /api/sandboxes returned HTTP {status}: {data}")
    return data.get("sandboxes", [])


def check_baseline(configs):
    names = {key: sorted(t2.backend_names(value)) for key, value in configs.items()}
    differences = {key: {"missing": sorted(BASELINE_BACKENDS - set(names.get(key, []))),
                         "unexpected": sorted(set(names.get(key, [])) - BASELINE_BACKENDS)}
                   for key in ("gw1", "gw2")}
    okay = set(configs) == {"gw1", "gw2"} and all(not d["missing"] and not d["unexpected"]
                                                       for d in differences.values())
    return okay, {"found": names, "expected": sorted(BASELINE_BACKENDS), "difference": differences}


async def gateway_configs():
    password = os.environ["DPA_PASS"]
    configs = {}
    errors = {}
    for label, host in (("gw1", "127.0.0.11"), ("gw2", "127.0.0.12")):
        try:
            configs[label] = await t2.fetch_dpa_raw(host, password)
        except Exception as exc:
            errors[label] = f"{type(exc).__name__}: {exc}"
    return configs, errors


async def preflight(cfg, api, db_path):
    observation = {}
    servers = await t2.openstack_json(cfg["openstack"]["cloud"], "server", "list")
    server_map = openstack_names(servers)
    observation["openstack_servers"] = {"count": len(servers), "only_five_permanent_vms":
        len(servers) == PERMANENT_VM_COUNT and not any(name.startswith("bench-") for name in server_map)}
    configs, gateway_errors = await gateway_configs()
    baseline_ok, baseline = check_baseline(configs)
    observation["gateways"] = {"backend_guard_passed": baseline_ok, **baseline,
                                "errors": gateway_errors}
    with readonly_db(db_path) as db:
        db_rows = [dict(zip(("sandbox_id", "status", "updated_at"), row)) for row in db.execute(
            "SELECT sandbox_id,status,updated_at FROM sandboxes WHERE sandbox_id LIKE 'bench-%' ORDER BY sandbox_id").fetchall()]
    api_rows = await read_sandbox_list(api)
    status_counts = {}
    db_by_id = {}
    for row in db_rows:
        status = str(row.get("status") or "UNKNOWN").upper()
        status_counts[status] = status_counts.get(status, 0) + 1
        db_by_id[row["sandbox_id"]] = row
    non_released = {row["sandbox_id"]: dict(row) for row in db_rows
                    if str(row.get("status") or "").upper() != "RELEASED"}
    for api_row in api_rows:
        sid = str(api_row.get("sandbox_id", ""))
        status = str(api_row.get("status", "")).upper()
        if sid.startswith("bench-") and status != "RELEASED":
            non_released.setdefault(sid, {"sandbox_id": sid, "status": status,
                                          "updated_at": api_row.get("updated_at"), "source": "api"})
    known_stale = [
        {"sandbox_id": sid, "status": db_by_id[sid].get("status"), "updated_at": db_by_id[sid].get("updated_at")}
        for sid in sorted(KNOWN_STALE_ROWS)
        if sid in db_by_id and str(db_by_id[sid].get("status", "")).upper() == "TEARDOWN_FAILED"
    ]
    known_stale_ids = {row["sandbox_id"] for row in known_stale}
    non_released_rows = sorted(non_released.values(), key=lambda row: row["sandbox_id"])
    unexpected_rows = [row for row in non_released_rows if row["sandbox_id"] not in known_stale_ids]
    observation["leftover_bench_rows"] = {"counts_by_status": status_counts,
        "known_stale_rows": known_stale, "non_released_rows": non_released_rows,
        "unexpected_non_released_rows": unexpected_rows, "none": not unexpected_rows}
    observation["passed"] = (observation["openstack_servers"]["only_five_permanent_vms"] and
                              baseline_ok and observation["leftover_bench_rows"]["none"])
    return observation


def read_all_bench_rows(db_path):
    with readonly_db(db_path) as db:
        return [dict(zip(("sandbox_id", "status"), row)) for row in db.execute(
            "SELECT sandbox_id,status FROM sandboxes WHERE sandbox_id LIKE 'bench-%' ORDER BY sandbox_id").fetchall()]


def final_bench_row_summary(db_path):
    with readonly_db(db_path) as db:
        rows = [dict(zip(("sandbox_id", "status", "updated_at"), row)) for row in db.execute(
            "SELECT sandbox_id,status,updated_at FROM sandboxes WHERE sandbox_id LIKE 'bench-%' ORDER BY sandbox_id").fetchall()]
    counts = {}
    for row in rows:
        status = str(row.get("status") or "UNKNOWN").upper()
        counts[status] = counts.get(status, 0) + 1
    non_released = [row for row in rows if str(row.get("status") or "").upper() != "RELEASED"]
    unexpected = [row for row in non_released if not (
        row["sandbox_id"] in KNOWN_STALE_ROWS and str(row.get("status", "")).upper() == "TEARDOWN_FAILED")]
    return {"counts_by_status": counts, "non_allowlisted_non_released_rows": unexpected,
            "only_released_or_allowlisted_stale": not unexpected}


async def audit_orphans(cfg, api, db_path, ids, domain, vip_client, gate):
    servers = await t2.openstack_json(cfg["openstack"]["cloud"], "server", "list")
    ports = await t2.openstack_json(cfg["openstack"]["cloud"], "port", "list")
    server_map, port_map = openstack_names(servers), openstack_names(ports)
    configs, gateway_errors = await gateway_configs()
    lease_status, lease_data = await api_call(api, "GET", "/api/leases")
    leases = lease_data.get("leases", []) if lease_status == 200 else []
    lease_by_owner = {str(row.get("entity_name", "")): row for row in leases}
    rows = read_sandbox_rows(db_path, ids)
    audits = {}
    for sid in ids:
        row = rows.get(sid, {})
        backend = f"{sid}_backend"
        server_name, port_name = f"sandbox-{sid}", f"sandbox-{sid}"
        server_present = server_name in server_map
        port_present = port_name in port_map
        backend_present = {gw: backend in t2.backend_names(content) for gw, content in configs.items()}
        lease = lease_by_owner.get(sid, {})
        subdomain_probe = await t2.probe(vip_client, gate, f"http://{cfg['network']['public_vip']}",
                                        f"{sid}.{domain}")
        audits[sid] = {
            "nova_server_absent": not server_present, "nova_server_name": server_name,
            "neutron_port_absent": not port_present, "neutron_port_name": port_name,
            "route_backend_absent_both": set(backend_present) == {"gw1", "gw2"} and not any(backend_present.values()),
            "route_backend_present": backend_present, "gateway_errors": gateway_errors,
            "sandbox_status": row.get("status"), "private_ip": row.get("private_ip"),
            "ipam_released_null_private_ip": row.get("status") == "RELEASED" and not row.get("private_ip"),
            "lease_status": lease.get("status"), "lease_quarantined": lease.get("status") == "QUARANTINED",
            "subdomain_probe": subdomain_probe, "subdomain_not_200": subdomain_probe["status"] != 200,
        }
        checks = ("nova_server_absent", "neutron_port_absent", "route_backend_absent_both",
                  "ipam_released_null_private_ip", "lease_quarantined", "subdomain_not_200")
        audits[sid]["orphan_count"] = sum(not audits[sid][key] for key in checks)
    return audits


async def wait_for_free(db_path, sid, deadline):
    last = None
    while time.time() < deadline:
        rows = read_sandbox_rows(db_path, [sid])
        last = rows.get(sid, {})
        if last.get("ipam_status") == "FREE":
            return last, time.time()
        await asyncio.sleep(min(1, max(0, deadline - time.time())))
    return last or {}, None


async def run(cfg, smoke=False):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    count = 1 if smoke else 5
    raw_rows = []
    default_ttl_raw = os.environ.get("DEFAULT_TTL_SECONDS")
    settings = env_settings(default_ttl_raw)
    result = {"test": "T5_lease_expiry", "status": "NOT EXECUTED", "timestamp_utc": utc_now(),
              "mode": "smoke" if smoke else "full", "requested_sandboxes": count,
              "settings": settings, "sandboxes": [], "preflight": {}, "final_sanity": {}}
    try:
        if not default_ttl_raw:
            raise RuntimeError("DEFAULT_TTL_SECONDS is unset; export it in the harness shell")
        default_ttl = int(default_ttl_raw)
        if default_ttl <= 0 or default_ttl > 900:
            raise RuntimeError(f"DEFAULT_TTL_SECONDS must be 1..900 (got {default_ttl_raw})")
        token = os.environ.get("ADMIN_TOKEN", "")
        if not token:
            raise RuntimeError("ADMIN_TOKEN is unset")
        for key in ("PUBLIC_VIP_IP", "ROUTING_DOMAIN", "DPA_PASS"):
            if not os.environ.get(key):
                raise RuntimeError(f"{key} is unset")
        domain = os.environ["ROUTING_DOMAIN"]
        cp = cfg["control_plane"]
        if cp.get("base_url", "").rstrip("/") != "http://127.0.0.1:8081":
            raise RuntimeError("T5 requires the live control plane at http://127.0.0.1:8081")
        db_path = t2.resolve_live_db_path()
        result["live_db_path"] = db_path
        RAW.mkdir(parents=True, exist_ok=True)
        CHARTS.mkdir(parents=True, exist_ok=True)
        async with AsyncControlPlaneClient(cp["base_url"], token, timeout=TIMEOUT) as api, \
                   httpx.AsyncClient(timeout=8, follow_redirects=False) as vip_client:
            health_status, health_data = await api_call(api, "GET", "/health")
            if health_status != 200:
                raise RuntimeError(f"control plane /health returned HTTP {health_status}: {health_data}")
            pre = await preflight(cfg, api, db_path)
            result["preflight"] = pre
            if not pre["passed"]:
                result["status"] = "NOT EXECUTED"
                result["error"] = "T5 preflight failed; no sandbox was provisioned"
            else:
                ids = [f"bench-t5-{stamp.lower()}-{index:02d}" for index in range(1, count + 1)]
                result["sandbox_ids"] = ids
                gate = t2.RateGate()
                rows = {sid: {"sandbox_id": sid, "status": "PENDING", "errors": [],
                              "post_started_utc": "", "provision_http_status": None,
                              "expires_at": None, "allocation_time_utc": "", "expiry_ttl_seconds": None,
                              "expiry_ttl_matches_default": False, "events": [], "orphan_count": None}
                        for sid in ids}
                result["sandboxes"] = list(rows.values())
                barrier = asyncio.Event()
                started_ids = set()

                async def provision_one(sid):
                    row = rows[sid]
                    await barrier.wait()
                    row["post_started_utc"] = utc_now()
                    started_ids.add(sid)
                    try:
                        response = await api.request("POST", "/api/sandboxes/provision",
                            json_body={"team": sid, "custom_domain": f"{sid}.{domain}"})
                        row["provision_http_status"] = response.status_code
                        row["provision_response"] = response.data
                        row["provision_elapsed_ms"] = response.elapsed_seconds * 1000
                        if response.status_code not in (200, 201):
                            row["status"] = "PROVISION_FAILED"
                            row["errors"].append(t2.error_text(response.data))
                        else:
                            row["status"] = "PROVISIONED_WAITING_FOR_REAPER"
                    except Exception as exc:
                        row["status"] = "PROVISION_REQUEST_ERROR"
                        row["errors"].append(f"{type(exc).__name__}: {exc}")

                tasks = [asyncio.create_task(provision_one(sid)) for sid in ids]
                stop_probe = asyncio.Event()
                prober_samples = []
                prober = asyncio.create_task(t2.background_probe(vip_client, gate,
                    f"http://{os.environ['PUBLIC_VIP_IP']}", stop_probe, prober_samples))
                barrier.set()
                await asyncio.gather(*tasks)
                result["provisioning_completed_utc"] = utc_now()

                # Read allocation and expiry from the live database, without opening it for writes.
                initial_db = read_sandbox_rows(db_path, ids)
                initial_events = read_events(db_path, ids)
                for sid, row in rows.items():
                    dbrow = initial_db.get(sid, {})
                    allocated_events = [event for event in initial_events.get(sid, [])
                                        if str(event["type"]).lower() == "allocated"]
                    allocated_at = allocated_events[0]["ts_ms"] / 1000 if allocated_events else iso_epoch(dbrow.get("ip_assigned_at"))
                    expires_at = dbrow.get("expires_at")
                    row.update({"expires_at": expires_at, "allocation_time_utc": event_utc(allocated_at),
                                "ip_address": dbrow.get("ip_address"), "expiry_ttl_seconds":
                                round(expires_at - allocated_at, 3) if expires_at is not None and allocated_at is not None else None})
                    row["expiry_ttl_matches_default"] = (row["expiry_ttl_seconds"] is not None and
                        abs(row["expiry_ttl_seconds"] - default_ttl) <= 1.0)
                    row["expiry_ttl_resolution"] = "expires_at is integer seconds; allocation event is millisecond timestamp; tolerance 1 second"

                # Wait for the reaper per sandbox. No DELETE is sent unless its deadline expires.
                for sid, row in rows.items():
                    expiry = row.get("expires_at")
                    if expiry is None:
                        row["status"] = "TEARDOWN NOT COMPLETED"
                        row["errors"].append("expires_at unavailable from read-only sandbox row")
                        continue
                    deadline = expiry + TEARDOWN_DEADLINE_MARGIN_SECONDS
                    row["teardown_deadline_utc"] = event_utc(deadline)
                    while time.time() <= deadline:
                        dbrow = read_sandbox_rows(db_path, [sid]).get(sid, {})
                        row.update({key: dbrow.get(key) for key in ("status", "teardown_last_error", "teardown_step")})
                        if row.get("status") == "RELEASED":
                            break
                        await asyncio.sleep(min(1, max(0.0, deadline - time.time())))
                    if row.get("status") != "RELEASED":
                        row["status"] = "TEARDOWN NOT COMPLETED"
                        row["errors"].append(f"TEARDOWN NOT COMPLETED; last status={dbrow.get('status')}; teardown_last_error={dbrow.get('teardown_last_error')}")
                        # Targeted fallback only after the per-sandbox deadline, and sequentially.
                        if sid.startswith("bench-"):
                            try:
                                code, data = await api_call(api, "DELETE", f"/api/sandboxes/{sid}")
                                row["fallback_delete"] = {"http_status": code, "response": data,
                                    "same_active_server_error": "Nova server still exists with status ACTIVE" in t2.error_text(data)}
                                row["delete_502_active_server_message"] = code == 502 and row["fallback_delete"]["same_active_server_error"]
                            except Exception as exc:
                                row["fallback_delete"] = {"error": f"{type(exc).__name__}: {exc}"}

                # Stop prober after teardown completion so its samples cover all reloads.
                stop_probe.set()
                await prober
                event_map = read_events(db_path, ids)
                for sid, row in rows.items():
                    events = event_map.get(sid, [])
                    row["events"] = events
                    times = event_timestamps(events)
                    exp = row.get("expires_at")
                    row["event_timestamps_utc"] = {key: event_utc(value) for key, value in times.items()}
                    row["expiry_to_teardown_started_seconds"] = step_seconds(exp, times.get("TEARDOWN_STARTED"))
                    row["expiry_to_released_seconds"] = step_seconds(exp, times.get("RELEASED"))
                    row["teardown_step_seconds"] = {
                        "teardown_started_to_route_removed": step_seconds(times.get("TEARDOWN_STARTED"), times.get("ROUTE_REMOVED")),
                        "route_removed_to_resources_deleted": step_seconds(times.get("ROUTE_REMOVED"), times.get("RESOURCES_DELETED")),
                        "resources_deleted_to_verified_gone": step_seconds(times.get("RESOURCES_DELETED"), times.get("VERIFIED_GONE")),
                        "verified_gone_to_released": step_seconds(times.get("VERIFIED_GONE"), times.get("RELEASED")),
                    }
                    row["reaper_delete_502_message_observed"] = "not observable from harness"
                    row.setdefault("delete_502_active_server_message", False)
                    teardown_start = times.get("TEARDOWN_STARTED")
                    released = times.get("RELEASED")
                    row["team1_prober_during_teardown"] = [sample for sample in prober_samples
                        if teardown_start is not None and released is not None and teardown_start <= iso_epoch(sample["timestamp_utc"]) <= released]
                    row["team1_prober_drops"] = sum(sample["status"] == 0 for sample in row["team1_prober_during_teardown"])
                    row["team1_prober_429"] = sum(sample["status"] == 429 for sample in row["team1_prober_during_teardown"])
                    row["team1_prober_non_200_other"] = sum(sample["status"] not in (0, 200, 429) for sample in row["team1_prober_during_teardown"])

                # Audit every resource, route, lease and hostname after RELEASED.
                audits = await audit_orphans(cfg, api, db_path, ids, domain, vip_client, gate)
                for sid, row in rows.items():
                    row["orphan_audit"] = audits.get(sid, {})
                    row["orphan_count"] = audits.get(sid, {}).get("orphan_count")
                    ip = row.get("ip_address")
                    ip_row = read_sandbox_rows(db_path, [sid]).get(sid, {})
                    until = iso_epoch(ip_row.get("quarantine_until"))
                    row["quarantine_until"] = ip_row.get("quarantine_until")
                    row["quarantine_until_utc"] = event_utc(until)
                    row["quarantine_state_seen"] = ip_row.get("ipam_status") == "QUARANTINED"
                    if until is not None:
                        free_row, free_epoch = await wait_for_free(db_path, sid, until + RECLAIM_WAIT_MARGIN_SECONDS)
                        row["ip_reclaimed_free_utc"] = event_utc(free_epoch)
                        row["ip_reclaim_lag_after_quarantine_seconds"] = round(free_epoch - until, 3) if free_epoch is not None else None
                        row["ip_reclaim_status_at_deadline"] = free_row.get("ipam_status")
                        row["ip_reclaim_deadline_utc"] = event_utc(until + RECLAIM_WAIT_MARGIN_SECONDS)
                        release_epoch = event_timestamps(row.get("events", [])).get("RELEASED")
                        row["release_to_reclaim_seconds"] = step_seconds(release_epoch, free_epoch)
                        row["ip_reclaim_time_resolution"] = "1 second (read-only SQLite polling)"
                    else:
                        row["ip_reclaimed_free_utc"] = ""
                        row["ip_reclaim_lag_after_quarantine_seconds"] = None
                        row["release_to_reclaim_seconds"] = None
                        row["errors"].append("quarantine_until unavailable; IP reclaim timing NOT EXECUTED")
                    row["status"] = "COMPLETED" if row.get("status") == "RELEASED" else row.get("status", "FAILED")

                # Final sanity uses live observations only.
                final = result["final_sanity"]
                final_servers = await t2.openstack_json(cfg["openstack"]["cloud"], "server", "list")
                final_ports = await t2.openstack_json(cfg["openstack"]["cloud"], "port", "list")
                final_sandbox_rows = final_bench_row_summary(db_path)
                final_configs, final_gateway_errors = await gateway_configs()
                final_guard, final_backends = check_baseline(final_configs)
                final_team1 = await t2.probe(vip_client, gate, f"http://{os.environ['PUBLIC_VIP_IP']}", f"team1.{domain}")
                final.update({"openstack_server_count": len(final_servers),
                    "only_five_permanent_vms": len(final_servers) == PERMANENT_VM_COUNT and not any(str(x.get("Name", "")).startswith("bench-") for x in final_servers),
                    "bench_ports": [x for x in final_ports if str(x.get("Name", "")).startswith("bench-")],
                    "no_bench_ports": not any(str(x.get("Name", "")).startswith("bench-") for x in final_ports),
                    "bench_sandbox_rows": final_sandbox_rows,
                    "only_released_bench_rows": final_sandbox_rows["only_released_or_allowlisted_stale"],
                    "gateway_baseline_guard": {"passed": final_guard, **final_backends, "errors": final_gateway_errors},
                    "team1_probe": final_team1, "team1_returns_200": final_team1["status"] == 200})
                for gateway, host in (("gw1", "primary"), ("gw2", "standby")):
                    try:
                        remote_host = cfg["safety_gates"]["allowed_gateway_hosts"][host]
                        output = await t2.ssh_remote(cfg, remote_host,
                            "sudo haproxy -c -f /etc/haproxy/haproxy.cfg && "
                            "printf 'BASELINE_BACKENDS=' && grep -Ec '^backend (default_maintenance|team1_backend|team2_backend)$' /etc/haproxy/haproxy.cfg")
                        match = re.search(r"BASELINE_BACKENDS=(\d+)", output)
                        final.setdefault("gateway_validation", {})[gateway] = {
                            "output": output.strip(), "haproxy_config_valid": "Configuration file is valid" in output,
                            "baseline_backend_count": int(match.group(1)) if match else None,
                            "three_baseline_backends": bool(match and int(match.group(1)) == 3)}
                    except Exception as exc:
                        final.setdefault("gateway_validation", {})[gateway] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}
                result["team1_prober"] = {"samples": prober_samples,
                    "during_teardown_drops": sum(sample["status"] == 0 for sample in prober_samples
                        if sample_in_any_teardown(sample, rows.values())),
                    "during_teardown_429": sum(sample["status"] == 429 for sample in prober_samples
                        if sample_in_any_teardown(sample, rows.values())),
                    "during_teardown_other_non_200": sum(sample["status"] not in (0, 200, 429) for sample in prober_samples
                        if sample_in_any_teardown(sample, rows.values()))}
                for row in rows.values():
                    raw_rows.append(row)
                all_complete = all(row.get("status") == "COMPLETED" and row.get("expiry_ttl_matches_default")
                                   and row.get("orphan_count") == 0 and row.get("ip_reclaimed_free_utc")
                                   for row in rows.values())
                final_ok = (final["only_five_permanent_vms"] and final["no_bench_ports"] and
                            final["only_released_bench_rows"] and final_guard and final["team1_returns_200"] and
                            all(x.get("haproxy_config_valid") and x.get("three_baseline_backends")
                                for x in final.get("gateway_validation", {}).values()))
                result["status"] = "PASSED" if all_complete and final_ok else "FAILED"
                result["orphan_count"] = sum(row.get("orphan_count") or 0 for row in rows.values())
                result["final_sanity"]["passed"] = final_ok
    except Exception as exc:
        result["status"] = "NOT EXECUTED" if not result.get("sandbox_ids") else "FAILED"
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        # If execution aborts mid-run, cleanup is scoped to generated bench IDs and sequential.
        if "api" in locals() and result.get("sandbox_ids"):
            cleanup_api = AsyncControlPlaneClient(cfg["control_plane"]["base_url"],
                os.environ.get("ADMIN_TOKEN", ""), timeout=30)
            for sid in result["sandbox_ids"]:
                row = next((item for item in result.get("sandboxes", []) if item.get("sandbox_id") == sid), {})
                if row.get("status") in {"COMPLETED", "RELEASED"} or row.get("fallback_delete") or row.get("exception_cleanup"):
                    continue
                if not sid.startswith("bench-"):
                    continue
                try:
                    code, data = await api_call(cleanup_api, "DELETE", f"/api/sandboxes/{sid}")
                    row.setdefault("exception_cleanup", {"http_status": code, "response": data})
                except Exception as cleanup_exc:
                    row.setdefault("exception_cleanup", {"error": f"{type(cleanup_exc).__name__}: {cleanup_exc}"})
            await cleanup_api.close()
    if not raw_rows:
        raw_rows = list(result.get("sandboxes", []))
    result["raw_rows"] = raw_rows
    return await write_results(result, raw_rows, stamp)


async def write_results(result, rows, stamp):
    RAW.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    csv_path = RAW / f"t5_lease_expiry_{stamp}.csv"
    fields = sorted({key for row in rows for key in row}) or ["sandbox_id", "status", "errors"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
                             for key, value in row.items()})
    chart_path = CHARTS / f"t5_lease_expiry_{stamp}.png"
    fig, axis = plt.subplots(figsize=(10, 5))
    labels = [row.get("sandbox_id", "") for row in rows]
    release_lags = [row.get("expiry_to_released_seconds") for row in rows]
    reclaim_lags = [row.get("ip_reclaim_lag_after_quarantine_seconds") for row in rows]
    x = list(range(len(rows)))
    if rows:
        axis.bar([i - 0.18 for i in x], [v if isinstance(v, (int, float)) else 0 for v in release_lags],
                 width=0.36, label="Expiry to RELEASED (s)")
        axis.bar([i + 0.18 for i in x], [v if isinstance(v, (int, float)) else 0 for v in reclaim_lags],
                 width=0.36, label="Quarantine to FREE lag (s)")
        axis.set_xticks(x, labels, rotation=20, ha="right")
    else:
        axis.text(0.5, 0.5, result.get("status", "NOT EXECUTED"), ha="center", va="center", transform=axis.transAxes)
    axis.set_ylabel("Seconds")
    axis.set_title("T5 expiry teardown and IP reclaim measurements")
    axis.grid(True, axis="y", alpha=0.3)
    axis.legend()
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150)
    plt.close(fig)
    summary_path = RAW / f"t5_lease_expiry_{stamp}_summary.json"
    result["artifacts"] = {"raw_csv": str(csv_path), "summary_json": str(summary_path), "chart": str(chart_path)}
    result["settings"] = env_settings(os.environ.get("DEFAULT_TTL_SECONDS"))
    result.pop("raw_rows", None)
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description="T5 live lease expiry and automated teardown")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(BASE / "config.yaml")
        count = 1 if args.smoke else 5
        if args.dry_run:
            ttl = os.environ.get("DEFAULT_TTL_SECONDS", "unset")
            print(json.dumps({"test": "T5_lease_expiry", "mode": "DRY RUN", "network_calls": False,
                "sandboxes": count, "DEFAULT_TTL_SECONDS": ttl, "maximum_allowed_default_ttl_seconds": 900,
                "control_plane": "http://127.0.0.1:8081", "provision_request_ttl_field": "omitted",
                "settings": env_settings(ttl if ttl != "unset" else None),
                "actions": ["verify five permanent VMs, exact baseline backends on both gateways, and no existing bench-* rows",
                    "barrier-start provision requests without ttl and record allocation/expiry data from read-only SQLite",
                    "probe team1 through the VIP every 200 ms during provisioning and teardown",
                    "wait for reaper events until expires_at + 180 seconds; use sequential DELETE only after timeout",
                    "audit Nova, Neutron, both gateway configs, sandbox/IPAM state, and subdomain after RELEASED",
                    "poll the released IP row read-only each second until FREE and measure lag after quarantine_until",
                    "verify final five-VM, no bench-port, baseline HAProxy, team1 HTTP 200, and RELEASED bench-row sanity",
                    "write per-sandbox CSV, summary JSON, and chart"]}, indent=2))
            return 0
        result = asyncio.run(run(cfg, smoke=args.smoke))
        print(json.dumps({"test": result["test"], "status": result["status"], "settings": result["settings"],
                          "preflight": result.get("preflight"), "final_sanity": result.get("final_sanity"),
                          "artifacts": result.get("artifacts"), "error": result.get("error")}, indent=2))
        return 0 if result["status"] == "PASSED" else 2
    except Exception as exc:
        print(f"T5 NOT EXECUTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
