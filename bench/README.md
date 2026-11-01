# FelCloud Benchmark & Verification Suite

This directory contains the automated benchmark and validation suite used to evaluate FelCloud against all challenge specifications.

## Running Benchmarks via Docker (Recommended)

The benchmark harness is packaged as a standalone container target (`bench`) in [Dockerfile](../Dockerfile) and configured under the `bench` profile in [docker-compose.yml](../docker-compose.yml).

### 1. Dry-Run Verification (Safe, Zero-Cloud Mode)
Runs all benchmark preflight checks and scenario declarations without issuing network mutations:
```bash
docker compose --profile bench run --rm bench
```

### 2. Output & Plots
Results, summaries, and charts are mapped directly to your host at `./bench/results`:
- Raw metrics: `bench/results/raw/<test_id>.csv`
- Machine-readable summary: `bench/results/raw/<test_id>_summary.json`
- Plots: `bench/results/charts/<test_id>.png`

---

## Suite Overview

The benchmark framework is written in Python 3 using `pytest`, `httpx`, and `matplotlib`:
- **Fail-Closed Safety Gates:** Every test validates cloud preflight conditions (safety prefixes, quota headroom, gateway accessibility) before executing actions.
- **Strict Evidence Collection:** Every test writes structured raw execution logs (`bench/results/raw/<test_id>.csv`), machine-readable summaries (`<test_id>_summary.json`), and visual charts (`bench/results/charts/<test_id>.png`).
- Published canonical runs are cataloged in [`bench/results/README.md`](results/README.md).

## Benchmark Test Matrix (T1–T7)

| Test ID | Scenario | Target vs Measured Empirical Reality | Key Metric & Methodology |
|---|---|---|---|
| **T1** | MicroVM Provisioning Latency | Target: p95 < 60 s<br>**Measured:** 90.0% success (27/30), p50: 217.1 s, p95: 234.4 s ([`133258Z`](results/raw/t1_provisioning_20261018T133258Z_summary.json)); 100% (1/1) smoke in 178.1 s ([`175400Z`](results/raw/t1_provisioning_20261018T175400Z_summary.json)) | End-to-end duration from HTTP POST creation request to first HTTP 200 via HAProxy VIP. Latency is dominated by guest OS cloud-init package installation (~145 s) and gateway dual-sync (~51 s); 3 failures experienced gateway reload context timeouts under rapid sequential testing. |
| **T2** | Concurrent Provisioning Stress | Target: 100% success at 10+ concurrency<br>**Measured:** 100% success (33/33 total across 3, 5, 10, 15 concurrency tiers; p50: 214.2 s, p95: 247.9 s; 0 IP collisions; [`201509Z`](results/raw/t2_concurrent_20261018T201509Z_summary.json)) | Evaluates burst concurrent allocations, verifying serialized SQLite immediate locking prevents race conditions and duplicate IP allocation. |
| **T3** | Gateway Failover & Resilience | Target: failover < 3 s<br>**Measured:** Bastion VIP failover in 1.36 s ([`145556Z`](results/raw/t3_failover_20261019T145556Z_summary.json)) and 1.13 s ([`174949Z`](results/raw/t3_failover_20261019T174949Z_summary.json)); HAProxy stop detection took 5.56–6.45 s due to deployed interval | Keepalived VRRP failover measurement during primary gateway degradation or process termination. Known positive-weight configuration defect documented and resolved. |
| **T4** | IP Recycling & Reallocation | Target: reallocation < 5 s<br>**Measured:** 100% clean teardown & immediate reallocation (p50: 1.87 s, p95: 2.12 s; [`214746Z`](results/raw/t4_ip_recycling_20261018T214746Z_summary.json)) | Measures rapid sandbox teardown and immediate IP reallocation, ensuring stale ARP and routing entries clear cleanly without collisions. |
| **T5** | Lease Expiry & Autonomous Teardown | Target: Complete automated teardown<br>**Measured:** 100% clean teardown on active/expiring leases ([`123746Z`](results/raw/t5_lease_expiry_20261019T123746Z_summary.json)); 3 leftover rows in `TEARDOWN_FAILED` fixed by reaper retry | Verifies the background reaper sweeps expired leases, removes OpenStack ports, and cleans up HAProxy maps. |
| **T6** | Gateway Reload & Atomic Rollback | Target: 0 dropped requests; rollback < 1 s<br>**Measured:** 0 dropped requests during syncs (`zero_sync_prober_drops: true`); total rollback took 9.4–12.6 s because 5s health soak window is included ([`142508Z`](results/raw/t6_reload_rollback_20261019T142508Z_summary.json)) | Evaluates zero-downtime HAProxy reload via Data Plane API and verifies atomic configuration rollback. Metric separated into commit duration and post-rollback health soak window. |
| **T7** | Multi-Tenant Network Isolation | Target: 0 forbidden connections<br>**Measured:** Inter-sandbox lateral movement blocked (team1, team2, sandbox_b); SSH port 22 defect on gateway sandbox NIC identified ([`133840Z`](results/raw/t7_isolation_20261019T133840Z_summary.json)) and resolved | Probes network isolation boundaries between tenant sandboxes. Host SSH daemon restricted to management network. |

---

## Native Execution (Alternative)

### 1. Prerequisites & Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r bench/requirements.txt
```

### 2. Dry-Run Verification (Safe Mode)
```bash
bash bench/run_all.sh --dry-run
```

### 3. Running Individual Tests Against a Live Cluster
To execute an individual test against a configured live environment:
```bash
# Set required runtime gates
export ADMIN_TOKEN="your-admin-token"
export PUBLIC_VIP_IP="203.0.113.119"
export ROUTING_DOMAIN="sandbox.example.com"
export DPA_PASS="your-dpa-password"
export BENCH_PRIMARY_HOST="10.20.10.24"
export BENCH_STANDBY_HOST="10.20.10.164"
export BENCH_BASTION_HOST="203.0.113.10"
export SSH_KEY_PATH="ansible/.ssh/id_rsa_felcloud"

# Run T1 in smoke mode (1 iteration)
python3 bench/tests/t1_provisioning_latency.py --smoke
```
