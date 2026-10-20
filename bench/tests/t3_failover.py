#!/usr/bin/env python3
"""Measure HAProxy/Keepalived failover with independent bastion and WAN probers."""
import argparse
import asyncio
import csv
import json
import os
import re
import subprocess
import sys
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
SSH_USER = "ansible"
BASTION = "197.5.133.77"
GW = {"gw1": "10.20.10.24", "gw2": "10.20.10.164"}
VM_NAME = "felcloud-gw1"
VIP = "10.20.20.246"
PUBLIC_VIP = "197.5.133.119"
TEAM1_HOST = "team1.cloudpulse.cstam.felcloud.tn"
BASELINE_BACKENDS = {"default_maintenance", "team1_backend", "team2_backend"}
PROBE_INTERVAL_SECONDS = 0.1
PROBE_TIMEOUT_SECONDS = 1.0
LOCAL_PROBE_URL = f"http://{PUBLIC_VIP}/"
BASTION_PROBE_URL = f"http://{VIP}/"
GATEWAY_OBSERVE_COMMAND = ("printf 'HAPROXY='; systemctl is-active haproxy 2>&1 || true; "
    "printf 'KEEPALIVED='; systemctl is-active keepalived 2>&1 || true; "
    "printf 'ADDR_BEGIN\\n'; ip -br addr; printf 'ADDR_END\\n'; "
    "printf 'HAPROXY_CHECK_BEGIN\\n'; sudo haproxy -c -f /etc/haproxy/haproxy.cfg 2>&1; "
    "printf 'HAPROXY_CHECK_END\\n'; printf 'BACKENDS_BEGIN\\n'; "
    "grep -E '^backend[[:space:]]+' /etc/haproxy/haproxy.cfg; printf 'BACKENDS_END\\n'")
RESTORE_SERVICES_COMMAND = "sudo systemctl start haproxy && sudo systemctl start keepalived"
CLOCK_NOTE = "Bastion minus harness clock: median +11.7 ms; samples -1.2 to +15.7 ms; uncertainty about +/-55 ms. Recorded as stated; no correction."
SSH_DISPATCH_NOTE = "SSH dispatch latency adds a small, one-directional error; timestamps are recorded immediately before sending and after return; nothing is corrected."


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp_value(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ssh_identity(key_path):
    return ["ssh", "-i", key_path, "-o", "IPQoS=none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]


def gateway_ssh(key_path, host, control_path=None, master=False):
    args = ssh_identity(key_path)
    if control_path:
        args += ["-o", f"ControlPath={control_path}"]
        if master:
            args += ["-o", "ControlMaster=yes", "-o", "ControlPersist=600", "-fN"]
        else:
            args += ["-o", "ControlMaster=no"]
    args += ["-J", f"{SSH_USER}@{BASTION}", f"{SSH_USER}@{host}"]
    return args


def bastion_ssh(key_path, remote_command):
    return ssh_identity(key_path) + [f"{SSH_USER}@{BASTION}", remote_command]


async def run_command(args, *, input_text=None, timeout=30, check=True):
    proc = await asyncio.to_thread(subprocess.run, args, input=input_text, capture_output=True,
                                   text=True, timeout=timeout)
    if check and proc.returncode:
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"{' '.join(args)} exited {proc.returncode}: {detail}")
    return proc


async def gateway_command(key_path, host, remote_command, control_path=None, timeout=30, check=True):
    args = gateway_ssh(key_path, host, control_path=control_path) + [remote_command]
    return await run_command(args, timeout=timeout, check=check)


async def open_master(key_path, gateway, scenario):
    path = f"/tmp/t3-{os.getpid()}-{scenario}-{gateway}"
    args = gateway_ssh(key_path, GW[gateway], control_path=path, master=True)
    await run_command(args, timeout=30)
    return path


async def close_master(key_path, gateway, path):
    args = ssh_identity(key_path) + ["-S", path, "-O", "exit", "-J", f"{SSH_USER}@{BASTION}",
                                    f"{SSH_USER}@{GW[gateway]}"]
    await run_command(args, timeout=15, check=False)


def parse_probe_lines(text):
    samples = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and "timestamp_utc" in value:
                samples.append(value)
        except json.JSONDecodeError:
            continue
    return samples


def bastion_probe_script():
    return r'''#!/usr/bin/env python3
import argparse, datetime, json, signal, time, urllib.error, urllib.request
p = argparse.ArgumentParser(); p.add_argument("--output", required=True); a = p.parse_args()
stopping = False
def stop(_sig, _frame):
    global stopping; stopping = True
signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
while not stopping:
    due = time.monotonic()
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    started = time.perf_counter(); status = 0; gateway = ""; error = ""
    request = urllib.request.Request("http://10.20.20.246/", headers={"Host":"team1.cloudpulse.cstam.felcloud.tn", "User-Agent":"FelCloud-T3-Bastion"})
    try:
        with urllib.request.urlopen(request, timeout=1.0) as response:
            status = response.status; gateway = response.headers.get("X-Gateway-ID", "")
    except urllib.error.HTTPError as exc:
        status = exc.code; gateway = exc.headers.get("X-Gateway-ID", "") if exc.headers else ""
    except Exception as exc:
        error = type(exc).__name__ + ": " + str(exc)
    sample = {"timestamp_utc":stamp,"status":status,"gateway_id":gateway,"latency_ms":(time.perf_counter()-started)*1000,"error":error}
    with open(a.output, "a", encoding="utf-8") as out:
        out.write(json.dumps(sample, separators=(",",":")) + "\n"); out.flush()
    time.sleep(max(0.0, 0.1-(time.monotonic()-due)))
'''


async def launch_bastion_prober(key_path, scenario):
    tag = f"t3_{os.getpid()}_{scenario}"
    script_path, data_path, log_path = (f"/tmp/{tag}.py", f"/tmp/{tag}.jsonl", f"/tmp/{tag}.log")
    copy = await run_command(bastion_ssh(key_path, f"cat > {script_path}"), input_text=bastion_probe_script(), timeout=20)
    if copy.returncode:
        raise RuntimeError(f"could not copy primary prober to bastion: {(copy.stderr or copy.stdout).strip()}")
    await run_command(bastion_ssh(key_path, f"chmod 700 {script_path}"), timeout=15)
    pid_result = await run_command(bastion_ssh(key_path,
        f"nohup python3 {script_path} --output {data_path} > {log_path} 2>&1 < /dev/null & echo $!"), timeout=15)
    pid = pid_result.stdout.strip().splitlines()[-1] if pid_result.stdout.strip() else ""
    if not pid.isdigit():
        raise RuntimeError(f"bastion prober launch did not return a process ID: {pid_result.stdout!r}")
    return {"pid": pid, "script_path": script_path, "data_path": data_path, "log_path": log_path}


async def stop_fetch_bastion_prober(key_path, proc_info):
    if not proc_info:
        return [], "primary bastion prober was not launched"
    await run_command(bastion_ssh(key_path, f"kill -TERM {proc_info['pid']} 2>/dev/null || true; sleep 0.2"),
                      timeout=10, check=False)
    fetched = await run_command(bastion_ssh(key_path, f"cat {proc_info['data_path']} 2>/dev/null || true"),
                                timeout=20, check=False)
    await run_command(bastion_ssh(key_path,
        f"rm -f {proc_info['script_path']} {proc_info['data_path']} {proc_info['log_path']}"), timeout=15, check=False)
    samples = parse_probe_lines(fetched.stdout)
    error = "" if samples else f"primary prober produced no samples: {(fetched.stderr or fetched.stdout).strip()}"
    return samples, error


async def local_prober(client, stop, samples, url):
    while not stop.is_set():
        due = time.monotonic()
        stamp = utc_now()
        started = time.perf_counter()
        status, gateway, error = 0, "", ""
        try:
            response = await client.get(url, headers={"Host": TEAM1_HOST, "User-Agent": "FelCloud-T3-WAN"}, timeout=PROBE_TIMEOUT_SECONDS)
            status = response.status_code
            gateway = response.headers.get("X-Gateway-ID", "")
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        samples.append({"timestamp_utc": stamp, "status": status, "gateway_id": gateway,
                        "latency_ms": (time.perf_counter() - started) * 1000, "error": error})
        try:
            await asyncio.wait_for(stop.wait(), max(0.0, PROBE_INTERVAL_SECONDS - (time.monotonic() - due)))
        except asyncio.TimeoutError:
            pass


def failed_sample(sample):
    return sample.get("status") != 200 or bool(sample.get("error")) or sample.get("status") == 0


def summarize_samples(samples):
    return {"sample_count": len(samples), "failed_sample_count": sum(failed_sample(sample) for sample in samples),
        "connection_error_count": sum(sample.get("status") == 0 or bool(sample.get("error")) for sample in samples),
        "non_200_count": sum(sample.get("status") not in (200, 429, 0) for sample in samples),
        "429_count": sum(sample.get("status") == 429 for sample in samples),
        "gateway_id_counts": {gateway: sum(sample.get("gateway_id") == gateway for sample in samples)
                              for gateway in ("gw1", "gw2")}}


def scenario_metrics(samples, action_start, restore_start, channel):
    start = timestamp_value(action_start)
    restore = timestamp_value(restore_start) if restore_start else None
    in_window = [sample for sample in samples if timestamp_value(sample["timestamp_utc"]) >= start and
                 (restore is None or timestamp_value(sample["timestamp_utc"]) <= restore)]
    shifted = [sample for sample in in_window if sample.get("gateway_id") == "gw2"]
    failed = [sample for sample in in_window if failed_sample(sample)]
    first_shift = min(shifted, key=lambda sample: timestamp_value(sample["timestamp_utc"])) if shifted else None
    last_failed = max(failed, key=lambda sample: timestamp_value(sample["timestamp_utc"])) if failed else None
    metrics = {"clock_basis": channel, "failed_sample_count": len(failed),
        "failed_samples": failed,
        "last_failed_sample_utc": last_failed["timestamp_utc"] if last_failed else None,
        "action_to_last_failed_sample_ms": ((timestamp_value(last_failed["timestamp_utc"]) - start).total_seconds() * 1000
            if last_failed else None),
        "failover_first_gw2_sample_utc": first_shift["timestamp_utc"] if first_shift else None,
        "failover_action_to_first_gw2_ms": ((timestamp_value(first_shift["timestamp_utc"]) - start).total_seconds() * 1000
            if first_shift else None),
        "samples_during_action_window": len(in_window)}
    return metrics


def failback_metrics(samples, restore_start, first_gw1, channel):
    start = timestamp_value(restore_start)
    first_return = first_gw1.get("timestamp_utc") if first_gw1 else None
    end = timestamp_value(first_return) if first_return else max(
        (timestamp_value(sample["timestamp_utc"]) for sample in samples), default=start)
    observed = [sample for sample in samples if start <= timestamp_value(sample["timestamp_utc"]) <= end]
    failed = [sample for sample in observed if failed_sample(sample)]
    return {"clock_basis": channel, "first_gw1_sample_utc": first_return,
        "restore_to_first_gw1_ms": ((timestamp_value(first_return) - start).total_seconds() * 1000
                                     if first_return else None),
        "failed_sample_count": len(failed), "failed_samples": failed,
        "last_failed_sample_utc": max((sample["timestamp_utc"] for sample in failed),
                                       key=timestamp_value, default=None)}


async def gateway_observation(key_path, gateway):
    try:
        proc = await gateway_command(key_path, GW[gateway], GATEWAY_OBSERVE_COMMAND, timeout=25, check=False)
    except Exception as exc:
        return {"gateway": gateway, "status": "NOT EXECUTED",
                "error": t2.redact_process_error(f"{type(exc).__name__}: {exc}"),
                "ip_br_addr": "", "vip_present": False, "backends": []}
    text = proc.stdout + proc.stderr
    active_haproxy = re.search(r"HAPROXY=([^\r\n]+)", text)
    active_keepalived = re.search(r"KEEPALIVED=([^\r\n]+)", text)
    address_lines = text.split("ADDR_BEGIN\n", 1)[-1].split("ADDR_END", 1)[0]
    backend_block = text.split("BACKENDS_BEGIN\n", 1)[-1].split("BACKENDS_END", 1)[0]
    backends = re.findall(r"(?m)^backend\s+([^\s#]+)", backend_block)
    return {"gateway": gateway, "command_returncode": proc.returncode,
        "haproxy_active": bool(active_haproxy and active_haproxy.group(1).strip() == "active"),
        "keepalived_active": bool(active_keepalived and active_keepalived.group(1).strip() == "active"),
        "ip_br_addr": address_lines.strip(), "vip_present": VIP in address_lines,
        "haproxy_config_valid": "Configuration file is valid" in text,
        "backends": backends, "baseline_backends_exact": set(backends) == BASELINE_BACKENDS and len(backends) == 3,
        "raw_output": text.strip()}


async def vip_location(key_path):
    return {gateway: await gateway_observation(key_path, gateway) for gateway in ("gw1", "gw2")}


async def stable_state(key_path, vip_client):
    observations = {gateway: await gateway_observation(key_path, gateway) for gateway in ("gw1", "gw2")}
    team1 = await local_single_probe(vip_client)
    okay = (all(item["haproxy_active"] and item["keepalived_active"] and item["haproxy_config_valid"]
                and item["baseline_backends_exact"] for item in observations.values())
            and observations["gw1"]["vip_present"] and not observations["gw2"]["vip_present"]
            and team1["status"] == 200)
    return {"passed": okay, "gateways": observations, "team1_probe": team1}


async def local_single_probe(client):
    try:
        response = await client.get(LOCAL_PROBE_URL,
            headers={"Host": TEAM1_HOST, "User-Agent": "FelCloud-T3-Stability"}, timeout=3)
        return {"status": response.status_code, "gateway_id": response.headers.get("X-Gateway-ID", ""),
                "latency_ms": response.elapsed.total_seconds() * 1000, "error": ""}
    except Exception as exc:
        return {"status": 0, "gateway_id": "", "latency_ms": None, "error": f"{type(exc).__name__}: {exc}"}


async def wait_stable(key_path, vip_client, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    last = None
    while time.monotonic() < deadline:
        last = await stable_state(key_path, vip_client)
        if last["passed"]:
            return last
        await asyncio.sleep(2)
    return last or {"passed": False, "error": "stable-state check had no observations"}


async def openstack_status():
    proc = await run_command(["openstack", "--os-cloud", "felcloud", "server", "show", VM_NAME,
                              "-f", "value", "-c", "status"], timeout=30)
    return proc.stdout.strip()


async def wait_vm_active(key_path, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    last_status = ""
    last_ssh_error = ""
    while time.monotonic() < deadline:
        last_status = await openstack_status()
        if last_status == "ACTIVE":
            ssh_check = await gateway_command(key_path, GW["gw1"], "true", timeout=12, check=False)
            if ssh_check.returncode == 0:
                return {"passed": True, "server_status": last_status, "ssh_returncode": 0}
            last_ssh_error = (ssh_check.stderr or ssh_check.stdout).strip()
        await asyncio.sleep(3)
    return {"passed": False, "server_status": last_status, "ssh_error": last_ssh_error,
            "error": f"gw1 did not reach ACTIVE and SSH-ready within {timeout_seconds}s"}


async def action_with_master(key_path, master_path, remote_command):
    started = utc_now()
    proc = await gateway_command(key_path, GW["gw1"], remote_command, control_path=master_path,
                                 timeout=30, check=False)
    returned = utc_now()
    if proc.returncode:
        raise RuntimeError(f"remote action exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()}")
    return {"started_utc": started, "returned_utc": returned, "stdout": proc.stdout.strip()}


async def vm_action(action):
    started = utc_now()
    proc = await run_command(["openstack", "--os-cloud", "felcloud", "server", action, VM_NAME], timeout=60)
    returned = utc_now()
    return {"started_utc": started, "returned_utc": returned, "stdout": proc.stdout.strip()}


async def wait_for_gateway(samples, gateway_id, after_utc, timeout_seconds):
    start = timestamp_value(after_utc)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        for sample in samples:
            if sample.get("gateway_id") == gateway_id and timestamp_value(sample["timestamp_utc"]) >= start:
                return sample
        await asyncio.sleep(0.1)
    return None


def first_gateway_sample(samples, gateway_id, after_utc):
    start = timestamp_value(after_utc)
    candidates = [sample for sample in samples if sample.get("gateway_id") == gateway_id and
                  timestamp_value(sample["timestamp_utc"]) >= start]
    return min(candidates, key=lambda sample: timestamp_value(sample["timestamp_utc"])) if candidates else None


async def run_scenario(name, label, expectation, cfg, vip_client, include_hard_stop=False):
    key_path = cfg["openstack"]["ssh_key_path"]
    result = {"scenario": name, "status": "NOT EXECUTED", "derived_expectation": expectation,
              "primary_samples": [], "secondary_samples": [], "action": {}, "restore": {}}
    gateway = "gw1"
    master = None
    primary = None
    secondary = []
    secondary_stop = asyncio.Event()
    secondary_task = None
    server_stop_attempted = False
    scenario_active = False
    try:
        stable = await stable_state(key_path, vip_client)
        result["stable_state_before"] = stable
        if not stable["passed"]:
            raise RuntimeError("stable-state precondition failed; scenario was not started")
        master = await open_master(key_path, gateway, label)
        primary = await launch_bastion_prober(key_path, label)
        secondary_task = asyncio.create_task(local_prober(vip_client, secondary_stop, secondary, LOCAL_PROBE_URL))
        await asyncio.sleep(0.5)
        scenario_active = True
        if name == "baseline":
            await asyncio.sleep(60)
            result["status"] = "COMPLETED"
        elif name == "hard_stop_gw1":
            server_stop_attempted = True
            action = await vm_action("stop")
            result["action"] = action
            status_deadline = time.monotonic() + 60
            while time.monotonic() < status_deadline:
                observed_status = await openstack_status()
                if observed_status in {"STOPPED", "SHUTOFF"}:
                    break
                await asyncio.sleep(2)
            result["server_stopped_observed"] = observed_status in {"STOPPED", "SHUTOFF"}
            result["server_status_after_stop"] = observed_status
            first_gw2 = await wait_for_gateway(secondary, "gw2", action["started_utc"], 45)
            result["failover_first_gw2_secondary"] = first_gw2
            if first_gw2:
                await asyncio.sleep(5)
            result["vip_location_after_failover"] = await vip_location(key_path)
            result["restore"]["action"] = await vm_action("start")
            server_stop_attempted = False
            vm_ready = await wait_vm_active(key_path, 240)
            result["restore"]["vm_active_and_ssh"] = vm_ready
            result["restoration_started_utc"] = result["restore"]["action"]["started_utc"]
            first_gw1 = await wait_for_gateway(secondary, "gw1", result["restoration_started_utc"], 60)
            result["failback_first_gw1_secondary"] = first_gw1
            result["restoration_started_utc"] = result["restore"]["action"]["started_utc"]
            result["status"] = "COMPLETED" if vm_ready["passed"] else "FAILED"
        else:
            if name == "stop_haproxy_gw1":
                stop_command, restore_command = "sudo systemctl stop haproxy", "sudo systemctl start haproxy"
            elif name == "stop_keepalived_gw1":
                stop_command, restore_command = "sudo systemctl stop keepalived", "sudo systemctl start keepalived"
            else:
                raise RuntimeError(f"unknown scenario {name}")
            result["action"] = await action_with_master(key_path, master, stop_command)
            first_gw2 = await wait_for_gateway(secondary, "gw2", result["action"]["started_utc"], 45)
            result["failover_first_gw2_secondary"] = first_gw2
            if first_gw2:
                await asyncio.sleep(5)
            result["vip_location_after_failover"] = await vip_location(key_path)
            result["restore"]["action"] = await action_with_master(key_path, master, restore_command)
            result["restoration_started_utc"] = result["restore"]["action"]["started_utc"]
            first_gw1 = await wait_for_gateway(secondary, "gw1", result["restoration_started_utc"], 60)
            result["failback_first_gw1_secondary"] = first_gw1
            result["status"] = "COMPLETED"
    except Exception as exc:
        result["status"] = "FAILED" if scenario_active else "NOT EXECUTED"
        result["error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
    finally:
        if name == "baseline":
            try:
                restore_proc = await gateway_command(key_path, GW["gw1"],
                    RESTORE_SERVICES_COMMAND, timeout=30, check=False)
                result["restore"]["action"] = {"returncode": restore_proc.returncode,
                    "output": (restore_proc.stdout + restore_proc.stderr).strip()}
            except Exception as exc:
                result["restore"]["error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
            result["stable_state_after"] = await wait_stable(key_path, vip_client, 120)
            result["restore"]["passed"] = bool(result["restore"].get("action", {}).get("returncode") == 0 and
                                                result["stable_state_after"]["passed"])
            if not result["restore"]["passed"]:
                result["status"] = "FAILED"
        else:
            try:
                if master:
                    if server_stop_attempted:
                        start_result = await vm_action("start")
                        result["restore"]["emergency_server_start"] = start_result
                        server_stop_attempted = False
                        vm_ready = await wait_vm_active(key_path, 240)
                        result["restore"]["emergency_vm_active_and_ssh"] = vm_ready
                    if name == "stop_haproxy_gw1":
                        await gateway_command(key_path, GW["gw1"], "sudo systemctl start haproxy", control_path=master, timeout=30)
                    elif name == "stop_keepalived_gw1":
                        await gateway_command(key_path, GW["gw1"], "sudo systemctl start keepalived", control_path=master, timeout=30)
                else:
                    if server_stop_attempted:
                        result["restore"]["emergency_server_start"] = await vm_action("start")
                        server_stop_attempted = False
                        result["restore"]["emergency_vm_active_and_ssh"] = await wait_vm_active(key_path, 240)
                if not result.get("restoration_started_utc"):
                    result["restoration_started_utc"] = utc_now()
                restore_start = await gateway_command(key_path, GW["gw1"],
                    RESTORE_SERVICES_COMMAND, timeout=30, check=False)
                result["restore"]["gw1_services_returncode"] = restore_start.returncode
                result["restore"]["gw1_services_output"] = (restore_start.stdout + restore_start.stderr).strip()
                stable_timeout = 240 if name == "hard_stop_gw1" else 120
                result["stable_state_after"] = await wait_stable(key_path, vip_client, stable_timeout)
                result["stable_state_after_utc"] = utc_now()
                result["restore"]["passed"] = (restore_start.returncode == 0 and result["stable_state_after"]["passed"])
                if not result["restore"]["passed"]:
                    result["restore"]["manual_recovery_commands"] = [
                        "ssh -i $SSH_KEY_PATH -o IPQoS=none -o BatchMode=yes -J ansible@197.5.133.77 ansible@10.20.10.24 'sudo systemctl start haproxy keepalived'",
                        "openstack --os-cloud felcloud server start felcloud-gw1"]
                    result["status"] = "FAILED"
            except Exception as exc:
                result["restore"]["passed"] = False
                result["restore"]["error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
                result["restore"]["manual_recovery_commands"] = [
                    "ssh -i $SSH_KEY_PATH -o IPQoS=none -o BatchMode=yes -J ansible@197.5.133.77 ansible@10.20.10.24 'sudo systemctl start haproxy keepalived'",
                    "openstack --os-cloud felcloud server start felcloud-gw1"]
                result["status"] = "FAILED"
        secondary_stop.set()
        if secondary_task:
            await secondary_task
        if primary:
            try:
                samples, fetch_error = await stop_fetch_bastion_prober(key_path, primary)
                result["primary_samples"] = samples
                if fetch_error:
                    result["primary_prober_error"] = fetch_error
            except Exception as exc:
                result["primary_prober_error"] = t2.redact_process_error(f"{type(exc).__name__}: {exc}")
        result["secondary_samples"] = secondary
        result["sample_summary"] = {"primary_bastion": summarize_samples(result.get("primary_samples", [])),
                                    "secondary_wan": summarize_samples(secondary)}
        if master:
            await close_master(key_path, gateway, master)
    if name != "baseline" and result.get("action") and result.get("restoration_started_utc"):
        for channel, samples in (("primary_bastion", result["primary_samples"]), ("secondary_wan", secondary)):
            result.setdefault("measurements", {})[channel] = scenario_metrics(
                samples, result["action"]["started_utc"], result["restoration_started_utc"], channel)
            result["measurements"][channel]["failback"] = failback_metrics(samples,
                result["restoration_started_utc"],
                result.get("failback_first_gw1_secondary") if channel == "secondary_wan" else
                first_gateway_sample(samples, "gw1", result["restoration_started_utc"]), channel)
            result["measurements"][channel]["gw1_seen_before_action"] = any(
                sample.get("gateway_id") == "gw1" and timestamp_value(sample["timestamp_utc"]) <
                timestamp_value(result["action"]["started_utc"]) for sample in samples)
        primary_metric = result["measurements"]["secondary_wan"]
        result["failover_under_3_seconds"] = (primary_metric["failover_action_to_first_gw2_ms"] is not None and
            0 <= primary_metric["failover_action_to_first_gw2_ms"] < 3000)
        result["x_gateway_id_changed_gw1_to_gw2"] = bool(primary_metric["gw1_seen_before_action"] and
            primary_metric["failover_first_gw2_sample_utc"])
        result["pass"] = bool(result["failover_under_3_seconds"] and result["x_gateway_id_changed_gw1_to_gw2"]
            and result.get("restore", {}).get("passed"))
        if result["status"] == "COMPLETED":
            result["status"] = "PASSED" if result["pass"] else "FAILED"
    return result


async def run_suite(cfg, include_hard_stop):
    key_path = cfg["openstack"]["ssh_key_path"]
    if not key_path or not Path(key_path).is_file():
        raise RuntimeError("SSH_KEY_PATH must identify a readable private key file")
    if cfg.get("openstack", {}).get("ssh_user", SSH_USER) != SSH_USER:
        raise RuntimeError("bench SSH user must be ansible for the required bastion hop")
    async with httpx.AsyncClient(timeout=3, follow_redirects=False) as vip_client:
        initial = await stable_state(key_path, vip_client)
        result = {"test": "T3_gateway_failover", "timestamp_utc": utc_now(),
            "status": "RUNNING", "settings": {"primary_interval_ms": 100,
                "secondary_interval_ms": 100, "per_request_timeout_seconds": 1,
                "baseline_duration_seconds": 60, "failover_observation_deadline_seconds": 45,
                "failback_observation_deadline_seconds": 60, "stable_state_deadline_seconds": 120,
                "stable_state_deadline_after_vm_stop_seconds": 240,
                "keepalived_version": "2.2.8", "vrrp_id": 51, "advert_int_seconds": 1,
                "gw1_priority": 150, "gw2_priority": 100,
                "check_haproxy": "killall -0 haproxy; interval 2; fall 2; rise 2; weight 60"},
            "clock_offset": {"stated_uncertainty": CLOCK_NOTE, "corrected": False},
            "ssh_dispatch_latency": SSH_DISPATCH_NOTE,
            "preflight_stable_state": initial, "scenarios": []}
        if not initial["passed"]:
            result["status"] = "NOT EXECUTED"
            failed_gateways = [f"{gateway}: {state.get('error') or state.get('raw_output', 'gateway check failed')}"
                               for gateway, state in initial.get("gateways", {}).items()
                               if not (state.get("haproxy_active") and state.get("keepalived_active") and
                                   state.get("vip_present") == (gateway == "gw1") and
                                   state.get("haproxy_config_valid") and state.get("baseline_backends_exact"))]
            team1 = initial.get("team1_probe", {})
            if team1.get("status") != 200:
                failed_gateways.append(f"team1 VIP probe HTTP {team1.get('status')}: {team1.get('error', '')}")
            result["error"] = "preflight stable-state check failed; " + "; ".join(failed_gateways)
            return result
        scenarios = [("baseline", "baseline", "60 seconds of probing; no action"),
                     ("stop_haproxy_gw1", "haproxy", "derived expectation: about 3 to 6 seconds"),
                     ("stop_keepalived_gw1", "keepalived", "derived expectation: about 1 second")]
        if include_hard_stop:
            scenarios.append(("hard_stop_gw1", "hardstop", "derived expectation: about 3.4 seconds or more"))
        else:
            result["hard_stop_scenario"] = {"status": "NOT EXECUTED", "reason": "requires --include-hard-stop"}
        for name, label, expectation in scenarios:
            scenario = await run_scenario(name, label, expectation, cfg, vip_client)
            result["scenarios"].append(scenario)
            if scenario.get("restore", {}).get("passed") is False:
                result["status"] = "FAILED"
                result["stop_reason"] = "restoration failed; no further scenario was run"
                break
            if scenario["status"] == "NOT EXECUTED":
                result["status"] = "NOT EXECUTED"
                result["stop_reason"] = "scenario precondition failed; no further disruptive scenario was run"
                break
        else:
            disruptive = [scenario for scenario in result["scenarios"] if scenario["scenario"] != "baseline"]
            result["status"] = ("PASSED" if all(scenario.get("status") == "PASSED" for scenario in disruptive)
                                 and all(scenario.get("status") == "COMPLETED" for scenario in result["scenarios"]
                                         if scenario["scenario"] == "baseline") else "FAILED")
        return result


def write_outputs(result):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RAW.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    csv_path = RAW / f"t3_failover_{stamp}.csv"
    samples = []
    for scenario in result.get("scenarios", []):
        for channel, key in (("primary_bastion", "primary_samples"), ("secondary_wan", "secondary_samples")):
            samples.extend({"scenario": scenario["scenario"], "channel": channel, **sample}
                           for sample in scenario.get(key, []))
    fields = ["scenario", "channel", "timestamp_utc", "status", "gateway_id", "latency_ms", "error"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(samples)
    chart_path = CHARTS / f"t3_failover_{stamp}.png"
    labels, failover_ms, failback_drops = [], [], []
    for scenario in result.get("scenarios", []):
        if scenario.get("measurements"):
            labels.append(scenario["scenario"])
            metric = scenario["measurements"].get("secondary_wan", {})
            failover_ms.append(metric.get("failover_action_to_first_gw2_ms") or 0)
            failback_drops.append(sum(failed_sample(sample) for sample in scenario.get("secondary_samples", [])
                if scenario.get("restoration_started_utc") and
                timestamp_value(sample["timestamp_utc"]) >= timestamp_value(scenario["restoration_started_utc"])))
    fig, axis = plt.subplots(figsize=(10, 5))
    if labels:
        axis.bar(labels, failover_ms, color="#1f77b4")
        axis.axhline(3000, color="#d62728", linestyle="--", label="3 s target")
        axis.set_ylabel("Action to gw2 X-Gateway-ID (ms)")
        twin = axis.twinx()
        twin.plot(labels, failback_drops, color="#ff7f0e", marker="o", label="failback failed samples")
        twin.set_ylabel("failback failed samples")
        axis.legend(loc="upper left")
    else:
        axis.text(0.5, 0.5, result.get("status", "NOT EXECUTED"), ha="center", va="center",
                  transform=axis.transAxes)
        axis.set_axis_off()
    axis.set_title("T3 gateway failover and failback")
    axis.grid(True, axis="y", alpha=0.3)
    fig.tight_layout(); fig.savefig(chart_path, dpi=150); plt.close(fig)
    summary_path = RAW / f"t3_failover_{stamp}_summary.json"
    result["artifacts"] = {"raw_csv": str(csv_path), "summary_json": str(summary_path), "chart": str(chart_path)}
    summary_path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


def dry_run_plan(cfg, include_hard_stop):
    key = cfg["openstack"]["ssh_key_path"] or "$SSH_KEY_PATH"
    commands = []
    scenarios = [("baseline", None, None),
        ("stop_haproxy_gw1", "sudo systemctl stop haproxy", "sudo systemctl start haproxy"),
        ("stop_keepalived_gw1", "sudo systemctl stop keepalived", "sudo systemctl start keepalived")]
    if include_hard_stop:
        scenarios.append(("hard_stop_gw1", None, None))
    for scenario, action, restore in scenarios:
        master_path = f"/tmp/t3-<pid>-{scenario}-gw1"
        item = {"scenario": scenario,
            "ssh_master_open": gateway_ssh(key, GW["gw1"], master_path, master=True),
            "ssh_master_close": ssh_identity(key) + ["-S", master_path, "-O", "exit", "-J",
                f"{SSH_USER}@{BASTION}", f"{SSH_USER}@{GW['gw1']}"]}
        if action:
            item["ssh_action"] = gateway_ssh(key, GW["gw1"], master_path) + [action]
            item["ssh_restore_action"] = gateway_ssh(key, GW["gw1"], master_path) + [restore]
        if scenario == "hard_stop_gw1":
            item["openstack_stop"] = ["openstack", "--os-cloud", "felcloud", "server", "stop", VM_NAME]
            item["openstack_status_poll"] = ["openstack", "--os-cloud", "felcloud", "server", "show", VM_NAME,
                "-f", "value", "-c", "status"]
            item["openstack_start"] = ["openstack", "--os-cloud", "felcloud", "server", "start", VM_NAME]
        item.update({"primary_prober_copy": bastion_ssh(key, "cat > /tmp/t3_<run>_<scenario>.py"),
            "primary_prober_launch": bastion_ssh(key, "nohup python3 /tmp/t3_<run>_<scenario>.py --output /tmp/t3_<run>_<scenario>.jsonl"),
            "primary_prober_stop": bastion_ssh(key, "kill -TERM <pid>"),
            "primary_prober_fetch": bastion_ssh(key, "cat /tmp/t3_<run>_<scenario>.jsonl"),
            "primary_prober_cleanup": bastion_ssh(key, "rm -f /tmp/t3_<run>_<scenario>.py /tmp/t3_<run>_<scenario>.jsonl /tmp/t3_<run>_<scenario>.log"),
            "secondary_prober": {"process": "in-process Python async HTTP prober", "url": LOCAL_PROBE_URL,
                "interval_ms": 100, "timeout_seconds": 1},
            "finally_restore": gateway_ssh(key, GW["gw1"]) + [RESTORE_SERVICES_COMMAND],
            "finally_openstack_restore": ["openstack", "--os-cloud", "felcloud", "server", "start", VM_NAME]
                if scenario == "hard_stop_gw1" else None})
        commands.append(item)
    return {"test": "T3_gateway_failover", "mode": "DRY RUN", "network_calls": False,
        "commands": commands,
        "stable_state_commands": [gateway_ssh(key, GW["gw1"]) + [GATEWAY_OBSERVE_COMMAND],
            gateway_ssh(key, GW["gw2"]) + [GATEWAY_OBSERVE_COMMAND],
            ["httpx", "GET", LOCAL_PROBE_URL, "Host: " + TEAM1_HOST]],
        "clock_offset": {"stated_uncertainty": CLOCK_NOTE, "corrected": False},
        "ssh_dispatch_latency": SSH_DISPATCH_NOTE,
        "scenario_expectations": {"haproxy_stop": "about 3 to 6 s", "keepalived_stop": "about 1 s",
                                  "hard_stop": "about 3.4 s or more"},
        "restore_finally": ["systemctl start haproxy", "systemctl start keepalived",
            "openstack --os-cloud felcloud server start felcloud-gw1 if stopped"],
        "include_hard_stop": include_hard_stop}


def main():
    parser = argparse.ArgumentParser(description="T3 gateway failover measurement")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-hard-stop", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(BASE / "config.yaml")
        if args.dry_run:
            print(json.dumps(dry_run_plan(cfg, args.include_hard_stop), indent=2))
            return 0
        result = write_outputs(asyncio.run(run_suite(cfg, args.include_hard_stop)))
        print(json.dumps({"test": result["test"], "status": result["status"],
            "error": result.get("error"), "stop_reason": result.get("stop_reason"),
            "scenarios": [{"scenario": row["scenario"], "status": row["status"],
                "pass": row.get("pass"), "error": row.get("error"),
                "restore": row.get("restore")} for row in result.get("scenarios", [])],
            "artifacts": result.get("artifacts")}, indent=2))
        return 0 if result["status"] == "COMPLETED" else 2
    except Exception as exc:
        print(f"T3 NOT EXECUTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
