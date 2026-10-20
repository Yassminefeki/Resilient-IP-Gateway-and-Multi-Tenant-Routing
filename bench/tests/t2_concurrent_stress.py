#!/usr/bin/env python3
"""Live concurrent provisioning stress test. No simulated responses are used."""
import argparse
import asyncio
import csv
import hashlib
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bench.lib.api_client import AsyncControlPlaneClient, TimedResponse
from bench.lib.config import load_config

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "results" / "raw"
CHARTS = BASE / "results" / "charts"
LEVELS = [3, 5, 10, 15]
PROTECTED = {"team1", "team2", "jury-demo", "gateways", "bastion"}
TIMEOUT = 420.0
WINDOW = "5"
BASELINE_BACKENDS = {"default_maintenance", "team1_backend", "team2_backend"}
POOL_CONTROL_PLANE_URL = "http://127.0.0.1:8082"


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RateGate:
    """Serialize VIP GET starts to at most five per rolling second."""
    def __init__(self):
        self.lock = asyncio.Lock()
        self.next_at = 0.0

    async def wait(self):
        async with self.lock:
            now = time.monotonic()
            delay = max(0.0, self.next_at - now)
            if delay:
                await asyncio.sleep(delay)
            self.next_at = max(time.monotonic(), self.next_at) + 0.2


def error_text(data):
    if isinstance(data, dict):
        return str(data.get("error") or data.get("detail") or data)
    return str(data)


def parse_api_response(response):
    """Normalize a harness TimedResponse or an httpx Response to status/data."""
    if isinstance(response, TimedResponse):
        return response.status_code, response.data
    try:
        data = response.json()
    except Exception:
        data = {"raw": response.text}
    return response.status_code, data


async def api_json(client, method, path, **kwargs):
    return parse_api_response(await client.request(method, path, **kwargs))


async def probe(client, gate, url, host, timeout=4):
    await gate.wait()
    started = time.perf_counter()
    stamp = utc()
    try:
        r = await client.get(url, headers={"Host": host, "User-Agent": "FelCloud-T2"}, timeout=timeout)
        return {"timestamp_utc": stamp, "status": r.status_code,
                "latency_ms": (time.perf_counter()-started)*1000,
                "body": r.text[:4000], "gateway_id": r.headers.get("X-Gateway-ID", ""), "error": ""}
    except Exception as exc:
        return {"timestamp_utc": stamp, "status": 0,
                "latency_ms": (time.perf_counter()-started)*1000,
                "body": "", "gateway_id": "", "error": f"{type(exc).__name__}: {exc}"}


def identity_matches(body, fixed_ip):
    return bool(fixed_ip and re.search(rf"\b{re.escape(fixed_ip)}\b", body))


def body_ipv4_addresses(body):
    return sorted(set(re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", body)))


def neutron_port_ips(ports, sandbox_ids):
    """Map actual sandbox-<id> Neutron port names back to sandbox IDs."""
    wanted = set(sandbox_ids)
    result = {}
    for port in ports:
        name = str(port.get("Name", ""))
        if not name.startswith("sandbox-"):
            continue
        sandbox_id = name[len("sandbox-"):]
        if sandbox_id not in wanted:
            continue
        addresses = body_ipv4_addresses(str(port))
        if addresses:
            result[sandbox_id] = addresses[0]
    return result


def baseline_backend_guard(configs):
    names = {gateway: sorted(backend_names(content)) for gateway, content in configs.items()}
    differences = {}
    for gateway in ("gw1", "gw2"):
        found = set(names.get(gateway, []))
        differences[gateway] = {
            "missing": sorted(BASELINE_BACKENDS - found),
            "unexpected": sorted(found - BASELINE_BACKENDS),
        }
    valid = set(configs) == {"gw1", "gw2"} and all(
        not diff["missing"] and not diff["unexpected"] for diff in differences.values())
    return valid, {"found": names, "expected": sorted(BASELINE_BACKENDS), "difference": differences}


def sync_failure_events(events):
    failures = []
    for event in events:
        kind = str(event.get("type", "")).upper()
        detail = str(event.get("detail", ""))
        if kind in {"SYNC", "FAILED"} and "gateway_sync" in detail.lower():
            if kind == "FAILED" or re.search(r"error|fail|busy|down|409", detail, re.I):
                failures.append({"sandbox_id": event.get("sandbox_id", ""), "type": event.get("type", ""),
                                 "error_text": detail})
    return failures


def provision_sync_failures(rows):
    failures = []
    for row in rows:
        if row.get("status") != "PROVISION_FAILED":
            continue
        data = row.get("provision_response", {})
        message = error_text(data) if data else "; ".join(row.get("errors", []))
        failures.append({"sandbox_id": row.get("sandbox_id", ""), "status": row.get("status"),
                         "step": data.get("step", "") if isinstance(data, dict) else "",
                         "error_text": message})
    return failures


def is_pool_exhaustion(status, data):
    if status == 429:
        return False
    message = error_text(data)
    return bool(re.search(r"pool.{0,40}exhaust|exhaust.{0,40}pool|all\s+ips?|no\s+(?:free|available)\s+ips?", message, re.I))


def retry_after_seconds(headers):
    value = headers.get("Retry-After", "") if headers else ""
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        if value:
            try:
                return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return 0.2


def ipam_signature(leases, cidr):
    network = ipaddress.ip_network(cidr, strict=False)
    first = int(network.network_address) + 2
    last = int(network.broadcast_address) - 2
    rows_by_ip = {str(row.get("ip_address")): row for row in leases}
    signature = []
    for value in range(first, last + 1):
        address = str(ipaddress.ip_address(value))
        row = rows_by_ip.get(address, {})
        status = str(row.get("status", "FREE")).upper()
        if status not in {"ALLOCATED", "QUARANTINED", "RESERVED"}:
            status = "FREE"
        owner = str(row.get("entity_name", "")) if status != "FREE" else ""
        signature.append((address, status, owner))
    serialized = json.dumps(signature, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest(), signature


def process_environment_values():
    return {key: os.environ.get(key, "unset") for key in
            ("HEALTH_REGRESSION_WINDOW_SECONDS", "GATEWAY_PROBE_TIMEOUT_SECONDS", "RATE_LIMIT_PER_MIN",
             "MAX_CONCURRENT_PROVISIONS", "PROVISION_TIMEOUT_SECONDS")}


PROCESS_ENVIRONMENT = process_environment_values()


def resolve_live_db_path():
    """Resolve only the DB file used by the process listening on localhost:8081."""
    inodes = set()
    for proc_file in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        try:
            lines = proc_file.read_text(encoding="ascii").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) > 9 and fields[1].endswith(":1F91") and fields[3] == "0A":
                inodes.add(fields[9])
    process_dirs = sorted(Path("/proc").glob("[0-9]*"), key=lambda p: int(p.name))
    for process_dir in process_dirs:
        try:
            fd_dir = process_dir / "fd"
            if not any(re.fullmatch(r"socket:\[(\d+)\]", os.readlink(fd)) and
                       re.fullmatch(r"socket:\[(\d+)\]", os.readlink(fd)).group(1) in inodes
                       for fd in fd_dir.iterdir()):
                continue
            environ = (process_dir / "environ").read_bytes().split(b"\0")
            db_value = next((entry.split(b"=", 1)[1].decode() for entry in environ
                             if entry.startswith(b"IPAM_DB_PATH=")), "")
            if db_value:
                if db_value.startswith("file:"):
                    path = Path(unquote(urlsplit(db_value).path)).expanduser().resolve()
                else:
                    path = Path(db_value.split("?", 1)[0]).expanduser().resolve()
            else:
                cwd = Path(os.readlink(process_dir / "cwd"))
                path = cwd / "ipam.db" if (cwd / "ipam.db").is_file() else cwd / "ipam" / "ipam.db"
            if path.is_file():
                return str(path.resolve())
        except (OSError, PermissionError, StopIteration, UnicodeDecodeError):
            continue
    raise RuntimeError("cannot resolve the live control-plane DB file from the process listening on 127.0.0.1:8081")


async def background_probe(client, gate, url, stop, samples):
    target = f"team1.{os.environ.get('ROUTING_DOMAIN', 'cloudpulse.cstam.felcloud.tn')}"
    while not stop.is_set():
        due = time.monotonic()
        samples.append(await probe(client, gate, url, target))
        delay = max(0, 0.2 - (time.monotonic() - due))
        try:
            await asyncio.wait_for(stop.wait(), delay)
        except asyncio.TimeoutError:
            pass


async def fetch_dpa_raw(host, password):
    url = f"http://{host}:5555/v3/services/haproxy/configuration/raw"
    async with httpx.AsyncClient(timeout=15, auth=("admin", password)) as c:
        r = await c.get(url)
        r.raise_for_status()
        return r.text


def backend_names(config):
    return set(re.findall(r"(?m)^backend\s+([^\s#]+)", config))


def read_pool_size():
    """Read the live subnet CIDR from the control-plane SQLite DB without writes."""
    live_path = resolve_live_db_path()
    candidates = [live_path]
    errors = []
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            uri = Path(candidate).resolve().as_uri() + "?mode=ro"
            with sqlite3.connect(uri, uri=True, timeout=5) as db:
                row = db.execute("SELECT cidr FROM subnets WHERE name='sandbox'").fetchone()
            if not row:
                raise RuntimeError("subnets table has no sandbox CIDR row")
            network = ipaddress.ip_network(row[0], strict=False)
            # Mirror the allocator's real dynamic range: network+2 through
            # broadcast-2 inclusive. Existing reservations are still handled
            # by allocating until the control plane returns its real error.
            return max(0, network.num_addresses - 4), str(network), candidate
        except Exception as exc:
            errors.append(f"{candidate}: {type(exc).__name__}: {exc}")
    raise RuntimeError("cannot read real sandbox pool size from control-plane DB read-only; " +
                       ("; ".join(errors) if errors else "no database file found"))


def read_generation_count(db_path):
    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=5) as db:
        row = db.execute("SELECT COUNT(*) FROM config_generations").fetchone()
    if not row:
        raise RuntimeError("config_generations count query returned no row")
    return int(row[0])


async def ssh_remote(cfg, host, remote):
    import subprocess
    ssh = ["ssh", "-i", cfg["openstack"]["ssh_key_path"], "-o", "BatchMode=yes",
           "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
           "-o", "IPQoS=none", "-o", "ConnectTimeout=10", "-J",
           f"{cfg['openstack']['ssh_user']}@{cfg['openstack']['bastion_host']}",
           f"{cfg['openstack']['ssh_user']}@{host}", remote]
    p = await asyncio.to_thread(subprocess.run, ssh, capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip() or f"ssh exited {p.returncode}")
    return p.stdout


async def openstack_json(cloud, *args):
    import subprocess
    cmd = ["openstack", "--os-cloud", cloud, *args, "-f", "json"]
    p = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=60)
    if p.returncode:
        raise RuntimeError(f"{' '.join(cmd)} failed: {(p.stderr or p.stdout).strip()}")
    return json.loads(p.stdout)


async def pool_request_with_retry(client, gate, method, path, *, json_body=None, counter=None, max_429=None):
    retries = 0
    while True:
        await gate.wait()
        response = await client.request(method, path, json=json_body)
        try:
            data = response.json()
        except Exception:
            data = {"raw": response.text}
        if response.status_code != 429:
            return response.status_code, data
        retries += 1
        if counter is not None:
            counter[0] += 1
        if max_429 is not None and retries >= max_429:
            raise RuntimeError(f"HTTP 429 retry limit reached for {path}: {error_text(data)}")
        await asyncio.sleep(retry_after_seconds(response.headers))


def sqlite_backup(source, destination):
    sqlite = shutil.which("sqlite3")
    if not sqlite:
        raise RuntimeError("sqlite3 executable not found; cannot create isolated control-plane DB copy")
    source_path = str(Path(source).resolve())
    destination_path = str(Path(destination).resolve())
    if source_path == destination_path:
        raise RuntimeError("refusing to use the live control-plane DB as the isolated copy")
    proc = subprocess.run([sqlite, "-readonly", source_path], input=f".backup {destination_path}\n.quit\n",
                          capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 or not Path(destination_path).is_file() or Path(destination_path).stat().st_size == 0:
        message = (proc.stderr or proc.stdout).strip() or f"sqlite3 exited with status {proc.returncode}"
        raise RuntimeError(f"sqlite3 .backup failed: {message}")
    return source_path, destination_path


def redact_process_error(message):
    for secret_name in ("ADMIN_TOKEN", "DPA_PASS"):
        secret = os.environ.get(secret_name, "")
        if secret:
            message = message.replace(secret, "[REDACTED]")
    return message


def port_8082_is_free():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("127.0.0.1", 8082))
        except OSError:
            return False
    return True


def stop_process_group(proc):
    pgid = proc.pid
    try:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            proc.poll()
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
    finally:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            pass
        else:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                proc.poll()
                try:
                    os.killpg(pgid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
    if proc.poll() is None:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


async def isolated_pool_exhaustion(cfg, token, pool_capacity, pool_cidr, live_db_path, stamp):
    result = {"status": "NOT EXECUTED", "health_regression_window_seconds": WINDOW,
              "pool_size": pool_capacity, "pool_cidr": pool_cidr,
              "allocated_count": 0, "allocate_429_count": 0, "release_429_count": 0,
              "reclaim_429_count": 0, "read_429_count": 0, "total_429_count": 0,
              "exhaustion_error": "", "error": "",
              "released_all_allocated_leases": False, "ipam_signature_before": None,
              "ipam_signature_after": None, "ipam_signature_matches": False,
              "allocated_set_matches": False, "unexpected_changes": [],
              "release_results": [], "quarantine_wait_seconds": 0,
              "reclaim_calls_during_wait": 0, "starting_ipam_counts": None}
    result["port_8082_free_before"] = port_8082_is_free()
    if not result["port_8082_free_before"]:
        result["error"] = "port 8082 already in use"
        result["temporary_db_deleted"] = True
        result["live_db_written"] = False
        result["port_8082_free_after"] = port_8082_is_free()
        return result
    go = shutil.which("go")
    if not go:
        result["error"] = "go executable not found; cannot start isolated control plane"
        result["temporary_db_deleted"] = True
        result["live_db_written"] = False
        result["port_8082_free_after"] = port_8082_is_free()
        return result

    with tempfile.TemporaryDirectory(prefix="felcloud-t2-pool-", dir="/tmp") as tmp:
        copy_path = str(Path(tmp) / "ipam-copy.db")
        log_path = Path(tmp) / "controlplane.log"
        proc = None
        log_file = None
        started = False
        allocated = []
        release_counter = [0]
        reclaim_counter = [0]
        allocate_counter = [0]
        read_counter = [0]
        signature_before = None
        signature_before_rows = []
        operation_error = ""
        exhausted_response = None
        try:
            source_path, copy_path = sqlite_backup(live_db_path, copy_path)
            env = os.environ.copy()
            env.update({"IPAM_DB_PATH": copy_path, "PORT": "8082", "LISTEN_ADDR": "127.0.0.1",
                        "REAPER_INTERVAL_SECONDS": str(2_000_000_000),
                        "GOCACHE": "/tmp/felcloud-t2-go-cache"})
            if str(Path(env["IPAM_DB_PATH"]).resolve()) != str(Path(copy_path).resolve()):
                raise RuntimeError("isolated control plane DB path did not resolve to the temporary copy")
            log_file = log_path.open("w", encoding="utf-8")
            proc = subprocess.Popen([go, "run", ".", "serve", "--port", "8082"],
                                    cwd=Path(__file__).resolve().parents[2] / "controlplane",
                                    env=env, stdout=log_file, stderr=subprocess.STDOUT, text=True,
                                    start_new_session=True)
            deadline = time.monotonic() + 180
            last_health_error = "no HTTP health response received"
            async with httpx.AsyncClient(base_url=POOL_CONTROL_PLANE_URL,
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                             "User-Agent": "FelCloud-T2-Isolated-Pool"}, timeout=10) as client:
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise RuntimeError(f"isolated control plane exited with status {proc.returncode}: {log_path.read_text(encoding='utf-8', errors='replace').strip()}")
                    server_log = log_path.read_text(encoding="utf-8", errors="replace")
                    if "control-plane gateway API listening on 127.0.0.1:8082" not in server_log:
                        await asyncio.sleep(0.25)
                        continue
                    try:
                        health = await client.get("/health")
                        if health.status_code == 200:
                            started = True
                            break
                        last_health_error = f"HTTP {health.status_code}: {health.text[:1000]}"
                    except httpx.HTTPError as exc:
                        last_health_error = f"{type(exc).__name__}: {exc}"
                    await asyncio.sleep(0.25)
                if not started:
                    raise RuntimeError(f"isolated control plane did not become healthy within 180 seconds; last result: {last_health_error}; log: {log_path.read_text(encoding='utf-8', errors='replace').strip()}")

                gate = RateGate()
                code, data = await pool_request_with_retry(client, gate, "POST", "/api/leases/reclaim", json_body={}, counter=reclaim_counter)
                if code != 200:
                    raise RuntimeError(f"initial isolated lease reclaim returned HTTP {code}: {error_text(data)}")
                code, data = await pool_request_with_retry(client, gate, "GET", "/api/leases", counter=read_counter)
                if code != 200:
                    raise RuntimeError(f"isolated starting lease read returned HTTP {code}: {error_text(data)}")
                starting_leases = data.get("leases", [])
                before_hash, signature_before_rows = ipam_signature(starting_leases, pool_cidr)
                quarantine_count = sum(1 for _ip, state, _owner in signature_before_rows if state == "QUARANTINED")
                quarantine_wait_started = time.monotonic()
                drain_deadline = quarantine_wait_started + 90
                try:
                    while quarantine_count and time.monotonic() < drain_deadline:
                        await asyncio.sleep(min(5, max(0, drain_deadline - time.monotonic())))
                        if time.monotonic() >= drain_deadline:
                            break
                        result["reclaim_calls_during_wait"] += 1
                        reclaim_code, reclaim_data = await pool_request_with_retry(client, gate, "POST",
                            "/api/leases/reclaim", json_body={}, counter=reclaim_counter)
                        if reclaim_code != 200:
                            raise RuntimeError(f"isolated quarantine-wait reclaim returned HTTP {reclaim_code}: {error_text(reclaim_data)}")
                        code, data = await pool_request_with_retry(client, gate, "GET", "/api/leases", counter=read_counter)
                        if code != 200:
                            raise RuntimeError(f"isolated starting lease read returned HTTP {code}: {error_text(data)}")
                        starting_leases = data.get("leases", [])
                        before_hash, signature_before_rows = ipam_signature(starting_leases, pool_cidr)
                        quarantine_count = sum(1 for _ip, state, _owner in signature_before_rows if state == "QUARANTINED")
                finally:
                    result["quarantine_wait_seconds"] = round(time.monotonic() - quarantine_wait_started, 3)
                    result["starting_ipam_counts"] = {
                        state: sum(1 for _ip, row_state, _owner in signature_before_rows if row_state == state)
                        for state in ("ALLOCATED", "QUARANTINED", "RESERVED", "FREE")}
                if quarantine_count:
                    operation_error = "starting quarantine did not drain"
                result["ipam_signature_before"] = before_hash
                safety_bound = pool_capacity + 5
                for index in range(1, (safety_bound if not operation_error else 0) + 1):
                    sandbox_id = f"bench-t2-pool-{stamp.lower()}-{index:03d}"
                    try:
                        code, data = await pool_request_with_retry(client, gate, "POST", "/api/leases/allocate",
                            json_body={"sandbox_id": sandbox_id, "ttl": 3600}, counter=allocate_counter)
                        if code in (200, 201):
                            ip = str(data.get("ip_address", data.get("fixed_ip", "")))
                            allocated.append((sandbox_id, ip))
                            if not ip:
                                operation_error = f"successful allocation for {sandbox_id} omitted ip_address: {data}"
                                break
                            continue
                        if is_pool_exhaustion(code, data):
                            exhausted_response = {"http_status": code, "error": error_text(data), "response": data}
                        else:
                            operation_error = f"allocation returned non-exhaustion HTTP {code}: {error_text(data)}"
                        break
                    except Exception as exc:
                        operation_error = f"{type(exc).__name__}: {exc}"
                        break
                else:
                    if not operation_error:
                        operation_error = f"pool exhaustion was not observed within safety bound pool_size + 5 ({safety_bound})"

                result["allocated_count"] = len(allocated)
                result["allocation_safety_bound"] = safety_bound
                result["allocate_429_count"] = allocate_counter[0]
                result["read_429_count"] = read_counter[0]
                result["exhaustion_response"] = exhausted_response or "NOT EXECUTED"
                if operation_error:
                    result["error"] = operation_error

                # Release every successful allocation in finally, including if a later operation fails.
                try:
                    for sandbox_id, ip in allocated:
                        entry = {"sandbox_id": sandbox_id, "ip_address": ip}
                        try:
                            release_code, release_data = await pool_request_with_retry(client, gate, "POST",
                                "/api/leases/release", json_body={"sandbox_id": sandbox_id,
                                    "ip_address": ip, "cooldown_seconds": 1}, counter=release_counter,
                                max_429=None)
                            entry.update({"http_status": release_code,
                                          "error": "" if release_code == 200 else error_text(release_data)})
                        except Exception as exc:
                            entry["error"] = f"{type(exc).__name__}: {exc}"
                        result["release_results"].append(entry)
                finally:
                    result["released_all_allocated_leases"] = (
                        len(result["release_results"]) == len(allocated) and
                        all(not entry.get("error") for entry in result["release_results"]))
                    result["release_429_count"] = release_counter[0]
                    await asyncio.sleep(2)
                    try:
                        reclaim_code, reclaim_data = await pool_request_with_retry(client, gate, "POST",
                            "/api/leases/reclaim", json_body={}, counter=reclaim_counter)
                        if reclaim_code != 200 and not result["error"]:
                            result["error"] = f"isolated lease reclaim returned HTTP {reclaim_code}: {error_text(reclaim_data)}"
                    except Exception as exc:
                        if not result["error"]:
                            result["error"] = f"isolated lease reclaim failed: {type(exc).__name__}: {exc}"
                    result["reclaim_429_count"] = reclaim_counter[0]
                    try:
                        end_code, end_data = await pool_request_with_retry(client, gate, "GET", "/api/leases", counter=read_counter)
                        if end_code == 200:
                            after_hash, after_rows = ipam_signature(end_data.get("leases", []), pool_cidr)
                            result["ipam_signature_after"] = after_hash
                            result["ending_ipam_counts"] = {
                                state: sum(1 for _ip, row_state, _owner in after_rows if row_state == state)
                                for state in ("ALLOCATED", "QUARANTINED", "RESERVED", "FREE")}
                            result["ipam_signature_matches"] = after_hash == before_hash
                            before_by_ip = {ip: (state, owner) for ip, state, owner in signature_before_rows}
                            after_by_ip = {ip: (state, owner) for ip, state, owner in after_rows}
                            before_allocated = {(ip, owner) for ip, (state, owner) in before_by_ip.items()
                                                if state == "ALLOCATED"}
                            after_allocated = {(ip, owner) for ip, (state, owner) in after_by_ip.items()
                                               if state == "ALLOCATED"}
                            result["allocated_set_matches"] = before_allocated == after_allocated
                            result["unexpected_changes"] = sorted(
                                ip for ip in before_by_ip.keys() | after_by_ip.keys()
                                if before_by_ip.get(ip, ("FREE", ""))[0] != after_by_ip.get(ip, ("FREE", ""))[0])
                        elif not result["error"]:
                            result["error"] = f"isolated ending lease read returned HTTP {end_code}: {error_text(end_data)}"
                    except Exception as exc:
                        if not result["error"]:
                            result["error"] = f"isolated ending lease read failed: {type(exc).__name__}: {exc}"
                if not exhausted_response and not result["error"]:
                    result["error"] = f"No pool exhaustion response within safety bound pool_size + 5 ({safety_bound})"
                result["status"] = ("PASSED" if exhausted_response and result["released_all_allocated_leases"]
                                    and result["allocated_set_matches"]
                                    and result.get("ending_ipam_counts", {}).get("QUARANTINED") == 0
                                    and not result["error"] else "FAILED")
                result["exhaustion_error"] = exhausted_response.get("error", "") if exhausted_response else ""
                result["source_db_backup"] = source_path
                result["isolated_db_path"] = copy_path
        except Exception as exc:
            detail = redact_process_error(f"{type(exc).__name__}: {exc}")
            result["error"] = detail
            result["status"] = "FAILED" if started else "NOT EXECUTED"
            if not started:
                result["startup_error"] = detail
        finally:
            try:
                if proc is not None:
                    stop_process_group(proc)
            except Exception as exc:
                result["process_group_cleanup_error"] = f"{type(exc).__name__}: {exc}"
                if result["status"] == "PASSED":
                    result["status"] = "FAILED"
                    if not result["error"]:
                        result["error"] = "isolated control plane process-group cleanup failed"
            finally:
                if log_file is not None:
                    log_file.close()
                deadline = time.monotonic() + 5
                port_free = port_8082_is_free()
                while not port_free and time.monotonic() < deadline:
                    time.sleep(0.1)
                    port_free = port_8082_is_free()
                result["port_8082_free_after"] = port_free
                if not port_free:
                    result["status"] = "FAILED"
                    if not result["error"]:
                        result["error"] = "port 8082 still in use after isolated control plane cleanup"
        result["allocate_429_count"] = allocate_counter[0]
        result["release_429_count"] = release_counter[0]
        result["reclaim_429_count"] = reclaim_counter[0]
        result["read_429_count"] = read_counter[0]
        result["total_429_count"] = sum((allocate_counter[0], release_counter[0], reclaim_counter[0], read_counter[0]))
    # TemporaryDirectory removes the copied database only after the server exits.
    result["temporary_db_deleted"] = not Path(copy_path).exists()
    result["live_db_written"] = False
    return result


async def run(cfg, smoke=False, bursts=None, skip_pool=False):
    env_snapshot = dict(PROCESS_ENVIRONMENT)
    cp = cfg["control_plane"]
    net = cfg["network"]
    token = os.environ.get("ADMIN_TOKEN", "")
    vip = str(net.get("public_vip", ""))
    domain = str(net.get("domain", ""))
    if not token or not vip or not domain:
        missing = [name for name, value in (("ADMIN_TOKEN", token), ("PUBLIC_VIP_IP", vip), ("ROUTING_DOMAIN", domain)) if not value]
        raise RuntimeError("missing required configuration: " + ", ".join(missing))
    if domain != "cloudpulse.cstam.felcloud.tn":
        raise RuntimeError(f"ROUTING_DOMAIN must be cloudpulse.cstam.felcloud.tn (got {domain!r})")
    if os.environ.get("DPA_PASS", "") == "":
        raise RuntimeError("DPA_PASS is unset")
    gates = cfg.get("safety_gates", {})
    hosts = gates.get("allowed_gateway_hosts", {})
    primary, standby = hosts.get("primary", ""), hosts.get("standby", "")
    ssh_cfg = cfg.get("openstack", {})
    if not primary or not standby or primary == standby:
        raise RuntimeError("BENCH_PRIMARY_HOST and BENCH_STANDBY_HOST must be distinct configured SSH destinations")
    host_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    if not host_pattern.fullmatch(primary) or not host_pattern.fullmatch(standby) or not host_pattern.fullmatch(ssh_cfg.get("bastion_host", "")):
        raise RuntimeError("gateway and bastion SSH destinations contain unsupported characters")
    if not ssh_cfg.get("bastion_host") or not ssh_cfg.get("ssh_key_path") or not Path(ssh_cfg["ssh_key_path"]).is_file():
        raise RuntimeError("BENCH_BASTION_HOST and a readable SSH_KEY_PATH are required for gateway sanity checks")
    if gates.get("resource_prefix") != "bench-" or gates.get("cleanup_name_prefix") != "bench-":
        raise RuntimeError("benchmark cleanup prefixes must both be exactly bench-")
    cap = int(os.environ.get("BENCH_MAX_CONCURRENCY", "15"))
    if cap < 1 or cap > 15:
        raise RuntimeError(f"BENCH_MAX_CONCURRENCY must be 1..15 (got {cap})")
    levels = [2] if smoke else (bursts if bursts is not None else LEVELS)
    if max(levels) > cap:
        raise RuntimeError(f"T2 requires concurrency 15, but BENCH_MAX_CONCURRENCY={cap}")
    os.environ["HEALTH_REGRESSION_WINDOW_SECONDS"] = WINDOW
    probe_url = f"http://{vip.strip().removeprefix('http://').removesuffix('/')}"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RAW.mkdir(parents=True, exist_ok=True); CHARTS.mkdir(parents=True, exist_ok=True)
    result = {"test": "T2_concurrent_stress", "status": "EXECUTED", "timestamp_utc": utc(),
              "health_regression_window_seconds": WINDOW, "max_concurrency": cap,
              "process_environment": env_snapshot,
              **env_snapshot,
              "probe_rate_limit_per_second": 5, "bursts": [], "pool_exhaustion": {},
              "final_sanity": {}}
    all_rows = []
    gate = RateGate()
    async with AsyncControlPlaneClient(cp["base_url"], token, timeout=TIMEOUT) as api, \
               httpx.AsyncClient(timeout=8, follow_redirects=False) as vip_client:
        status, health = await api_json(api, "GET", "/health")
        if status != 200:
            raise RuntimeError(f"control plane /health returned HTTP {status}: {health}")
        pool_capacity, pool_cidr, pool_db = read_pool_size()

        for burst_n in levels:
            burst_id = f"bench-t2-{stamp.lower()}-{burst_n}"
            ids = [f"{burst_id}-{i:02d}" for i in range(1, burst_n+1)]
            rows = {name: {"sandbox_id": name, "burst_size": burst_n, "status": "PENDING",
                           "success": False, "post_started_utc": "", "post_first_http_200_ms": None,
                           "stages_ms": {}, "errors": [], "http_statuses": []} for name in ids}
            created = []
            gen_before = None
            gen_after = None
            burst_start_ms = int(time.time()*1000)
            baseline_configs = {}
            baseline_errors = {}
            for label, host in (("gw1", "127.0.0.11"), ("gw2", "127.0.0.12")):
                try:
                    baseline_configs[label] = await fetch_dpa_raw(host, os.environ["DPA_PASS"])
                except Exception as exc:
                    baseline_errors[label] = f"{type(exc).__name__}: {exc}"
            baseline_ok, baseline_names = baseline_backend_guard(baseline_configs)
            if not baseline_ok:
                result["status"] = "NOT EXECUTED" if not result["bursts"] else "PARTIAL"
                result["aborted_before_burst"] = {"burst_size": burst_n,
                    "status": "NOT EXECUTED", "backend_names_found": baseline_names["found"],
                    "backend_names_expected": baseline_names["expected"],
                    "backend_names_difference": baseline_names["difference"],
                    "gateway_errors": baseline_errors,
                    "error": "both gateways must have exactly the 3 baseline backends before a burst"}
                all_rows.append({"timestamp_utc": utc(), "burst_size": burst_n,
                    "status": "NOT EXECUTED", "error": result["aborted_before_burst"]["error"],
                    "backend_names_found": baseline_names["found"],
                    "backend_names_expected": baseline_names["expected"],
                    "backend_names_difference": baseline_names["difference"],
                    "gateway_errors": baseline_errors})
                break
            try:
                try:
                    gen_before = read_generation_count(pool_db)
                except Exception as exc:
                    gen_before = f"NOT EXECUTED: {type(exc).__name__}: {exc}"
                barrier = asyncio.Event()
                async def provision(name):
                    row = rows[name]
                    await barrier.wait()
                    row["post_started_utc"] = utc()
                    started = time.perf_counter()
                    try:
                        r = await api.provision_sandbox(name, ttl=3600, custom_domain=f"{name}.{domain}")
                        created.append(name)
                        row["provision_http_status"] = r.status_code
                        row["provision_response"] = r.data
                        row["provision_elapsed_ms"] = r.elapsed_seconds*1000
                        timings = r.data.get("timings_ms", {})
                        row["stages_ms"] = timings if isinstance(timings, dict) else {}
                        if r.status_code not in (200, 201):
                            row["status"] = "PROVISION_FAILED"
                            row["errors"].append(error_text(r.data))
                            return
                        row["fixed_ip"] = r.data.get("fixed_ip", "")
                        row["status"] = "WAITING_FOR_HTTP_200"
                        deadline = time.monotonic()+TIMEOUT
                        while time.monotonic() < deadline:
                            p = await probe(vip_client, gate, probe_url, f"{name}.{domain}")
                            row["http_statuses"].append(p["status"])
                            if p["status"] == 200:
                                row["post_first_http_200_ms"] = (time.perf_counter()-started)*1000
                                row["first_http_200_utc"] = p["timestamp_utc"]
                                row["body_ips_found"] = body_ipv4_addresses(p["body"])
                                row["identity_ok"] = identity_matches(p["body"], row["fixed_ip"])
                                row["gateway_id"] = p["gateway_id"]
                                row["success"] = row["identity_ok"]
                                row["status"] = "SUCCESS" if row["success"] else "MISROUTED_CONTENT"
                                if not row["success"]:
                                    row["errors"].append("HTTP 200 body did not contain its fixed IP")
                                return
                        row["status"] = "HTTP_200_TIMEOUT"
                        row["errors"].append("HTTP 200 not observed before 420-second deadline")
                    except Exception as exc:
                        row["status"] = "ERROR"
                        row["errors"].append(f"{type(exc).__name__}: {exc}")
                tasks = [asyncio.create_task(provision(name)) for name in ids]
                barrier.set()
                stop = asyncio.Event(); team_samples = []
                prober = asyncio.create_task(background_probe(vip_client, gate, probe_url, stop, team_samples))
                await asyncio.gather(*tasks)
                stop.set(); await prober

                # Real read-only observations from both DPA raw configs.
                dpa = {}
                for label, host in (("gw1", "127.0.0.11"), ("gw2", "127.0.0.12")):
                    try:
                        raw = await fetch_dpa_raw(host, os.environ["DPA_PASS"])
                        names = backend_names(raw)
                        dpa[label] = {"status": "READ", "backend_names": sorted(names),
                                      "sandbox_backend_present": {name: f"{name}_backend" in names for name in ids}}
                    except Exception as exc:
                        dpa[label] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}

                # Lease/IPAM and Neutron port observations.
                leases_status, lease_data = await api_json(api, "GET", "/api/leases")
                lease_rows = lease_data.get("leases", []) if leases_status == 200 else []
                bench_ipam = {x.get("entity_name"): x.get("ip_address") for x in lease_rows
                              if x.get("entity_name") in ids and x.get("status") == "ALLOCATED"}
                try:
                    ports = await openstack_json(cfg["openstack"]["cloud"], "port", "list")
                    port_ips = neutron_port_ips(ports, ids)
                    ports_observation = {"status": "READ", "ips": port_ips}
                except Exception as exc:
                    port_ips = {}
                    ports_observation = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}
                ip_values = [v for k, v in bench_ipam.items() if k not in {"team1", "team2"}]
                duplicates = sorted({ip for ip in ip_values if ip_values.count(ip) > 1})
                port_ip_values = list(port_ips.values())
                duplicate_port_ips = sorted({ip for ip in port_ip_values if port_ip_values.count(ip) > 1})

                # Events are the control plane's gateway sync error log when available.
                ev_status, ev_data = await api_json(api, "GET", f"/api/gateways/events?since={burst_start_ms}&limit=500")
                events = ev_data.get("events", []) if ev_status == 200 else []
                sync_failures = sync_failure_events(events)
                provision_failures = provision_sync_failures(list(rows.values()))
                try:
                    gen_after = read_generation_count(pool_db)
                except Exception as exc:
                    gen_after = f"NOT EXECUTED: {type(exc).__name__}: {exc}"

                for name, row in rows.items():
                    row["dpa_backend_both"] = all(dpa.get(g, {}).get("sandbox_backend_present", {}).get(name, False) for g in ("gw1", "gw2"))
                    row["ipam_ip"] = bench_ipam.get(name, "")
                    row["neutron_ip"] = port_ips.get(name, "")
                    row["duplicate_ip"] = bool(row["ipam_ip"] and row["ipam_ip"] in duplicates)
                    row["ipam_neutron_match"] = bool(row["ipam_ip"] and row["ipam_ip"] == row["neutron_ip"])
                    if name in created and row["status"] == "SUCCESS" and not row["dpa_backend_both"]:
                        row["errors"].append("backend absent from at least one DPA raw config")
                    all_rows.append(row)

                # Cleanup only names generated in this burst; never global cleanup.
                cleanup = []
                for name in ids:
                    if not name.startswith("bench-") or name in PROTECTED:
                        continue
                    try:
                        s, data = await api_json(api, "DELETE", f"/api/sandboxes/{name}")
                        cleanup.append({"sandbox_id": name, "status_code": s, "error": "" if s in (200, 202, 204, 404) else error_text(data)})
                    except Exception as exc:
                        cleanup.append({"sandbox_id": name, "error": f"{type(exc).__name__}: {exc}"})
                await asyncio.sleep(12)
                chk_s, chk_data = await api_json(api, "GET", "/api/sandboxes")
                remaining = [x for x in chk_data.get("sandboxes", []) if x.get("team", x.get("name", "")) in ids] if chk_s == 200 else None
                result["bursts"].append({"burst_size": burst_n, "sandbox_ids": ids,
                    "successes": sum(bool(x["success"]) for x in rows.values()), "failures": sum(not x["success"] for x in rows.values()),
                    "success_rate": sum(bool(x["success"]) for x in rows.values())/burst_n,
                    "p50_provisioning_seconds": percentile([x["post_first_http_200_ms"]/1000 for x in rows.values() if x["post_first_http_200_ms"] is not None], 50),
                    "p95_provisioning_seconds": percentile([x["post_first_http_200_ms"]/1000 for x in rows.values() if x["post_first_http_200_ms"] is not None], 95),
                    "gateway_configs": dpa,
                    "ipam_neutron": {"ipam": bench_ipam, "neutron_ports": ports_observation,
                                     "duplicate_ip_addresses_in_ipam": duplicates,
                                     "duplicate_ip_addresses_in_neutron_ports": duplicate_port_ips,
                                     "team1_team2_drift_excluded": True},
                    "gateway_sync": {"events_status": ev_status, "failures": sync_failures,
                                     "provision_failed_rows": provision_failures,
                                     "failure_count": len(sync_failures) + len(provision_failures),
                                     "config_generations_count_before": gen_before,
                                     "config_generations_count_after": gen_after,
                                     "push_count_delta": (gen_after-gen_before if isinstance(gen_before, int) and isinstance(gen_after, int) else "NOT EXECUTED")},
                    "team1_prober": {"samples": team_samples, "non_200_count": sum(x["status"] not in (200, 429) for x in team_samples),
                                     "http_429_count": sum(x["status"] == 429 for x in team_samples),
                                     "dropped_count": sum(x["status"] == 0 for x in team_samples)},
                    "cleanup": cleanup, "cleanup_remaining_sandboxes": remaining,
                    "sandbox_rows": list(rows.values())})
            except Exception as exc:
                # Even a failed observation must not strand this burst's VMs.
                cleanup_errors = []
                for name in ids:
                    if not name.startswith("bench-") or name in PROTECTED:
                        continue
                    try:
                        code, data = await api_json(api, "DELETE", f"/api/sandboxes/{name}")
                        cleanup_errors.append({"sandbox_id": name, "status_code": code,
                                               "error": "" if code in (200, 202, 204, 404) else error_text(data)})
                    except Exception as cleanup_exc:
                        cleanup_errors.append({"sandbox_id": name,
                            "error": f"{type(cleanup_exc).__name__}: {cleanup_exc}"})
                for row in rows.values():
                    if row["status"] == "PENDING":
                        row["status"] = "NOT EXECUTED"
                        row["errors"].append(f"burst observation failed: {type(exc).__name__}: {exc}")
                    all_rows.append(row)
                result["bursts"].append({"burst_size": burst_n, "status": "PARTIAL",
                    "error": f"{type(exc).__name__}: {exc}", "cleanup": cleanup_errors,
                    "sandbox_rows": list(rows.values()), "team1_prober": {"status": "NOT EXECUTED"}})

        if skip_pool:
            result["pool_exhaustion"] = {"status": "NOT EXECUTED", "error": "skipped by --skip-pool"}
        elif "aborted_before_burst" in result:
            result["pool_exhaustion"] = {"status": "NOT EXECUTED",
                "error": "test stopped by the baseline-backend guard before provisioning"}
        if "aborted_before_burst" in result:
            result["final_sanity"] = {"status": "NOT EXECUTED",
                "error": "test stopped by the baseline-backend guard before provisioning"}
        else:
            if not skip_pool:
                # Pool exhaustion runs only on a separate process and SQLite backup copy.
                result["pool_exhaustion"] = await isolated_pool_exhaustion(
                    cfg, token, pool_capacity, pool_cidr, pool_db, stamp)

            # Final checks use real OpenStack/API/SSH observations.
            final = result["final_sanity"]
            try:
                servers = await openstack_json(cfg["openstack"]["cloud"], "server", "list")
                final["openstack_server_list"] = {"status": "READ", "count": len(servers), "servers": servers,
                                                  "only_five_permanent_vms": len(servers) == 5 and not any(str(x.get("Name", "")).startswith("bench-") for x in servers)}
            except Exception as exc:
                final["openstack_server_list"] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}
            try:
                ports = await openstack_json(cfg["openstack"]["cloud"], "port", "list")
                final["bench_ports"] = [x for x in ports if str(x.get("Name", "")).startswith("bench-")]
            except Exception as exc:
                final["bench_ports"] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}
            ss, sd = await api_json(api, "GET", "/api/sandboxes")
            final["active_bench_sandboxes"] = ([x for x in sd.get("sandboxes", []) if str(x.get("sandbox_id", x.get("team", x.get("name", "")))).startswith("bench-") and x.get("status", x.get("state")) in ("ACTIVE", "PROVISIONING", "TEARING_DOWN")] if ss == 200 else {"status": "NOT EXECUTED", "http_status": ss, "error": sd})
            for label, host in (("gw1", "127.0.0.11"), ("gw2", "127.0.0.12")):
                try:
                    command = ("sudo haproxy -c -f /etc/haproxy/haproxy.cfg && "
                               "printf 'BASELINE_BACKENDS=' && "
                               "grep -Ec '^backend (team1|team2|jury-demo)_backend$' /etc/haproxy/haproxy.cfg")
                    observed = await ssh_remote(cfg, cfg["safety_gates"]["allowed_gateway_hosts"]["primary" if label == "gw1" else "standby"], command)
                    match = re.search(r"BASELINE_BACKENDS=(\d+)", observed)
                    final.setdefault("gateway_validation", {})[label] = {"output": observed.strip(),
                        "haproxy_config_valid": "Configuration file is valid" in observed,
                        "baseline_backend_count": int(match.group(1)) if match else None,
                        "three_baseline_backends": bool(match and int(match.group(1)) == 3)}
                except Exception as exc:
                    final.setdefault("gateway_validation", {})[label] = {"status": "NOT EXECUTED", "error": f"{type(exc).__name__}: {exc}"}

    result["pool_exhaustion_status"] = result["pool_exhaustion"].get("status", "NOT EXECUTED")
    result["pool_exhaustion_reason"] = (result["pool_exhaustion"].get("error", "")
                                        if result["pool_exhaustion_status"] == "NOT EXECUTED" else "")
    raw_path = RAW / f"t2_concurrent_{stamp}.csv"
    fields = sorted({k for row in all_rows for k in row})
    with raw_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader()
        for row in all_rows: w.writerow({k: json.dumps(v, sort_keys=True) if isinstance(v, (dict,list)) else v for k,v in row.items()})
    summary_path = RAW / f"t2_concurrent_{stamp}_summary.json"
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str)+"\n", encoding="utf-8")
    chart_path = CHARTS / f"t2_concurrent_{stamp}.png"
    fig, axes = plt.subplots(2, 1, figsize=(9, 7), sharex=True)
    burst_rows = result["bursts"]
    axes[0].plot([x["burst_size"] for x in burst_rows], [x["success_rate"]*100 for x in burst_rows], marker="o")
    axes[0].set_ylabel("Success rate (%)"); axes[0].set_ylim(0, 100); axes[0].grid(True, alpha=.3)
    axes[1].plot([x["burst_size"] for x in burst_rows], [x["p50_provisioning_seconds"] for x in burst_rows], marker="o", label="p50")
    axes[1].plot([x["burst_size"] for x in burst_rows], [x["p95_provisioning_seconds"] for x in burst_rows], marker="o", label="p95")
    axes[1].set_xlabel("Concurrent requests"); axes[1].set_ylabel("Provisioning time (s)"); axes[1].grid(True, alpha=.3); axes[1].legend()
    fig.suptitle("T2 concurrent stress: observed results"); fig.tight_layout(); fig.savefig(chart_path, dpi=150); plt.close(fig)
    result["artifacts"] = {"raw_csv": str(raw_path), "summary_json": str(summary_path), "chart": str(chart_path)}
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str)+"\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "bursts": [{"n": x["burst_size"], "success": x["successes"], "failed": x["failures"]} for x in result["bursts"]],
                      "HEALTH_REGRESSION_WINDOW_SECONDS": PROCESS_ENVIRONMENT["HEALTH_REGRESSION_WINDOW_SECONDS"],
                      "GATEWAY_PROBE_TIMEOUT_SECONDS": PROCESS_ENVIRONMENT["GATEWAY_PROBE_TIMEOUT_SECONDS"],
                      "RATE_LIMIT_PER_MIN": PROCESS_ENVIRONMENT["RATE_LIMIT_PER_MIN"],
                      "MAX_CONCURRENT_PROVISIONS": PROCESS_ENVIRONMENT["MAX_CONCURRENT_PROVISIONS"],
                      "PROVISION_TIMEOUT_SECONDS": PROCESS_ENVIRONMENT["PROVISION_TIMEOUT_SECONDS"],
                      "pool_exhaustion_status": result["pool_exhaustion_status"],
                      "pool_exhaustion_reason": result["pool_exhaustion_reason"],
                      "pool_exhaustion_error": result["pool_exhaustion"].get("error", ""),
                      "artifacts": result["artifacts"]}, indent=2))
    return result


def percentile(values, p):
    if not values: return None
    v = sorted(values)
    if len(v) == 1: return v[0]
    rank = (len(v)-1)*p/100
    lo = int(rank); hi = min(lo+1, len(v)-1)
    return v[lo] + (v[hi]-v[lo])*(rank-lo)


def parse_bursts(value):
    try:
        bursts = [int(item.strip()) for item in value.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--bursts must be a comma-separated list from 3,5,10,15") from exc
    if not bursts or any(burst not in LEVELS for burst in bursts):
        raise argparse.ArgumentTypeError("--bursts values must be selected from 3,5,10,15")
    return bursts


def main():
    p = argparse.ArgumentParser(description="T2 concurrent provisioning stress")
    modes = p.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--smoke", action="store_true")
    p.add_argument("--bursts", type=parse_bursts, default=None, metavar="N[,N...]")
    p.add_argument("--skip-pool", action="store_true", help="skip isolated pool-exhaustion phase")
    args = p.parse_args()
    if args.smoke and args.bursts is not None:
        p.error("--smoke cannot be combined with --bursts")
    try:
        cfg = load_config(BASE / "config.yaml")
        cap = int(os.environ.get("BENCH_MAX_CONCURRENCY", "15"))
        if cap < 1 or cap > 15: raise ValueError("BENCH_MAX_CONCURRENCY must be 1..15")
        selected_bursts = [2] if args.smoke else (args.bursts if args.bursts is not None else LEVELS)
        if args.dry_run:
            required = {"ADMIN_TOKEN": bool(os.environ.get("ADMIN_TOKEN")),
                        "PUBLIC_VIP_IP": bool(cfg["network"].get("public_vip")),
                        "ROUTING_DOMAIN": cfg["network"].get("domain") == "cloudpulse.cstam.felcloud.tn",
                        "DPA_PASS": bool(os.environ.get("DPA_PASS")),
                        "BENCH_PRIMARY_HOST": bool(cfg.get("safety_gates", {}).get("allowed_gateway_hosts", {}).get("primary")),
                        "BENCH_STANDBY_HOST": bool(cfg.get("safety_gates", {}).get("allowed_gateway_hosts", {}).get("standby")),
                        "sqlite3_executable": bool(shutil.which("sqlite3")),
                        "go_executable": bool(shutil.which("go"))}
            print(json.dumps({"test":"T2_concurrent_stress", "mode":"DRY RUN", "bursts":selected_bursts,
                "flags":{"--bursts":args.bursts, "--skip-pool":args.skip_pool},
                "pool_exhaustion_status":"NOT EXECUTED" if args.skip_pool else "PLANNED",
                "pool_exhaustion_reason":"skipped by --skip-pool" if args.skip_pool else "",
                "hard_concurrency_cap":15, "configured_cap":cap, "health_regression_window_seconds":WINDOW,
                "process_environment":PROCESS_ENVIRONMENT,
                "probe_limit_per_second":5, "routing_domain":"cloudpulse.cstam.felcloud.tn",
                "vip":cfg["network"].get("public_vip") or "NOT CONFIGURED", "control_plane":cfg["control_plane"]["base_url"],
                "configuration_gates":required,
                "actions":["check both DPA configs have exactly 3 baseline route backends before each burst", "barrier-start provision API requests", "poll sandbox HTTP routes and team1 every 200ms", "read DPA configs/IPAM/Neutron/events/generations", "delete this burst's bench-* IDs"] + ([] if args.skip_pool else ["copy live DB with sqlite3 .backup and run pool exhaustion on isolated control plane port 8082", "retry 429 responses, release every allocated lease, and verify isolated IPAM signature"]) + ["final OpenStack and HAProxy checks"],
                "network_calls":False}, indent=2)); return 0
        result = asyncio.run(run(cfg, smoke=args.smoke, bursts=args.bursts, skip_pool=args.skip_pool))
        return 0 if result.get("status") == "EXECUTED" else 2
    except Exception as exc:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        RAW.mkdir(parents=True, exist_ok=True)
        detail = f"{type(exc).__name__}: {exc}"
        out = {"test":"T2_concurrent_stress", "status":"NOT EXECUTED", "error":detail,
               "health_regression_window_seconds":WINDOW, "timestamp_utc":utc(),
               "process_environment":PROCESS_ENVIRONMENT, **PROCESS_ENVIRONMENT,
               "chart":"NOT EXECUTED: no live burst data; " + detail,
               "per_sandbox_results":"NOT EXECUTED: provisioning did not start; " + detail}
        (RAW / f"t2_concurrent_{stamp}_summary.json").write_text(json.dumps(out, indent=2)+"\n", encoding="utf-8")
        with (RAW / f"t2_concurrent_{stamp}.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["timestamp_utc", "test", "status", "error"])
            writer.writeheader(); writer.writerow({"timestamp_utc": out["timestamp_utc"], "test": out["test"],
                                                   "status": "NOT EXECUTED", "error": detail})
        print(f"T2 NOT EXECUTED: {detail}", file=sys.stderr)
        print(json.dumps(PROCESS_ENVIRONMENT, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
