# Deployment model

This document describes the deployment model implemented in the repository and the runtime placement of each major component.

## Runtime layout

| Component | Location in repo | Intended runtime host |
|---|---|---|
| Control plane | [../controlplane](../controlplane) | control-plane host or management VM |
| Infrastructure definitions | [../infra](../infra) | operator machine running Pulumi |
| Gateway config / provisioning | [../ansible](../ansible) | bastion or management host, applied to gateway nodes |
| Dashboard | [../dashboard](../dashboard) | served by the Go control plane |
| Benchmark suite | [../bench](../bench) | local runner or CI environment |
| Scripts | [../scripts](../scripts) | operator machine, bastion, or gateway host as needed |

## Deployment flow

The repo implies the following sequence:

1. Provision the OpenStack network, router, bastion, gateway VMs, security groups, VIP, and sandbox network with Pulumi.
2. Use Ansible to deploy and configure HAProxy, Keepalived, systemd units, and gateway data-plane configuration.
3. Start the Go control plane and its REST API.
4. Use the API for provisioning, lease allocation, gateway sync, and failover orchestration.
5. Keep the dashboard served by the control plane for local interaction.

This is consistent with the files in [../infra](../infra) and [../ansible](../ansible), and with the server startup path in [../controlplane/main.go](../controlplane/main.go).

## Pulumi layer

The Pulumi stack is the infrastructure definition layer. It creates the base network topology and public routing context.

Key pieces:

- [../infra/main.go](../infra/main.go) — stack entrypoint
- [../infra/network.go](../infra/network.go) — edge, sandbox, and management networks
- [../infra/router.go](../infra/router.go) — router and external attachment
- [../infra/vip.go](../infra/vip.go) — VIP port and assigned public path
- [../infra/gateways.go](../infra/gateways.go) — gateway VMs
- [../infra/bastion.go](../infra/bastion.go) — bastion host
- [../infra/security.go](../infra/security.go) — security rules and access policy

## Gateway configuration layer

Ansible is used to install and configure the gateway-side runtime.

Key files:

- [../ansible/site.yml](../ansible/site.yml)
- [../ansible/haproxy-transaction.yml](../ansible/haproxy-transaction.yml)
- [../ansible/inventory](../ansible/inventory)
- [../ansible/group_vars](../ansible/group_vars)
- [../ansible/roles/haproxy](../ansible/roles/haproxy)
- [../ansible/roles/keepalived](../ansible/roles/keepalived)

This layer manages:

- HAProxy install and configuration
- Keepalived object definitions and health checks
- DPA installation and service units
- generated config validation and transaction flow
- gateway inventory generation and pre-flight setup

## Control plane runtime

The Go control plane starts from `felcloud-controlplane` or the `serve` command in [../controlplane/main.go](../controlplane/main.go).

It exposes the API endpoints defined in [../controlplane/server.go](../controlplane/server.go), including:

- `/health`
- `/api/gateways/*`
- `/api/sandboxes/*`
- `/api/leases` and `/ipam/leases`
- `/api/reconcile`
- `/api/config`

The server reads configuration from environment variables and implements auth, route guards, and rate limits in [../controlplane/auth.go](../controlplane/auth.go).

## Operational caveats

- The repository includes both a Go module in `controlplane/` and a separate Pulumi module under [../infra](../infra). These should be treated as distinct build contexts.
- The repo documents an OpenStack environment with edge, mgmt, and sandbox networks; this is the validated architecture implied by the source, not a generic application template.
- Live failover testing, real gateway deployment, or actual OpenStack mutation remains a live-environment task and should not be treated as local verification.

## Safe local validation

The safe local flow is:

- validate source tree and docs consistency
- run local unit and mock validation where available
- avoid running `pulumi up`, `pulumi destroy`, Ansible against live hosts, or benchmark tests that mutate real infrastructure unless explicitly approved

See [testing.md](testing.md) for the full validation model.
