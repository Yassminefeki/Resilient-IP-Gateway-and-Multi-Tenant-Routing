<div align="center">

# FelCloud — Phase 2 Submission

### Resilient IP Gateway and Multi-Tenant Routing for OpenStack

**High-availability edge gateways · Host-based routing · IP address management · Automated sandbox lifecycle**

![OpenStack](https://img.shields.io/badge/OpenStack-FelCloud-ED1944?style=flat&logo=openstack&logoColor=white&labelColor=555555)
![Go](https://img.shields.io/badge/Control%20Plane-Go%20%2B%20SQLite-00ADD8?style=flat&logo=go&logoColor=white&labelColor=555555)
![Pulumi](https://img.shields.io/badge/Pulumi-Go-8A3391?style=flat&logo=pulumi&logoColor=white&labelColor=555555)
![Ansible](https://img.shields.io/badge/Ansible-Gateway%20Automation-EE0000?style=flat&logo=ansible&logoColor=white&labelColor=555555)
![HAProxy](https://img.shields.io/badge/HAProxy-L7%20Routing-106DA9?style=flat&logo=haproxy&logoColor=white&labelColor=555555)
![Keepalived](https://img.shields.io/badge/Keepalived-VRRP%20HA-2C7BB6?style=flat&labelColor=555555)
![Status](https://img.shields.io/badge/Submission-Phase%202-1D4ED8?style=flat&labelColor=555555)

</div>

## Overview

FelCloud provides a shared ingress layer for isolated OpenStack sandboxes. A pair of gateway instances uses Keepalived to own a virtual IP, while HAProxy routes requests to sandbox backends using the request hostname. A Go control plane manages leases, provisioning, health checks, gateway configuration, and lifecycle operations.

The control plane stores state in embedded SQLite. The rationale and scaling trade-offs are described in [Design decisions](docs/design-decisions.md).

## Architecture at a glance

FelCloud has three cooperating layers:

| Layer | Implementation | Responsibility |
|---|---|---|
| Infrastructure | Pulumi in Go, under [infra/](infra/) | Creates OpenStack networks, router, VIP port, security groups, gateways, bastion, and sandbox resources |
| Gateway runtime | Ansible, under [ansible/](ansible/) | Configures HAProxy, Keepalived, TLS, and the HAProxy Data Plane API |
| Control plane | Go service, under [controlplane/](controlplane/) | Provides the API, SQLite-backed IPAM, sandbox lifecycle, gateway health/sync, reconciliation, and dashboard serving |

Traffic follows this path: client → public edge/router → Keepalived VIP → active gateway → HAProxy → selected sandbox backend. The control plane manages this flow but is not itself in the client data path.

### Network model

| Network | CIDR | Purpose |
|---|---|---|
| `felcloud-edge` | `10.20.20.0/24` | Public-facing gateway network and VIP |
| `felcloud-mgmt` | `10.20.10.0/24` | Control-plane and gateway management |
| `felcloud-sandbox` | `10.20.30.0/24` | Isolated tenant backends |

The configured VIP is `10.20.20.246`; gateway private addresses and subnet definitions are specified by the Pulumi configuration and outputs. Public floating IPs and DNS records are environment-specific and should be read from the deployed stack rather than assumed from example values.

For the detailed architecture diagram and request/lifecycle flows, see [Architecture](docs/architecture.md) and [Deployment](docs/deployment.md).

## Main capabilities

- **Shared ingress:** hostname-based routing supports multiple tenant sandboxes behind the gateway pair.
- **Gateway availability:** Keepalived manages VIP ownership; HAProxy runs on both gateways.
- **IP lifecycle:** IPAM tracks allocation, release, quarantine, and reclamation.
- **Sandbox lifecycle:** the control plane coordinates provisioning, health checks, teardown, expiry, and recovery from stale state.
- **Safer gateway updates:** generated HAProxy configurations are validated and tracked as generations, with rollback support.
- **Operational visibility:** API endpoints and the dashboard expose sandbox, lease, gateway, event, and configuration-generation state.
- **Infrastructure automation:** Pulumi creates the cloud resources; Ansible configures gateway services.

These are implementation capabilities, not a guarantee that every live deployment has been exercised. See [Testing and validation](docs/testing.md) for the distinction between local checks and live OpenStack validation.

## Control-plane API

The HTTP API is served by the Go control plane. Protected routes use bearer-token authentication unless authentication is explicitly disabled. The API reference is split into focused documents so endpoint details and request/response contracts do not overwhelm this overview.

| Area | Representative endpoints | Reference |
|---|---|---|
| Gateway operations | Gateway status, DPA health, logs, events, generations, sync, rollback, failover | [Gateway API](docs/api/gateways.md) |
| Sandboxes and IPAM | Provision/list/extend/teardown sandboxes; list, allocate, release, and reclaim leases | [Sandbox and IPAM API](docs/api/sandboxes-ipam.md) |
| Operations | Health, reconciliation, global events, runtime config, dashboard | [Operations API](docs/api/operations.md) |
| Authentication and route index | Base URL guidance, middleware behavior, and API navigation | [API overview](docs/api/README.md) |

The route implementation is in [controlplane/server.go](controlplane/server.go); authentication, CORS, and rate limiting are in [controlplane/auth.go](controlplane/auth.go).

## Dashboard

The React/Vite dashboard is in [dashboard/](dashboard/) and is served by the control plane when configured. It presents operational views for gateway health, sandboxes, IP leases, events, and configuration generations. It is an administrative interface to the API, not a separate control plane.

## Storage decision

The control plane uses SQLite rather than PostgreSQL because its current state workload is local to one control-plane process. Embedded storage avoids a separate database listener, network trust boundary, and database credential set, while providing transactional local state with low operational overhead. SQLite is not a distributed database: multi-instance active control planes, remote replication, or significantly higher concurrent write demand would require reassessing the storage layer. See [Design decisions](docs/design-decisions.md).

## Validation status

Local unit/build checks do not establish that a live OpenStack deployment, public DNS path, gateway failover, or production rollback works. Benchmark scenarios may also be staged or deferred. Consult [Testing and validation](docs/testing.md) and [the benchmark guide](bench/README.md) before interpreting a result as live-system evidence.

## Repository guide

| Path | Contents |
|---|---|
| [controlplane/](controlplane/) | Go API, IPAM, provisioning, reconciliation, gateway operations |
| [infra/](infra/) | Pulumi OpenStack resources and configuration |
| [ansible/](ansible/) | Gateway inventory, roles, and deployment playbooks |
| [dashboard/](dashboard/) | Administrative web interface |
| [bench/](bench/) | Benchmark harness, readiness checks, and reports |
| [scripts/](scripts/) | Operational helper scripts |
| [docs/](docs/) | Architecture, deployment, security, API, testing, and design references |
| [go.work](go.work) | Workspace that makes the separate Go modules discoverable together during development |
| [.env.example](.env.example) | Environment-variable template; not a place for real credentials |

Start with the [documentation index](docs/README.md), [architecture guide](docs/architecture.md), or [API overview](docs/api/README.md).
