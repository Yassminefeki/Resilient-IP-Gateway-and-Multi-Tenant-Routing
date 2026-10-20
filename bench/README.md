# FelCloud benchmark harness

## Readiness and safety

Start with the read-only preflight:

```bash
python3 bench/preflight.py
```

It checks the control plane `/health`, confirms `ADMIN_TOKEN` is set without displaying it, runs `openstack token issue`, SSHes through the configured bastion to both configured gateway destinations, checks Nova and Neutron quota headroom for the planned concurrency, and verifies that cleanup excludes `team1` and `team2`. It overwrites `ENVIRONMENT.md` with observations from that invocation. It does not provision, delete, stop, reload, or alter resources.

Set the required environment values before preflight. The precise set depends on your SSH setup and sandbox flavor:

```bash
export CONTROL_PLANE_URL=https://control-plane.example
export OS_CLOUD=your-cloud
export BENCH_SSH_USER=ansible
export BENCH_BASTION_HOST=bastion.example
export SSH_KEY_PATH=/path/to/private-key
export BENCH_PRIMARY_HOST=gateway-primary.example
export BENCH_STANDBY_HOST=gateway-standby.example
export BENCH_SANDBOX_FLAVOR=your-sandbox-flavor
```

Provide `ADMIN_TOKEN` through your secret manager or a private shell environment; do not copy a placeholder or the token itself into this document.

Install the pinned runtime dependencies. The harness has no mock mode or mock based verification; verification uses a real one sandbox smoke run against the configured control plane and OpenStack.

## Canonical runner and test boundary

The repo has two distinct categories of benchmark-related checks:

- Live benchmark scripts under `bench/tests/*.py` are the scenario implementations.
- The root-runner `bench/run_all.sh` is the canonical orchestration entry point for running the ordered benchmark sequence.
- `bench/tests/test_t2_concurrent_stress_unit.py` is a unit test for helper logic and not a separate benchmark scenario or a second live T2 run.

This distinction matters because the repository currently has a staged benchmark model: T1 is the first actively used live scenario, while T2–T7 are deferred until the live environment and validation conditions are ready. In other words, the script order is the authoritative runner, but the actual live coverage is still narrower than the full test catalog suggests.

```bash
python3 -m venv bench/.venv
bench/.venv/bin/pip install -r bench/requirements.txt
```

After preflight succeeds, verify T1 against the live system with `bench/.venv/bin/python bench/tests/t1_provisioning_latency.py --smoke`. Do not run that command until your preflight review is complete. A failed live run should be reported with its actual terminal error and generated raw record; harness changes will be based on that evidence.

The preflight reads the selected flavor's vCPU and RAM values from OpenStack before calculating quota headroom.

The gateway host values are exact SSH destinations allowed for gateway operations. They have no defaults. The control plane and cloud credentials come from environment variables or the OpenStack CLI's normal `clouds.yaml` configuration. Do not put secrets in `config.yaml` or commit them.

`safety_gates.resource_prefix` and `cleanup_name_prefix` must both remain exactly `bench-`. `protected_names` must include `team1` and `team2`. Cleanup must require the `bench-` prefix and reject protected names. A missing or inconsistent gate makes a test print an actionable error and exit without test actions.

## Test commands

The implemented T1 command accepts `--smoke` for one real sandbox provision/cleanup and `--dry-run` to print planned actions only. Dry-run does not contact services, write result samples, or simulate outcomes:

```bash
bench/.venv/bin/python bench/tests/t1_provisioning_latency.py --smoke --dry-run
```

T2–T7 are deferred and have no scenario runners. They must not be treated as verification; implementation will continue after a successful real T1 smoke run has been reviewed.

### T1 — provisioning latency

After a passing preflight, run the 30 sequential samples with:

```bash
bench/.venv/bin/python bench/tests/t1_provisioning_latency.py
```

Run one sample with `--smoke`:

```bash
bench/.venv/bin/python bench/tests/t1_provisioning_latency.py --smoke
```

Each run provisions a unique `bench-t1-*` sandbox, records the control plane's `timings_ms`, performs a DNS lookup, polls the configured VIP with the sandbox hostname in `Host` until HTTP 200 or timeout, then deletes that sandbox in `finally` cleanup. The raw CSV records every attempt; summary JSON and a stacked chart are written under `bench/results/` when a real run produces their source data. The summary reports the client-side monotonic time from the start of the POST request through the first HTTP 200 beside the control plane's reported stage durations. The API returns stage durations rather than absolute event timestamps, so no absolute stage timestamps are claimed. Cold/warm image cache classification is NOT EXECUTED because this harness cannot control or verify image cache state.

**Scoring evidence:** T1 provides baseline latency and provisioning-path evidence, but it does not map directly to the named 15-point stress, 10-point teardown, or 5-point isolation criteria.

Expected files from a run are `bench/results/raw/t1_provisioning_<UTC timestamp>.csv`, `bench/results/raw/t1_provisioning_<UTC timestamp>_summary.json`, and, when at least one run reaches HTTP 200, `bench/results/charts/t1_provisioning_stages_<UTC timestamp>.png`. A run that cannot start writes a NOT EXECUTED CSV and summary with its reason.

## Scoring evidence by test

- **T1:** Provisioning latency baseline; no direct named 15/10/5-point criterion.
- **T2:** Concurrency, success rate, duplicate IP, and route isolation evidence for the 15-point stress criterion.
- **T3:** Gateway HA failover behavior; no named 15/10/5-point criterion.
- **T4:** IP reclamation/reuse evidence supporting the 10-point teardown criterion.
- **T5:** Lease expiry and complete resource cleanup evidence for the 10-point teardown criterion.
- **T6:** Reload/rollback reliability; no named 15/10/5-point criterion.
- **T7:** Cross-sandbox and management-plane isolation evidence for the 5-point isolation criterion.

Run the suite entry point in dry-run mode:

```bash
bash bench/run_all.sh --smoke --dry-run
```

`bash bench/run_all.sh` is not a supported benchmark command yet because T2–T7 are deferred. Run T1 directly after preflight. The report generator includes only actual T1 records and identifies deferred scenarios without reporting invented samples.

## Outputs

- Preflight output is printed to the terminal; the latest environment snapshot is written to [ENVIRONMENT.md](ENVIRONMENT.md).
- Test attempt records are written to `bench/results/raw/<test>_<UTC timestamp>.csv` and matching `_summary.json` files.
- The report generator writes `bench/report/BENCHMARK_REPORT.md`.
- Charts belong in `bench/results/charts/`; no chart is produced without real samples.

Never treat a dry-run, preflight, or `NOT EXECUTED` record as a benchmark measurement.
