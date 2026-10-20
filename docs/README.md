# Documentation index

This directory is the maintainable reference set for the FelCloud repository. It reflects the actual implementation in the current tree and intentionally distinguishes the product architecture from older historical notes and release snapshots.

## Start here

- [architecture.md](architecture.md) — actual runtime architecture, boundaries, and request path
- [deployment.md](deployment.md) — runtime locations, stack composition, and deployment flow
- [reference.md](reference.md) — file-level traceability across control plane, infrastructure, gateway logic, tests, and scripts
- [security.md](security.md) — authentication, SSH trust, gateway access, input validation, and secrets handling
- [testing.md](testing.md) — local, mock, and live-infrastructure validation categories and safe commands
- [design-decisions.md](design-decisions.md) — SQLite choice, security trade-offs, and scale boundaries
- [api/README.md](api/README.md) — API overview and links to endpoint guides
- [api/gateways.md](api/gateways.md) — gateway API contract
- [api/sandboxes-ipam.md](api/sandboxes-ipam.md) — sandbox lifecycle and IPAM API
- [api/operations.md](api/operations.md) — health, reconciliation, events, config, and dashboard routes

For Go work from the repo root, the workspace is normalized through the root `go.work` file so the separate `controlplane/` and `infra/` modules resolve without ambiguity.

## Repository intent

FelCloud implements a resilient IP gateway and routing platform for OpenStack-based sandbox environments. The verified current implementation is a Go control plane plus Pulumi/Ansible-driven infrastructure, with HAProxy and Keepalived on the gateway nodes.

The request path remains:

Client → public edge / floating IP / VIP → active gateway → HAProxy → sandbox backend

The repository is not a pure Python control-plane implementation. The Go code under `controlplane/` is the active runtime logic for the current source tree. Historical Python references are retained only as documentation drift or old plans, not as the operational source of truth.


## Main runtime components

| Area | Path | Role |
|---|---|---|
| Control plane | [../controlplane](../controlplane) | Go REST API, IPAM, reconciliation, provisioning, failover, rollback, gateway sync |
| Infrastructure as code | [../infra](../infra) | Pulumi OpenStack network, router, floating IP, VIP, bastion, gateway security, sandbox resources |
| Gateway configuration | [../ansible](../ansible) | HAProxy and Keepalived integration, config rendering, DPA deployment, inventory generation |
| Dashboard | [../dashboard](../dashboard) | UI served by the Go control plane |
| Benchmarks | [../bench](../bench) | Benchmark harness and test evidence |
| Scripts | [../scripts](../scripts) | Deployment, DNS sync, sandbox provisioning and support tooling |

## Important notes

- The repo includes both Go and infrastructure modules; these are intentionally separate concerns.
- Local runtime artifacts such as SQLite DB files and compiled binaries are operational state, not source design.
- Live OpenStack or gateway failover validation is explicitly labeled as not verified unless the environment is available and the action is authorized.
