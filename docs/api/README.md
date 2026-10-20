# FelCloud Control-Plane API

This section documents the HTTP API exposed by the Go control plane. Routes are registered in [`controlplane/server.go`](../../controlplane/server.go), with request handlers in the control-plane source files linked below.

## Base URL and authentication

The API listens on the configured control-plane port (the deployment commonly uses port `8081`). Use the control-plane address reachable from your client; do not assume that a private management address is reachable from outside OpenStack.

Unless `AUTH_DISABLED=true` is explicitly configured, protected endpoints require a bearer token in the `Authorization` header. `ADMIN_TOKEN` must contain at least 24 characters and must not contain whitespace. Mutating routes are rate-limited per client IP; the default is 30 requests per minute. CORS is restricted to the exact origin configured by `CORS_ORIGIN`.

`GET /health`, `GET /api/config`, and dashboard UI requests are exempt from bearer authentication in the current middleware. Gateway event ingestion can use the admin token, `X-Events-Token`, or—only when explicitly enabled—the configured trusted gateway subnet. See [`../security.md`](../security.md).

The handlers use JSON responses, but error response fields are not identical across every route. Check the endpoint-specific behavior rather than assuming one universal error envelope. Request bodies are decoded strictly: unknown JSON fields are rejected.

## API guides

- [Gateway operations](gateways.md) — gateway health, logs, event records, config generations, sync, rollback, and failover.
- [Sandbox and IPAM](sandboxes-ipam.md) — sandbox lifecycle, leases, allocation, release, and quarantine.
- [Control-plane operations](operations.md) — health, reconciliation, global events, runtime configuration, and dashboard.

## Route overview

| Area | Routes | Detailed guide |
|---|---|---|
| Gateway operations | `/api/gateways/status`, `/api/gateways/dpa`, `/api/gateways/logs`, `/api/gateways/events`, `/api/gateways/generations`, `/api/gateways/failover`, `/api/gateways/sync`, `/api/gateways/rollback` | [gateways.md](gateways.md) |
| Sandboxes | `/api/sandboxes`, `/api/sandboxes/provision`, `/api/sandboxes/extend`, `/api/sandboxes/custom-domain`, `/api/sandboxes/{sandbox_id}` | [sandboxes-ipam.md](sandboxes-ipam.md) |
| IPAM | `/api/leases`, `/ipam/leases`, lease allocation/release/reclaim on both route prefixes | [sandboxes-ipam.md](sandboxes-ipam.md) |
| Operations | `/health`, `/api/reconcile`, `/api/reconcile/apply`, `/api/events`, `/api/config` | [operations.md](operations.md) |
| Dashboard | `/ui` and `/ui/*` | [operations.md](operations.md) |

The authoritative route and middleware implementation is [`controlplane/server.go`](../../controlplane/server.go) and [`controlplane/auth.go`](../../controlplane/auth.go). This documentation describes the repository implementation and does not guarantee that a particular deployment exposes every route through its network policy.
