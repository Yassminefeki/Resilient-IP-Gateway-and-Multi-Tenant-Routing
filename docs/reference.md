# File and component reference

This file is the working map for the codebase. It is intended to answer: "Which file should I read if I want to understand or change this behavior?"

## Application entry points

| Area | Path | Purpose |
|---|---|---|
| Control-plane CLI and HTTP server | [../controlplane/main.go](../controlplane/main.go) | Starts the Go service, initializes env/config, and routes CLI actions |
| API router | [../controlplane/server.go](../controlplane/server.go) | Registers routes for sandboxes, leases, gateways, config, and dashboard |
| API auth and request security | [../controlplane/auth.go](../controlplane/auth.go) | Authn/authz, CORS, rate limiting, JSON validation |
| Dashboard web assets | [../dashboard](../dashboard) | Static UI served by the control plane |
| Pulumi stack entrypoint | [../infra/main.go](../infra/main.go) | Creates the OpenStack network, router, bastion, gateways, VIP, and security resources |

## Control plane logic

| File | Responsibility |
|---|---|
| [../controlplane/ipam.go](../controlplane/ipam.go) | SQLite-backed IPAM, lease allocation, quarantine, and schema migration |
| [../controlplane/provisioning.go](../controlplane/provisioning.go) | sandbox provisioning lifecycle and OpenStack integration |
| [../controlplane/reconcile.go](../controlplane/reconcile.go) | reconcile and cleanup logic for partial or stale state |
| [../controlplane/reaper.go](../controlplane/reaper.go) | cleanup and expiration tracking for old resources |
| [../controlplane/teardown.go](../controlplane/teardown.go) | teardown flow and resource deallocation behavior |
| [../controlplane/gateway_sync.go](../controlplane/gateway_sync.go) | config generation and sync to gateway nodes |
| [../controlplane/gateway_deploy.go](../controlplane/gateway_deploy.go) | deploy generation and rollback/transaction management |
| [../controlplane/gateway_failover.go](../controlplane/gateway_failover.go) | failover handling and active/passive state transitions |
| [../controlplane/gateway_probe.go](../controlplane/gateway_probe.go) | health/probe logic and probe state |
| [../controlplane/health_probe.go](../controlplane/health_probe.go) | health-check logic and gateway SSH checks |
| [../controlplane/events.go](../controlplane/events.go) | event persistence and reporting |
| [../controlplane/dashboard.go](../controlplane/dashboard.go) | UI asset serving and dashboard-specific behavior |
| [../controlplane/dpa_client.go](../controlplane/dpa_client.go) | HAProxy DPA client integration |

## Infrastructure and network definitions

| File | Responsibility |
|---|---|
| [../infra/network.go](../infra/network.go) | edge, management, and sandbox networks |
| [../infra/router.go](../infra/router.go) | external router and attached subnet links |
| [../infra/vip.go](../infra/vip.go) | VIP port definition |
| [../infra/gateways.go](../infra/gateways.go) | gateway VM definitions |
| [../infra/bastion.go](../infra/bastion.go) | bastion VM, networking, and IP handling |
| [../infra/security.go](../infra/security.go) | security groups and access policy |
| [../infra/gateway_ports.go](../infra/gateway_ports.go) | individual management and edge port attachment for each gateway |
| [../infra/floating_ip.go](../infra/floating_ip.go) | public IP exposure logic |
| [../infra/config.go](../infra/config.go) | configuration struct and validation |

## Ansible and gateway configuration

| File or directory | Responsibility |
|---|---|
| [../ansible/site.yml](../ansible/site.yml) | gateway playbook execution |
| [../ansible/haproxy-transaction.yml](../ansible/haproxy-transaction.yml) | transactional HAProxy deployment path |
| [../ansible/inventory](../ansible/inventory) | host inventory generation |
| [../ansible/roles/haproxy](../ansible/roles/haproxy) | HAProxy and DPA deployment |
| [../ansible/roles/keepalived](../ansible/roles/keepalived) | VRRP semantics and health scripts |
| [../ansible/group_vars](../ansible/group_vars) | gateway variable definitions and vault-backed values |

## Benchmark and evidence

| Path | Responsibility |
|---|---|
| [../bench/run_all.sh](../bench/run_all.sh) | benchmark runner and canonical test order |
| [../bench/tests](../bench/tests) | benchmark test scripts and specifics |
| [../bench/report](../bench/report) | generated report and aggregate evidence |

## Operational scripts

| Path | Responsibility |
|---|---|
| [../scripts/demo-live-failover.sh](../scripts/demo-live-failover.sh) | live failover demonstration |
| [../scripts/designate-dns-sync.sh](../scripts/designate-dns-sync.sh) | DNS sync scripting |
| [../scripts/discover-felcloud.sh](../scripts/discover-felcloud.sh) | environment discovery |
| [../scripts/provision-sandbox.sh](../scripts/provision-sandbox.sh) | sandbox provisioning helper |
| [../scripts/renew-ssl.sh](../scripts/renew-ssl.sh) | certificate renewal |
| [../scripts/setup-ssl.sh](../scripts/setup-ssl.sh) | certificate installation and config |

## Repository documentation

| Path | Purpose |
|---|---|
| [../README.md](../README.md) | product overview and entry point |
| [README.md](README.md) | documentation index and navigation hub |
| [architecture.md](architecture.md) | runtime architecture and request path |
| [deployment.md](deployment.md) | deployment layout and runtime placement |
| [security.md](security.md) | security model and operational boundaries |
| [testing.md](testing.md) | validation model and safe local/live checks |
| [api/README.md](api/README.md) | API overview and route index |
| [api/gateways.md](api/gateways.md) | gateway API reference |
| [api/sandboxes-ipam.md](api/sandboxes-ipam.md) | sandbox and IPAM API |
| [api/operations.md](api/operations.md) | health, reconciliation, events, config, and dashboard API |

## Important operational notes

- The Go implementation is the source of truth for the current runtime behavior.
- Historical docs remain valuable as evidence but may not reflect current runtime details.
- Local SQLite files and compiled outputs are runtime state and should not be treated as source documentation.
