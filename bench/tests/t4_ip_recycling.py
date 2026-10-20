#!/usr/bin/env python3
"""Measure IP lease quarantine and recycling against an isolated control plane."""
import argparse
import asyncio
import csv
from contextlib import nullcontext
import json
import os
import re
import shutil
import sqlite3
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
from bench.lib.config import load_config
from bench.tests import t2_concurrent_stress as t2

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "results" / "raw"
CHARTS = BASE / "results" / "charts"
POOL_URL = "http://127.0.0.1:8082"
BASELINE_BACKENDS = {"default_maintenance", "team1_backend", "team2_backend"}
SHORT_CYCLES = 20
DEFAULT_CYCLES = 3
SMOKE_SHORT_CYCLES = 2
SMOKE_DEFAULT_CYCLES = 1
RECYCLE_TARGET_SECONDS = 5
RECLAIM_TIMEOUT_SECONDS = 15
DEFAULT_RECLAIM_TIMEOUT_MIN_SECONDS = 120
DEFAULT_RECLAIM_TIMEOUT_MARGIN_SECONDS = 60
REAPER_INTERVAL_SECONDS = 2_000_000_000


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def lease_by_ip(leases, ip_address):
    return next((lease for lease in leases if str(lease.get("ip_address", "")) == ip_address), None)


def quarantine_duration(until, release_time):
    if not until:
        return None
    try:
        parsed = datetime.strptime(until, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return round((parsed - release_time).total_seconds(), 3)


def source_ipam_signature(db_path, cidr):
    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=5) as db:
        rows = db.execute("SELECT ip_address, status, entity_name FROM ip_allocations WHERE subnet_name='sandbox'").fetchall()
    leases = [{"ip_address": ip, "status": status, "entity_name": owner} for ip, status, owner in rows]
    signature_hash, signature_rows = t2.ipam_signature(leases, cidr)
    return signature_hash, signature_rows


def phase_not_executed(cycles, error, expected_to_fail_by_design=False, deadline_seconds=RECLAIM_TIMEOUT_SECONDS):
    return {
        "status": "NOT EXECUTED",
        "n": 0,
        "requested_cycles": cycles,
        "quarantine_state_seen_immediately": 0,
        "negative_control_violations": 0,
        "release_to_free_p50_seconds": None,
        "release_to_free_p95_seconds": None,
        "release_to_free_max_seconds": None,
        "same_ip_reuse_count": 0,
        "allocation_latency_p50_ms": None,
        "allocation_latency_p95_ms": None,
        "errors": [error],
        "429_counts": {"allocate": 0, "release": 0, "reclaim": 0, "read": 0, "total": 0},
        "target": f"IP recycling under {RECYCLE_TARGET_SECONDS} s",
        "target_met": False,
        "expected_to_fail_by_design": expected_to_fail_by_design,
        "quarantine_time_resolution": "1 second",
        "release_to_free_time_resolution": "approximately 1 second (1-second polling)",
        "release_to_free_deadline_seconds": deadline_seconds if cycles else None,
        "cycles": [],
    }


async def get_leases(client, gate, counters):
    status, data = await t2.pool_request_with_retry(client, gate, "GET", "/api/leases", counter=counters["read"])
    if status != 200:
        raise RuntimeError(f"GET /api/leases returned HTTP {status}: {data}")
    return data.get("leases", [])


async def release_lease(client, gate, counters, sandbox_id, cooldown=None):
    body = {"sandbox_id": sandbox_id}
    if cooldown is not None:
        body["cooldown_seconds"] = cooldown
    status, data = await t2.pool_request_with_retry(client, gate, "POST", "/api/leases/release",
        json_body=body, counter=counters["release"], max_429=None)
    if status != 200:
        raise RuntimeError(f"POST /api/leases/release for {sandbox_id} returned HTTP {status}: {data}")
    return data


async def allocate_lease(client, gate, counters, sandbox_id, active_leases):
    started = time.perf_counter()
    status, data = await t2.pool_request_with_retry(client, gate, "POST", "/api/leases/allocate",
        json_body={"sandbox_id": sandbox_id, "ttl_seconds": 3600}, counter=counters["allocate"])
    elapsed_ms = (time.perf_counter() - started) * 1000
    if status not in (200, 201):
        raise RuntimeError(f"POST /api/leases/allocate for {sandbox_id} returned HTTP {status}: {data}")
    ip_address = str(data.get("ip_address", data.get("fixed_ip", "")))
    if not ip_address:
        raise RuntimeError(f"allocation for {sandbox_id} omitted ip_address: {data}")
    active_leases[sandbox_id] = ip_address
    return ip_address, elapsed_ms, data


async def run_cycle(client, gate, counters, phase, cycle_number, stamp, active_leases,
                    cooldown, record_default):
    short_phase = "short" if phase == "short" else "default"
    prefix = f"bench-t4-{stamp.lower()}-{short_phase}-{cycle_number:02d}"
    row = {"phase": phase, "cycle": cycle_number, "status": "RUNNING", "errors": []}
    row["requested_cooldown_seconds"] = cooldown if cooldown is not None else "omitted (control-plane default)"
    try:
        first_id = f"{prefix}-a"
        first_ip, initial_latency, _ = await allocate_lease(client, gate, counters, first_id, active_leases)
        row.update({"initial_sandbox_id": first_id, "initial_ip_address": first_ip,
                    "initial_allocation_latency_ms": initial_latency})

        release_response = await release_lease(client, gate, counters, first_id, cooldown)
        release_time = datetime.now(timezone.utc)
        release_clock = time.monotonic()
        active_leases.pop(first_id, None)
        row["release_response_utc"] = release_time.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        row["release_status"] = release_response.get("status", "")
        row["quarantine_until"] = release_response.get("quarantine_until", "")
        row["quarantine_until_minus_release_seconds"] = quarantine_duration(row["quarantine_until"], release_time)
        row["quarantine_time_resolution"] = "1 second"
        row["release_to_free_time_resolution"] = "approximately 1 second (1-second polling)"

        immediate_leases = await get_leases(client, gate, counters)
        immediate = lease_by_ip(immediate_leases, first_ip)
        row["immediate_status"] = immediate.get("status", "MISSING") if immediate else "MISSING"
        row["quarantine_state_seen_immediately"] = row["immediate_status"] == "QUARANTINED"

        negative_checks = []
        check_times = [0.5] + ([5, 30, 55] if phase == "default" else [])
        quarantine_until = None
        if row["quarantine_until"]:
            try:
                quarantine_until = datetime.strptime(row["quarantine_until"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except ValueError:
                pass
        for check_at in check_times:
            await asyncio.sleep(max(0.0, check_at - (time.monotonic() - release_clock)))
            observed_at = datetime.now(timezone.utc)
            negative_leases = await get_leases(client, gate, counters)
            negative = lease_by_ip(negative_leases, first_ip)
            observed_status = negative.get("status", "MISSING") if negative else "MISSING"
            violation = observed_status == "FREE" and quarantine_until is not None and observed_at < quarantine_until
            negative_checks.append({"target_elapsed_seconds": check_at,
                                   "elapsed_seconds": round(time.monotonic() - release_clock, 3),
                                   "status": observed_status, "violation": violation})
        row["negative_control_checks"] = negative_checks
        row["negative_control_elapsed_seconds"] = negative_checks[0]["elapsed_seconds"]
        row["negative_control_status"] = negative_checks[0]["status"]
        row["negative_control_violation"] = any(check["violation"] for check in negative_checks)

        quarantine_seconds = row["quarantine_until_minus_release_seconds"]
        reclaim_deadline_seconds = (RECLAIM_TIMEOUT_SECONDS if phase == "short" else
            max(DEFAULT_RECLAIM_TIMEOUT_MIN_SECONDS,
                (quarantine_seconds or 0) + DEFAULT_RECLAIM_TIMEOUT_MARGIN_SECONDS))
        row["release_to_free_deadline_seconds"] = reclaim_deadline_seconds
        free_deadline = release_clock + reclaim_deadline_seconds
        next_reclaim_at = release_clock + 1
        row["release_to_free_seconds"] = None
        row["free_state_observed"] = False
        while time.monotonic() < free_deadline:
            await asyncio.sleep(max(0.0, min(next_reclaim_at, free_deadline) - time.monotonic()))
            if time.monotonic() >= free_deadline:
                break
            reclaim_status, reclaim_data = await t2.pool_request_with_retry(client, gate, "POST",
                "/api/leases/reclaim", json_body={}, counter=counters["reclaim"])
            if reclaim_status != 200:
                raise RuntimeError(f"POST /api/leases/reclaim returned HTTP {reclaim_status}: {reclaim_data}")
            leases = await get_leases(client, gate, counters)
            observed = lease_by_ip(leases, first_ip)
            row["last_observed_status"] = observed.get("status", "MISSING") if observed else "MISSING"
            if row["last_observed_status"] == "FREE":
                row["free_state_observed"] = True
                row["release_to_free_seconds"] = round(time.monotonic() - release_clock, 3)
                row["free_observed_utc"] = utc_now()
                break
            next_reclaim_at += 1
        if not row["free_state_observed"]:
            row["errors"].append(f"IP {first_ip} did not reach FREE within {reclaim_deadline_seconds} seconds")

        second_id = f"{prefix}-b"
        second_ip, reuse_latency, _ = await allocate_lease(client, gate, counters, second_id, active_leases)
        row.update({"reallocation_sandbox_id": second_id, "reallocated_ip_address": second_ip,
                    "same_ip_reused": second_ip == first_ip,
                    "reallocation_latency_ms": reuse_latency})
        cleanup_release = await release_lease(client, gate, counters, second_id, 1)
        active_leases.pop(second_id, None)
        row["reallocation_release_status"] = cleanup_release.get("status", "")
        row["reallocation_quarantine_until"] = cleanup_release.get("quarantine_until", "")
        if record_default:
            row["default_quarantine_observed_seconds"] = row["quarantine_until_minus_release_seconds"]
        row["status"] = "FAILED" if row["errors"] else "COMPLETED"
    except Exception as exc:
        row["status"] = "FAILED"
        row["errors"].append(f"{type(exc).__name__}: {exc}")
    return row


async def run_phase(client, gate, phase, cycles, stamp, active_leases, record_default=False):
    counters = {key: [0] for key in ("allocate", "release", "reclaim", "read")}
    rows = []
    for cycle_number in range(1, cycles + 1):
        row = await run_cycle(client, gate, counters, phase, cycle_number, stamp,
                              active_leases, 2 if phase == "short" else None, record_default)
        rows.append(row)
    cleanup_errors = []
    for sandbox_id in list(active_leases):
        try:
            await release_lease(client, gate, counters, sandbox_id, 1)
            active_leases.pop(sandbox_id, None)
        except Exception as exc:
            cleanup_errors.append(f"cleanup release for {sandbox_id}: {type(exc).__name__}: {exc}")
    free_times = [row["release_to_free_seconds"] for row in rows if row.get("release_to_free_seconds") is not None]
    allocation_latencies = [row["reallocation_latency_ms"] for row in rows if row.get("reallocation_latency_ms") is not None]
    errors = [{"cycle": row["cycle"], "errors": row["errors"]} for row in rows if row["errors"]]
    if cleanup_errors:
        errors.append({"cycle": None, "errors": cleanup_errors})
    all_cycles_completed = len(rows) == cycles and all(row["status"] == "COMPLETED" for row in rows)
    target_met = (all_cycles_completed and not cleanup_errors and len(free_times) == cycles and
                  all(value < RECYCLE_TARGET_SECONDS for value in free_times) and
                  all(row.get("quarantine_state_seen_immediately") for row in rows) and
                  all(row.get("release_status") == "QUARANTINED" for row in rows) and
                  not any(row.get("negative_control_violation") for row in rows))
    counts = {key: value[0] for key, value in counters.items()}
    counts["total"] = sum(counts.values())
    return {
        "status": "PASSED" if target_met else "FAILED",
        "n": len(rows),
        "requested_cycles": cycles,
        "quarantine_state_seen_immediately": sum(bool(row.get("quarantine_state_seen_immediately")) for row in rows),
        "negative_control_violations": sum(bool(row.get("negative_control_violation")) for row in rows),
        "release_to_free_p50_seconds": t2.percentile(free_times, 50),
        "release_to_free_p95_seconds": t2.percentile(free_times, 95),
        "release_to_free_max_seconds": max(free_times) if free_times else None,
        "release_to_free_timeout_count": sum("release_response_utc" in row and
                                              not row.get("free_state_observed", False) for row in rows),
        "same_ip_reuse_count": sum(bool(row.get("same_ip_reused")) for row in rows),
        "allocation_latency_p50_ms": t2.percentile(allocation_latencies, 50),
        "allocation_latency_p95_ms": t2.percentile(allocation_latencies, 95),
        "default_quarantine_observed_seconds": [row["quarantine_until_minus_release_seconds"]
            for row in rows if phase == "default" and row.get("quarantine_until_minus_release_seconds") is not None],
        "errors": errors,
        "429_counts": counts,
        "target": f"IP recycling under {RECYCLE_TARGET_SECONDS} s",
        "target_met": target_met,
        "expected_to_fail_by_design": phase == "default",
        "quarantine_time_resolution": "1 second",
        "release_to_free_time_resolution": "approximately 1 second (1-second polling)",
        "release_to_free_deadline_seconds": (RECLAIM_TIMEOUT_SECONDS if phase == "short" else
            max((row.get("release_to_free_deadline_seconds", DEFAULT_RECLAIM_TIMEOUT_MIN_SECONDS)
                 for row in rows), default=DEFAULT_RECLAIM_TIMEOUT_MIN_SECONDS)),
        "release_to_free_deadline_seconds_by_cycle": [row.get("release_to_free_deadline_seconds") for row in rows],
        "cycles": rows,
    }


async def run_isolated_t4(cfg, token, cycles_short, cycles_default, stamp):
    result = {
        "status": "NOT EXECUTED",
        "IP_QUARANTINE_SECONDS_used": "unset",
        "reaper_interval_seconds": REAPER_INTERVAL_SECONDS,
        "live_db_written": False,
        "source_db_signature_before": None,
        "source_db_signature_after": None,
        "source_db_signature_unchanged": None,
        "port_8082_free_before": None,
        "port_8082_free_after": None,
        "temporary_directory_removed": None,
        "phases": {
            "short": phase_not_executed(cycles_short, "isolated control plane did not start"),
            "default": phase_not_executed(cycles_default, "isolated control plane did not start", True),
        },
        "final_sanity": {},
    }
    db_path = None
    cidr = None
    temp_path = None
    temp_dir_obj = None
    try:
        pool_size, cidr, db_path = t2.read_pool_size()
        signature_before, _ = source_ipam_signature(db_path, cidr)
        result["source_db_signature_before"] = signature_before
        result["source_db_path"] = db_path
        result["pool_size_from_control_plane_db"] = pool_size
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        result["error"] = error
        result["phases"] = {
            "short": phase_not_executed(cycles_short, error),
            "default": phase_not_executed(cycles_default, error, True),
        }
        result["port_8082_free_before"] = t2.port_8082_is_free()
        result["port_8082_free_after"] = result["port_8082_free_before"]
        result["temporary_directory_removed"] = True
        result["final_sanity"] = await final_sanity(cfg, result)
        return result

    result["port_8082_free_before"] = t2.port_8082_is_free()
    if not result["port_8082_free_before"]:
        error = "port 8082 already in use"
        result["error"] = error
        result["phases"] = {
            "short": phase_not_executed(cycles_short, error),
            "default": phase_not_executed(cycles_default, error, True),
        }
        result["port_8082_free_after"] = t2.port_8082_is_free()
        try:
            signature_after, _ = source_ipam_signature(db_path, cidr)
            result["source_db_signature_after"] = signature_after
            result["source_db_signature_unchanged"] = signature_after == signature_before
        except Exception as exc:
            result["source_db_signature_error"] = f"{type(exc).__name__}: {exc}"
        result["temporary_directory_removed"] = True
        result["final_sanity"] = await final_sanity(cfg, result)
        return result

    go = shutil.which("go")
    if not go:
        error = "go executable not found; cannot start isolated control plane"
        result["error"] = error
        result["phases"] = {
            "short": phase_not_executed(cycles_short, error),
            "default": phase_not_executed(cycles_default, error, True),
        }
        result["port_8082_free_after"] = t2.port_8082_is_free()
        try:
            signature_after, _ = source_ipam_signature(db_path, cidr)
            result["source_db_signature_after"] = signature_after
            result["source_db_signature_unchanged"] = signature_after == signature_before
        except Exception as exc:
            result["source_db_signature_error"] = f"{type(exc).__name__}: {exc}"
        result["temporary_directory_removed"] = True
        result["final_sanity"] = await final_sanity(cfg, result)
        return result

    proc = None
    log_file = None
    active_leases = {}
    try:
        temp_dir_obj = tempfile.TemporaryDirectory(prefix="felcloud-t4-ip-recycling-", dir="/tmp")
        with nullcontext(temp_dir_obj.name) as tmp:
            temp_path = Path(tmp)
            copy_path = temp_path / "ipam-copy.db"
            log_path = temp_path / "controlplane.log"
            t2.sqlite_backup(db_path, copy_path)
            child_env = os.environ.copy()
            child_env.pop("IP_QUARANTINE_SECONDS", None)
            child_env.update({"IPAM_DB_PATH": str(copy_path), "PORT": "8082", "LISTEN_ADDR": "127.0.0.1",
                              "REAPER_INTERVAL_SECONDS": str(REAPER_INTERVAL_SECONDS),
                              "GOCACHE": "/tmp/felcloud-t2-go-cache"})
            result["isolated_child_environment"] = {
                "IP_QUARANTINE_SECONDS": "unset",
                "REAPER_INTERVAL_SECONDS": child_env["REAPER_INTERVAL_SECONDS"],
            }
            log_file = log_path.open("w", encoding="utf-8")
            proc = subprocess.Popen([go, "run", ".", "serve", "--port", "8082"],
                cwd=Path(__file__).resolve().parents[2] / "controlplane", env=child_env,
                stdout=log_file, stderr=subprocess.STDOUT, text=True, start_new_session=True)
            deadline = time.monotonic() + 180
            start_error = "no HTTP health response received"
            async with httpx.AsyncClient(base_url=POOL_URL,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                         "User-Agent": "FelCloud-T4-Isolated-Recycling"}, timeout=10) as client:
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        start_error = f"isolated control plane exited with status {proc.returncode}: {log_path.read_text(encoding='utf-8', errors='replace').strip()}"
                        break
                    logs = log_path.read_text(encoding="utf-8", errors="replace")
                    if "control-plane gateway API listening on 127.0.0.1:8082" not in logs:
                        await asyncio.sleep(0.25)
                        continue
                    try:
                        health = await client.get("/health")
                        if health.status_code == 200:
                            start_error = ""
                            break
                        start_error = f"HTTP {health.status_code}: {health.text[:1000]}"
                    except httpx.HTTPError as exc:
                        start_error = f"{type(exc).__name__}: {exc}"
                    await asyncio.sleep(0.25)
                if start_error:
                    raise RuntimeError(f"isolated control plane did not start: {start_error}")

                gate = t2.RateGate()
                try:
                    result["phases"]["short"] = await run_phase(client, gate, "short", cycles_short,
                        stamp, active_leases)
                except Exception as exc:
                    detail = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
                    result["phases"]["short"] = phase_not_executed(cycles_short, detail)
                try:
                    result["phases"]["default"] = await run_phase(client, gate, "default", cycles_default,
                        stamp, active_leases, record_default=True)
                except Exception as exc:
                    detail = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
                    result["phases"]["default"] = phase_not_executed(cycles_default, detail, True)
            result["status"] = "EXECUTED"
    except Exception as exc:
        detail = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
        result["error"] = detail
        result["phases"] = {
            "short": phase_not_executed(cycles_short, detail),
            "default": phase_not_executed(cycles_default, detail, True),
        }
    finally:
        try:
            if proc is not None:
                t2.stop_process_group(proc)
        except Exception as exc:
            result["process_group_cleanup_error"] = f"{type(exc).__name__}: {exc}"
        finally:
            if log_file is not None:
                log_file.close()
            if temp_path is not None:
                result["port_8082_free_after"] = t2.port_8082_is_free()
            else:
                result["port_8082_free_after"] = t2.port_8082_is_free()
            if temp_dir_obj is not None:
                try:
                    temp_dir_obj.cleanup()
                except Exception as exc:
                    result["temporary_directory_cleanup_error"] = f"{type(exc).__name__}: {exc}"
    result["temporary_directory_removed"] = temp_path is None or not temp_path.exists()
    try:
        signature_after, _ = source_ipam_signature(db_path, cidr)
        result["source_db_signature_after"] = signature_after
        result["source_db_signature_unchanged"] = signature_after == result["source_db_signature_before"]
    except Exception as exc:
        result["source_db_signature_error"] = f"{type(exc).__name__}: {exc}"
    result["live_db_written"] = False
    result["final_sanity"] = await final_sanity(cfg, result)
    if result["status"] == "NOT EXECUTED" and result.get("error"):
        return result
    if not result["port_8082_free_after"] or not result["temporary_directory_removed"] or not result["source_db_signature_unchanged"]:
        result["status"] = "FAILED"
        result["error"] = "T4 final isolation sanity check failed"
        return result
    if any(not gateway.get("baseline_backends_untouched") or not gateway.get("haproxy_config_valid")
           for gateway in result.get("final_sanity", {}).get("gateways", {}).values()):
        result["status"] = "FAILED"
        result["error"] = "T4 final gateway backend sanity check failed or was not executed"
        return result
    result["status"] = "EXECUTED"
    return result


async def final_sanity(cfg, result):
    sanity = {
        "port_8082_free_after": result.get("port_8082_free_after"),
        "temporary_directory_removed": result.get("temporary_directory_removed"),
        "source_db_signature_unchanged": result.get("source_db_signature_unchanged"),
        "gateways": {},
    }
    gates = cfg.get("safety_gates", {}).get("allowed_gateway_hosts", {})
    for label, key in (("gw1", "primary"), ("gw2", "standby")):
        host = gates.get(key, "")
        if not host:
            sanity["gateways"][label] = {"status": "NOT EXECUTED", "error": f"missing allowed_gateway_hosts.{key}"}
            continue
        try:
            observed = await t2.ssh_remote(cfg, host,
                "sudo haproxy -c -f /etc/haproxy/haproxy.cfg && grep -E '^backend[[:space:]]+' /etc/haproxy/haproxy.cfg")
            names = sorted(re.findall(r"(?m)^backend\s+([^\s#]+)", observed))
            sanity["gateways"][label] = {
                "status": "READ",
                "backend_names": names,
                "baseline_backends_untouched": set(names) == BASELINE_BACKENDS,
                "haproxy_config_valid": "Configuration file is valid" in observed,
            }
        except Exception as exc:
            sanity["gateways"][label] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}
    return sanity


async def write_results(result, rows, stamp):
    RAW.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    csv_path = RAW / f"t4_ip_recycling_{stamp}.csv"
    fields = sorted({key for row in rows for key in row}) or ["phase", "cycle", "status", "errors"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
                             for key, value in row.items()})
    summary_path = RAW / f"t4_ip_recycling_{stamp}_summary.json"
    result["artifacts"] = {"raw_csv": str(csv_path), "summary_json": str(summary_path),
                            "chart": str(CHARTS / f"t4_ip_recycling_{stamp}.png")}
    fig, axes = plt.subplots(2, 1, figsize=(9, 7), sharex=False)
    for axis, phase_name, title in ((axes[0], "short", "Short quarantine (2 s)"),
                                    (axes[1], "default", "Default quarantine (60 s)")):
        phase = result["phases"][phase_name]
        points = [(row["cycle"], row["release_to_free_seconds"]) for row in phase.get("cycles", [])
                  if row.get("release_to_free_seconds") is not None]
        if points:
            axis.plot([point[0] for point in points], [point[1] for point in points], marker="o")
        else:
            axis.text(0.5, 0.5, phase.get("status", "NOT EXECUTED"), ha="center", va="center",
                      transform=axis.transAxes)
        axis.axhline(RECYCLE_TARGET_SECONDS, color="red", linestyle="--", label="under 5 s target")
        axis.set_title(title)
        axis.set_ylabel("Release response to FREE (s)")
        axis.set_xlabel("Cycle")
        axis.grid(True, alpha=0.3)
        axis.legend()
    fig.suptitle("T4 IP recycling: separate phase observations")
    fig.tight_layout()
    fig.savefig(result["artifacts"]["chart"], dpi=150)
    plt.close(fig)
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


async def run(cfg, smoke=False):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short_cycles = SMOKE_SHORT_CYCLES if smoke else SHORT_CYCLES
    default_cycles = SMOKE_DEFAULT_CYCLES if smoke else DEFAULT_CYCLES
    token = os.environ.get("ADMIN_TOKEN", "")
    rows = []
    if not token:
        error = "ADMIN_TOKEN is unset"
        result = {
            "test": "T4_ip_recycling", "status": "NOT EXECUTED", "timestamp_utc": utc_now(),
            "IP_QUARANTINE_SECONDS_used": "unset",
            "phases": {"short": phase_not_executed(short_cycles, error),
                       "default": phase_not_executed(default_cycles, error, True,
                           DEFAULT_RECLAIM_TIMEOUT_MIN_SECONDS)},
            "final_sanity": {"status": "NOT EXECUTED", "error": error},
        }
    else:
        result = await run_isolated_t4(cfg, token, short_cycles, default_cycles, stamp)
        result.update({"test": "T4_ip_recycling", "timestamp_utc": utc_now(),
                       "cycle_plan": {"short": short_cycles, "default": default_cycles},
                       "recycle_target_seconds": RECYCLE_TARGET_SECONDS})
        for phase in ("short", "default"):
            rows.extend(result["phases"][phase].get("cycles", []))
    return await write_results(result, rows, stamp)


def main():
    parser = argparse.ArgumentParser(description="T4 isolated IP quarantine and recycling test")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(BASE / "config.yaml")
        if args.dry_run:
            print(json.dumps({
                "test": "T4_ip_recycling",
                "mode": "DRY RUN",
                "network_calls": False,
                "phases": {
                    "short": {"cycles": SMOKE_SHORT_CYCLES if args.smoke else SHORT_CYCLES,
                              "cooldown_seconds": 2},
                    "default": {"cycles": SMOKE_DEFAULT_CYCLES if args.smoke else DEFAULT_CYCLES,
                                "cooldown_field": "omitted", "IP_QUARANTINE_SECONDS_used": "unset",
                                "control_plane_default_seconds": 60},
                },
                "target": f"IP recycling under {RECYCLE_TARGET_SECONDS} s",
                "isolated_control_plane": POOL_URL,
                "live_control_plane_lease_calls": False,
                "gateway_sync_failover_rollback_or_dpa_calls": False,
                "actions": ["read live DB read-only and record IPAM signature",
                            "sqlite3 .backup the live DB into /tmp",
                            "start isolated control plane with IP_QUARANTINE_SECONDS unset and reaper disabled",
                            "run short and default quarantine cycles as separate datasets",
                            "release quarantine only through isolated /api/leases/reclaim",
                            "short phase: poll release-to-FREE for at most 15 seconds; default phase: poll for max(120 seconds, observed quarantine duration + 60 seconds)",
                            "default phase negative controls: check QUARANTINED at 0.5, 5, 30, and 55 seconds after release",
                            "verify process group stopped, port 8082 free, temp directory removed, live DB signature unchanged, and gateway backends untouched",
                            "write CSV, summary JSON, and separate-phase chart"],
            }, indent=2))
            return 0
        result = asyncio.run(run(cfg, smoke=args.smoke))
        print(json.dumps({"status": result["status"],
                          "phases": {name: {"status": phase["status"], "n": phase["n"],
                                             "target_met": phase["target_met"]}
                                     for name, phase in result["phases"].items()},
                          "port_8082_free_after": result.get("port_8082_free_after"),
                          "temporary_directory_removed": result.get("temporary_directory_removed"),
                          "source_db_signature_unchanged": result.get("source_db_signature_unchanged"),
                          "artifacts": result["artifacts"]}, indent=2))
        return 0 if result["status"] == "EXECUTED" else 2
    except Exception as exc:
        print(f"T4 NOT EXECUTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
