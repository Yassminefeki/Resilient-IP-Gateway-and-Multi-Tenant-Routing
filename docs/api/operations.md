# Control-plane operations API

This guide covers health, reconciliation, global events, runtime configuration, and dashboard delivery. Routes are registered in [`controlplane/server.go`](../../controlplane/server.go).

## Health and dashboard

| Method and route | Authentication | Purpose |
|---|---|---|
| `GET /health` | Public | Reports control-plane/database health |
| `GET /ui` and `GET /ui/*` | Public | Serves the dashboard when dashboard assets are configured |
| `GET /api/config` | Public in current middleware | Returns dashboard/runtime configuration exposed by the handler |

The dashboard is served by the Go control plane. Its UI implementation is under [`dashboard/`](../../dashboard/); delivery behavior is in [`controlplane/dashboard.go`](../../controlplane/dashboard.go).

## Reconciliation

| Method and route | Purpose |
|---|---|
| `GET /api/reconcile` | Inspects control-plane/OpenStack state and reports discrepancies |
| `POST /api/reconcile/apply` | Applies the supported reconciliation actions |

Reconciliation can identify orphaned resources and stale state. Review the proposed findings before applying changes; live reconciliation can affect OpenStack resources. Implementation: [`controlplane/reconcile.go`](../../controlplane/reconcile.go).

## Global event stream

### `GET /api/events`

Returns recorded control-plane events through the event handler. For gateway-only event filtering and event ingestion, use [`gateways.md`](gateways.md).

Implementation: [`controlplane/events.go`](../../controlplane/events.go).

## Authentication and errors

Protected routes require `Authorization: Bearer <ADMIN_TOKEN>` unless `AUTH_DISABLED=true`. `GET /health`, `GET /api/config`, and dashboard UI requests are public in the current middleware. Mutating endpoints are rate-limited per client IP.

Response status and error JSON depend on the individual handler. Common status codes include `400` for invalid input, `401` for failed authentication, `404` for missing resources, `409` for state/operation conflicts, and `5xx` for internal or dependency failures. Consult the route-specific handler for the exact response contract.

Security middleware and configuration are documented in [`../security.md`](../security.md) and implemented in [`controlplane/auth.go`](../../controlplane/auth.go).
