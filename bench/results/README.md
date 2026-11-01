# Benchmark Results

This directory contains the official published benchmark runs from the FelCloud Phase 3 evaluation. Uncited smoke and exploratory test artifacts have been pruned to preserve repository cleanliness.

All stored data is sanitized: internal laboratory IP addresses are mapped to RFC 5737 documentation ranges (`203.0.113.10` for bastion, `203.0.113.119` for gateway VIP) and domains map to `*.example.com`.

## Published Benchmark Runs

The suite includes 12 canonical runs covering tests T1 through T7:

| Test ID | Scenario | Run Timestamp | Files | Scope & Key Findings |
|---|---|---|---|---|
| **T1** | MicroVM Provisioning Latency | `20261018T133258Z` | CSV, JSON, PNG | Multi-iteration sequential provisioning measuring individual stage durations (IPAM allocation, OpenStack port binding, Designate DNS registration, HAProxy reload, and guest HTTP 200). |
| **T1** | MicroVM Provisioning Latency | `20261018T175400Z` | CSV, JSON, PNG | Final single-instance verification validating end-to-end sandbox creation and route availability. |
| **T2** | Concurrent Provisioning Stress | `20261018T201509Z` | CSV, JSON, PNG | Burst concurrency testing across increments (3, 5, 10, 15 concurrent creations) measuring p50/p95 latency and route isolation without IP conflicts. |
| **T2** | Concurrent Provisioning Stress | `20261018T211200Z` | CSV, JSON, PNG | Concurrency validation confirming lockless IPAM allocation consistency across worker threads. |
| **T3** | Gateway Failover & Resilience | `20261019T145556Z` | CSV, JSON, PNG | Keepalived VRRP failover benchmark measuring transition latency (< 3 s) from primary gateway (`gw1`) to backup gateway (`gw2`) during interface degradation. |
| **T3** | Gateway Failover & Resilience | `20261019T174949Z` | CSV, JSON, PNG | Secondary failover validation measuring hard process termination and state recovery after failback. |
| **T4** | IP Recycling & Reallocation | `20261018T214746Z` | CSV, JSON, PNG | Immediate IP reclaim and reuse benchmark verifying that stale ARP/route entries are cleared within 5 seconds. |
| **T4** | IP Recycling & Reallocation | `20261018T215336Z` | CSV, JSON, PNG | High-churn teardown and re-allocation measuring consistency under rapid IP recycling. |
| **T5** | Lease Expiry & Autonomous Teardown | `20261019T123746Z` | CSV, JSON, PNG | Background reaper validation verifying automated cleanup of expired leases, OpenStack ports, DNS records, and HAProxy maps. |
| **T6** | Gateway Reload & Atomic Rollback | `20261019T142508Z` | CSV, JSON, PNG | HAProxy reload benchmarking via Data Plane API validating zero dropped in-flight requests during configuration sync. |
| **T6** | Gateway Reload & Atomic Rollback | `20261019T142804Z` | CSV, JSON, PNG | Rollback resilience test verifying syntax rejection and automatic fallback to previous valid state upon injection of corrupt rules. |
| **T7** | Multi-Tenant Network Isolation | `20261019T133840Z` | CSV, JSON, PNG | Verifies tenant isolation boundaries, ensuring unauthorized cross-tenant network traffic is strictly rejected. |

## File Layout

- `raw/`: Machine-readable raw metrics as CSV (`<run_id>.csv`) and structured execution summaries (`<run_id>_summary.json`).
- `charts/`: Generated performance visualizations (`<run_id>.png` and `t1_provisioning_stages_<run_id>.png`).
