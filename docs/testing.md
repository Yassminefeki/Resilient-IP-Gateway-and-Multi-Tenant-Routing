# Testing and validation model

This document separates what is safe to validate locally from what requires a live FelCloud/OpenStack environment.

## Validation categories

### 1. Local, no infrastructure required

These are the safest validation checks:

- `go test` on the control-plane module where the code is a valid Go package
- syntax checks for shell scripts and config files
- doc consistency checks and repository audits
- mock/test-only logic that does not reach real networked services

### 2. Local with mock or synthetic state

These checks use code-level mocks or local runtime state instead of live infrastructure:

- mock provisioning modes
- local SQLite-backed logic validation
- generated config validation without live remote deployment

### 3. Requires live OpenStack or gateway infrastructure

These are not local-only validations and must be treated as live-environment tasks:

- true gateway failover on a running pair
- OpenStack VM provisioning and teardown against a real stack
- real route validation via public IP / VIP
- live DNS and routing checks
- production-quality rollback testing on the live gateway nodes

These are explicitly not verified unless the exact environment and authorization are provided.

## Safe commands to run in a local repo checkout

Use commands only where the repository has the relevant toolchain present:

```bash
cd /home/yassmine/felcloud_final/dev/felcloud

git --no-pager status --porcelain --branch
cd controlplane && go test ./...
cd controlplane && go build ./...
cd .. && bash -n scripts/*.sh
```

If the environment includes shellcheck and benchmark tooling, additional checks may include:

```bash
shellcheck scripts/*.sh
python3 -m unittest discover -s bench/tests
```

## Benchmark vs unit-test boundary

The repository includes both live benchmark scenarios and Python unit tests for helper logic. The distinction is important:

- `bench/run_all.sh` is the canonical driver for the ordered benchmark sequence.
- `bench/tests/*.py` files are the actual benchmark scenario implementations when they represent a live scenario.
- `bench/tests/test_t2_concurrent_stress_unit.py` is a unit-test module for parsing and decision logic, not a separate benchmark scenario by itself.
- T2–T7 remain staged or deferred; T1 is the first fully active live scenario in the current repository state.

This should be treated as a harness boundary, not as a claim that every test file is a live benchmark.

## Benchmark and evidence model

The benchmark suite under [../bench](../bench) is useful for measuring local or mock behavior, but it is not equivalent to live failover validation on real infrastructure. The generated report files and benchmark runner provide useful evidence, but the report should always distinguish between mock data and real measured results.

## Required live validation checklist

Before any claim of failover or production readiness, the environment should validate:

1. public DNS resolves to the expected entry IP
2. VIP ownership transitions correctly between gateways
3. HAProxy remains healthy and responds with the expected config
4. route selection matches the requested host header
5. control-plane outage does not break the data plane’s existing request flow
6. rollback is tested under a real gateway config change
7. isolation and cleanup remain correct across sandbox lifecycle events

## Not verified in this audit

The following remain outside the verified local scope:

- real OpenStack stack behavior
- live failover under actual gateway fault conditions
- external DNS behaviour against real public records
- production-grade benchmark results against a running cluster

This is intentionally explicit: the repository contains the code and operational model, but live infrastructure validation remains a separate task.
