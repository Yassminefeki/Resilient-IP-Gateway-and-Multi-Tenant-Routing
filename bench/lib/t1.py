"""T1 sequential sandbox provisioning latency benchmark."""
import asyncio
import json
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlsplit

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from bench.lib.api_client import AsyncControlPlaneClient
from bench.lib.cleanup import cleanup_created_sandboxes
from bench.lib.prober import PollResult, wait_until_http_200
from bench.lib.stats import compute_stats, save_raw_csv, save_summary_json


def _utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _resolved_ips(info):
    return sorted({item[4][0] for item in info})


def _response_body(data, limit=2000):
    """Serialize and truncate an API response body without retaining secrets."""
    token = os.environ.get("ADMIN_TOKEN", "")

    def redact(value):
        if isinstance(value, dict):
            return {key: ("[REDACTED]" if any(word in str(key).lower()
                                                for word in ("token", "password", "secret"))
                          else redact(item)) for key, item in value.items()}
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, str) and token:
            return value.replace(token, "[REDACTED]")
        return value

    body = json.dumps(redact(data), ensure_ascii=False, sort_keys=True, default=str)
    return body if len(body) <= limit else body[:limit] + "…[truncated]"


def _failure_diagnostics(row):
    phase_names = ("provision_api", "dns_lookup", "gateway_poll", "total")
    elapsed = {name: row.get(f"phase_{name}_elapsed_ms", "NOT ATTEMPTED") for name in phase_names}
    error = row.get("poll_error") or row.get("dns_error") or row.get("error") or "No HTTP 200 was received"
    reason = (
        f"provision_http_status={row.get('provision_http_status')}; "
        f"provision_response_body={row.get('provision_response_body_truncated', 'NOT RECEIVED')}; "
        f"last_probe_status_code={row.get('last_probe_status_code', 'NOT ATTEMPTED')}; "
        f"probe_url={row.get('probe_url', 'NOT CONFIGURED')}; "
        f"probe_scheme={row.get('probe_url_scheme', 'NOT CONFIGURED')}; "
        f"probe_host={row.get('probe_url_host', 'NOT CONFIGURED')}; "
        f"Host={row.get('probe_host_header', 'NOT CONFIGURED')}; "
        f"error={error}; elapsed_ms_by_phase={json.dumps(elapsed, sort_keys=True)}"
    )
    return reason, elapsed


async def _resolve(hostname):
    loop = asyncio.get_running_loop()
    return await loop.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)


def _stages(timings):
    # The API returns stage durations in timings_ms, not wall-clock event times.
    source_map = {"ipam_allocate": "allocate", "neutron_port": "port",
                  "nova_active": "server_active", "health_probe": "health",
                  "gateway_rule": "sync"}
    return {name: timings.get(api_key) for name, api_key in source_map.items()}


def _save_chart(rows, path):
    stage_keys = ["ipam_allocate", "neutron_port", "nova_active", "health_probe", "gateway_rule"]
    good = [row for row in rows if row.get("success") and
            all(row.get(f"stage_{key}_ms") is not None for key in stage_keys) and
            row.get("api_elapsed_ms") is not None and row.get("dns_elapsed_ms") is not None and
            row.get("gateway_wait_ms") is not None]
    if not good:
        return False
    names = [f"R{row['run_index']}" for row in good]
    stage_labels = ["IPAM allocate", "Neutron port", "Nova ACTIVE", "Health probe", "Gateway rule sync"]
    bottoms = [0.0] * len(good)
    fig, ax = plt.subplots(figsize=(12, 6))
    for key, label in zip(stage_keys, stage_labels):
        vals = [float(row[f"stage_{key}_ms"]) / 1000.0 for row in good]
        ax.bar(names, vals, bottom=bottoms, label=label)
        bottoms = [b + v for b, v in zip(bottoms, vals)]
    residual = [float(row["api_residual_ms"]) / 1000.0 for row in good]
    ax.bar(names, residual, bottom=bottoms, label="API elapsed minus reported stages")
    bottoms = [b + v for b, v in zip(bottoms, residual)]
    dns = [float(row["dns_elapsed_ms"]) / 1000.0 for row in good]
    ax.bar(names, dns, bottom=bottoms, label="DNS lookup")
    bottoms = [b + v for b, v in zip(bottoms, dns)]
    wait = [float(row["gateway_wait_ms"]) / 1000.0 for row in good]
    ax.bar(names, wait, bottom=bottoms, label="Post-response gateway wait")
    ax.set_xlabel("Sequential run")
    ax.set_ylabel("Duration (seconds)")
    ax.set_title(f"T1 provisioning latency stages (successful n={len(good)})")
    ax.legend(loc="best", fontsize="small")
    plt.xticks(rotation=45)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return True


async def run_t1(cfg: Dict[str, Any], *, smoke: bool = False) -> Dict[str, Any]:
    cp = cfg["control_plane"]
    network = cfg["network"]
    bench_cfg = cfg["benchmark"]
    base_dir = Path(__file__).resolve().parents[1]
    raw_dir = base_dir / "results" / "raw"
    chart_dir = base_dir / "results" / "charts"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_path = raw_dir / f"t1_provisioning_{timestamp}.csv"
    summary_path = raw_dir / f"t1_provisioning_{timestamp}_summary.json"
    chart_path = chart_dir / f"t1_provisioning_stages_{timestamp}.png"

    token = os.environ.get("ADMIN_TOKEN", "")
    vip = str(network.get("public_vip", "")).strip()
    domain = str(network.get("domain", "")).strip()
    errors = []
    if not token:
        errors.append("ADMIN_TOKEN is unset; T1 cannot authenticate")
    if not vip:
        errors.append("PUBLIC_VIP_IP is unset; gateway Host-header polling target is unknown")
    if not domain:
        errors.append("ROUTING_DOMAIN is unset; sandbox subdomains cannot be constructed")
    if errors:
        summary = {"test": "T1_provisioning_latency", "status": "NOT EXECUTED",
                   "reason": errors, "n": 0, "samples": [], "chart_generated": False}
        save_raw_csv(raw_path, [{"timestamp_utc": _utc(), "status": "NOT EXECUTED",
                                 "reason": "; ".join(errors)}])
        save_summary_json(summary_path, summary)
        print("T1 NOT EXECUTED: " + "; ".join(errors))
        return summary

    count = 1 if smoke else int(bench_cfg.get("t1_runs", 30))
    ttl = int(bench_cfg.get("t1_lease_ttl_seconds", 3600))
    poll_timeout = float(bench_cfg.get("t1_poll_timeout_seconds", 60))
    poll_interval = float(bench_cfg.get("t1_poll_interval_seconds", 0.5))
    scheme = str(network.get("gateway_scheme", "http")).strip() or "http"
    target_vip = vip if "://" in vip else f"{scheme}://{vip}"
    probe_url = target_vip.rstrip("/") + "/"
    probe_parts = urlsplit(probe_url)
    rows: List[Dict[str, Any]] = []
    created_names: List[str] = []
    client = AsyncControlPlaneClient(cp["base_url"], token,
                                     timeout=float(cp.get("request_timeout_seconds", 180)))
    try:
        try:
            health = await client.health()
        except Exception as exc:
            reason = f"Control plane health request failed; no sandbox was provisioned: {type(exc).__name__}: {exc}"
            summary = {"test": "T1_provisioning_latency", "status": "NOT EXECUTED",
                       "reason": [reason], "n": 0, "samples": [], "chart_generated": False}
            save_raw_csv(raw_path, [{"timestamp_utc": _utc(), "status": "NOT EXECUTED", "reason": reason}])
            save_summary_json(summary_path, summary)
            print(f"T1 NOT EXECUTED: {reason}")
            return summary
        if health.status_code != 200:
            reason = f"Control plane health returned HTTP {health.status_code}; no sandbox was provisioned"
            summary = {"test": "T1_provisioning_latency", "status": "NOT EXECUTED",
                       "reason": [reason], "n": 0, "samples": [], "chart_generated": False}
            save_raw_csv(raw_path, [{"timestamp_utc": _utc(), "status": "NOT EXECUTED", "reason": reason}])
            save_summary_json(summary_path, summary)
            print(f"T1 NOT EXECUTED: {reason}")
            return summary

        run_prefix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        for run_index in range(1, count + 1):
            team = f"bench-t1-{run_prefix.lower()}-{run_index:02d}"
            hostname = f"{team}.{domain}"
            row: Dict[str, Any] = {
                "run_index": run_index, "team": team, "subdomain": hostname,
                "success": False, "status": "NOT STARTED", "error": "",
                "benchmark_started_utc": _utc(),
                "stage_timing_source": "API timings_ms duration fields; exact stage UTC timestamps are not returned by the API",
                "provision_http_status": "NOT RECEIVED",
                "provision_response_body_truncated": "NOT RECEIVED",
                "last_probe_status_code": "NOT ATTEMPTED",
                "probe_url": probe_url,
                "probe_url_scheme": probe_parts.scheme,
                "probe_url_host": probe_parts.netloc,
                "probe_host_header": hostname,
                "probe_error": "NOT ATTEMPTED",
                "phase_dns_lookup_elapsed_ms": "NOT ATTEMPTED",
                "phase_gateway_poll_elapsed_ms": "NOT ATTEMPTED",
            }
            created_names.append(team)
            start_perf = time.perf_counter()
            api_start_perf = start_perf
            dns_start = None
            poll_start = None
            try:
                api_response = await client.provision_sandbox(team, ttl=ttl)
                api_elapsed = api_response.elapsed_seconds
                row["phase_provision_api_elapsed_ms"] = api_elapsed * 1000.0
                row["api_request_started_utc"] = api_response.started_utc
                row["api_response_utc"] = api_response.finished_utc
                row["api_elapsed_ms"] = api_elapsed * 1000.0
                row["api_status"] = api_response.status_code
                row["provision_http_status"] = api_response.status_code
                row["provision_response_body_truncated"] = _response_body(api_response.data)
                row["api_response_state"] = api_response.data.get("state", "")
                timings = api_response.data.get("timings_ms", {})
                stages = _stages(timings if isinstance(timings, dict) else {})
                row["api_reported_total_ms"] = timings.get("total") if isinstance(timings, dict) else None
                for stage, value in stages.items():
                    row[f"stage_{stage}_ms"] = value

                if api_response.status_code not in (200, 201):
                    row["status"] = "PROVISION_FAILED"
                    row["error"] = str(api_response.data.get("error", api_response.data.get("raw", f"HTTP {api_response.status_code}")))
                    row["total_latency_ms"] = (time.perf_counter() - start_perf) * 1000.0
                    continue

                row["status"] = "PROVISIONED"
                row["sandbox_id"] = api_response.data.get("sandbox_id", team)
                row["fixed_ip"] = api_response.data.get("fixed_ip", "")
                row["server_id"] = api_response.data.get("server_id", "")
                row["hostname_from_api"] = api_response.data.get("hostname", "")
                try:
                    dns_start = time.perf_counter()
                    row["dns_lookup_started_utc"] = _utc()
                    dns_info = await _resolve(hostname)
                    row["dns_resolved"] = True
                    row["dns_addresses"] = ";".join(_resolved_ips(dns_info))
                    row["dns_error"] = ""
                except Exception as exc:
                    row["dns_resolved"] = False
                    row["dns_addresses"] = ""
                    row["dns_error"] = f"{type(exc).__name__}: {exc}"
                finally:
                    dns_end = time.perf_counter()
                    row["dns_lookup_finished_utc"] = _utc()
                    row["dns_elapsed_ms"] = (dns_end - dns_start) * 1000.0
                    row["phase_dns_lookup_elapsed_ms"] = row["dns_elapsed_ms"]

                poll_start = time.perf_counter()
                poll_result: PollResult = await wait_until_http_200(
                    probe_url, hostname,
                    timeout=poll_timeout, interval=poll_interval,
                    request_timeout=float(bench_cfg.get("t1_http_timeout_seconds", 3)),
                )
                row["poll_started_utc"] = poll_result.started_utc
                row["first_http_200_utc"] = poll_result.first_200_utc
                row["first_http_200_perf_counter"] = poll_result.first_200_perf_counter
                row["poll_attempts"] = poll_result.attempts
                row["poll_status"] = poll_result.status_code
                row["last_probe_status_code"] = (poll_result.status_code if poll_result.status_code else "NO HTTP RESPONSE")
                row["gateway_wait_ms"] = poll_result.elapsed_seconds * 1000.0
                row["phase_gateway_poll_elapsed_ms"] = row["gateway_wait_ms"]
                row["poll_error"] = poll_result.error
                row["probe_error"] = poll_result.error or ("" if poll_result.success else "No HTTP 200 response")
                row["success"] = poll_result.success
                row["status"] = "SUCCESS" if poll_result.success else "ROUTE_TIMEOUT"
                row["total_latency_ms"] = (time.perf_counter() - start_perf) * 1000.0
                row["client_post_to_first_http_200_ms"] = (
                    (poll_result.first_200_perf_counter - api_response.started_perf_counter) * 1000.0
                    if poll_result.first_200_perf_counter is not None else None)
                numeric_stages = [float(x) for x in stages.values() if x is not None]
                row["api_residual_ms"] = api_elapsed * 1000.0 - sum(numeric_stages)
            except Exception as exc:
                row["status"] = "ERROR"
                row["error"] = f"{type(exc).__name__}: {exc}"
                row["total_latency_ms"] = (time.perf_counter() - start_perf) * 1000.0
                if "phase_provision_api_elapsed_ms" not in row:
                    row["phase_provision_api_elapsed_ms"] = (time.perf_counter() - api_start_perf) * 1000.0
                if dns_start is not None and "phase_dns_lookup_elapsed_ms" not in row:
                    row["phase_dns_lookup_elapsed_ms"] = (time.perf_counter() - dns_start) * 1000.0
                if poll_start is not None and "phase_gateway_poll_elapsed_ms" not in row:
                    row["phase_gateway_poll_elapsed_ms"] = (time.perf_counter() - poll_start) * 1000.0
                if poll_start is not None and row.get("last_probe_status_code") == "NOT ATTEMPTED":
                    row["last_probe_status_code"] = "NO HTTP RESPONSE"
                    row["probe_error"] = row["error"]
            finally:
                row["phase_total_elapsed_ms"] = (time.perf_counter() - start_perf) * 1000.0
                if not row.get("success"):
                    failure_reason, elapsed_by_phase = _failure_diagnostics(row)
                    row["failure_reason"] = failure_reason
                    row["elapsed_ms_by_phase"] = elapsed_by_phase
                    print(f"T1 run {run_index} did not reach HTTP 200: {failure_reason}")
                rows.append(row)
                # Cleanup is scoped to the unique name generated in this test.
                outcomes = await cleanup_created_sandboxes(client, [team], verbose=False)
                row["cleanup_success"] = bool(outcomes and outcomes[0].get("deleted"))
                row["cleanup_error"] = outcomes[0].get("error", "") if outcomes else "no cleanup result"
                if row["cleanup_success"]:
                    created_names.remove(team)

        successful = [r for r in rows if r.get("success")]
        stage_stats = {}
        for stage in ("ipam_allocate", "neutron_port", "nova_active", "health_probe", "gateway_rule"):
            values = [r[f"stage_{stage}_ms"] for r in rows
                      if r.get(f"stage_{stage}_ms") is not None]
            stage_stats[stage] = compute_stats(values) if values else "NOT EXECUTED: API supplied no samples for this stage"
        def stats_or_reason(values, reason):
            return compute_stats(values) if values else f"NOT EXECUTED: {reason}"
        summary = {
            "test": "T1_provisioning_latency", "status": "EXECUTED",
            "timestamp_utc": _utc(), "planned_runs": count, "n": len(rows),
            "successful_runs": len(successful), "failed_runs": len(rows) - len(successful),
            "success_rate": (len(successful) / len(rows)) if rows else None,
            "failure_reasons": [
                {
                    "run_index": row["run_index"], "team": row["team"],
                    "reason": row["failure_reason"],
                    "provision_http_status": row["provision_http_status"],
                    "provision_response_body_truncated": row["provision_response_body_truncated"],
                    "last_probe_status_code": row["last_probe_status_code"],
                    "probe_url": row["probe_url"],
                    "probe_url_scheme": row["probe_url_scheme"],
                    "probe_url_host": row["probe_url_host"],
                    "probe_host_header": row["probe_host_header"],
                    "probe_error": row["probe_error"],
                    "elapsed_ms_by_phase": row["elapsed_ms_by_phase"],
                }
                for row in rows if not row.get("success")
            ],
            "metrics_ms": {
                "api_elapsed": stats_or_reason([r["api_elapsed_ms"] for r in rows if "api_elapsed_ms" in r], "no API responses were received"),
                "client_post_to_first_http_200": stats_or_reason([r["client_post_to_first_http_200_ms"] for r in successful if r.get("client_post_to_first_http_200_ms") is not None], "no sandbox reached HTTP 200 through the VIP"),
                "total_latency_to_first_http_200": stats_or_reason([r["total_latency_ms"] for r in successful if "total_latency_ms" in r], "no sandbox reached HTTP 200 through the VIP"),
                "dns_lookup": stats_or_reason([r["dns_elapsed_ms"] for r in rows if "dns_elapsed_ms" in r], "no DNS lookup completed"),
                **stage_stats,
            },
            "stage_absolute_timestamps": "Unavailable: API returns stage durations in timings_ms, not stage event timestamps.",
            "cold_warm_status": "NOT EXECUTED: image cache state cannot be controlled or verified by this harness.",
            "raw_csv": str(raw_path), "chart_png": str(chart_path),
        }
        save_raw_csv(raw_path, rows)
        chart_made = _save_chart(rows, chart_path)
        summary["chart_generated"] = chart_made
        if not chart_made:
            summary["chart_png"] = None
            summary["chart_reason"] = "NOT GENERATED: no successful samples had complete API stage durations and gateway wait measurements"
        save_summary_json(summary_path, summary)
        print(f"T1 EXECUTED: {len(successful)}/{len(rows)} reached HTTP 200")
        print(f"Raw CSV: {raw_path}")
        print(f"Summary JSON: {summary_path}")
        print(f"Stacked chart: {chart_path if chart_made else 'not generated (no successful samples)'}")
        return summary
    finally:
        # Also attempt cleanup if cancellation/unexpected failure interrupted the loop.
        if created_names:
            await cleanup_created_sandboxes(client, created_names, verbose=False)
        await client.close()
