# Sandbox and IPAM API

These routes expose sandbox provisioning and lease management. They are registered in [`controlplane/server.go`](../../controlplane/server.go), with request handling in [`controlplane/api.go`](../../controlplane/api.go), [`controlplane/provisioning.go`](../../controlplane/provisioning.go), [`controlplane/teardown.go`](../../controlplane/teardown.go), and [`controlplane/ipam.go`](../../controlplane/ipam.go).

All routes in this guide require the admin bearer token unless authentication is explicitly disabled. Mutating requests are rate-limited. Sandbox identifiers must follow the lowercase DNS-label rules enforced by the handlers.

## Sandboxes

| Method and route | Purpose |
|---|---|
| `GET /api/sandboxes` | Lists sandbox records, status, hostname, IP, expiry, remaining TTL, and custom-domain data when available |
| `POST /api/sandboxes/provision` | Provisions a sandbox through the configured provisioner and returns lifecycle status and timing data |
| `POST /api/sandboxes/extend` | Extends an active sandbox lease, subject to minimum and maximum TTL rules |
| `POST /api/sandboxes/custom-domain` | Associates or clears a custom domain for a sandbox and requests a gateway config sync |
| `DELETE /api/sandboxes/{sandbox_id}` | Tears down the identified sandbox and updates its lease/lifecycle state |

Provision requests use the sandbox creation request type in [`controlplane/openstack.go`](../../controlplane/openstack.go). The team identifier is required (the handler also accepts `sandbox_id` as a fallback) and must be a valid lowercase DNS label. Provisioning depends on the configured live or mock provisioner; mock mode is for local development and is not live OpenStack validation.

The extend request accepts `sandbox_id` and `extend_seconds`. The custom-domain request accepts `sandbox_id` and `custom_domain`; an empty custom domain clears the association. Domain changes trigger a gateway sync attempt.

Teardown is a lifecycle operation, not simply a database delete: the implementation coordinates route removal, OpenStack cleanup, lease quarantine, and status updates. See [`controlplane/teardown.go`](../../controlplane/teardown.go).

## Lease listing

| Method and route | Purpose |
|---|---|
| `GET /api/leases` | Lists IP lease records |
| `GET /ipam/leases` | Compatibility alias for lease listing |

The response includes lease identity, address, subnet/entity fields, allocation status, assignment time, and quarantine timestamps where applicable.

## Lease lifecycle

Both `/api/leases/...` and `/ipam/leases/...` route families are registered for the lifecycle operations below.

| Method and route | Purpose |
|---|---|
| `POST /api/leases/allocate` or `POST /ipam/leases/allocate` | Allocates a lease; accepts sandbox identity, optional hostname/IP preference, and TTL fields |
| `POST /api/leases/release` or `POST /ipam/leases/release` | Releases by sandbox ID or IP and places the address into quarantine |
| `POST /api/leases/reclaim` or `POST /ipam/leases/reclaim` | Reclaims expired quarantined addresses |

Allocation accepts `sandbox_id` or `name`, optional `hostname`, optional `ip_address` or `ip`, and optional `ttl_seconds` or `ttl`. A preferred address must be a literal IPv4 address. Allocation conflicts return `409`; invalid fields return `400`.

Release accepts `sandbox_id` or `name`, optional `ip_address` or `ip`, and optional `cooldown_seconds` or `quarantine_seconds`. At least one sandbox identifier or IP address is required. Reclaim accepts an empty JSON object and returns the number of reclaimed records.

## State and lifecycle notes

- IPAM state is backed by embedded SQLite in the current implementation.
- Released addresses are quarantined before reuse; quarantine duration is configuration-dependent.
- Sandbox teardown and lease release are related but distinct operations. Releasing a lease alone should not be assumed to delete an OpenStack VM.
- Request bodies are strictly decoded; unknown JSON fields are rejected.

For field-level behavior, see the handler implementations linked above and the broader lifecycle explanation in [`../architecture.md`](../architecture.md).
