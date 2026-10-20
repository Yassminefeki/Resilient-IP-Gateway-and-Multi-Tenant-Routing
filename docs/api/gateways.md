# Gateway API

These endpoints operate on, inspect, or report state from the `gw1` and `gw2` gateway pair. Routes are registered in [`controlplane/server.go`](../../controlplane/server.go); failover behavior is implemented in [`controlplane/gateway_failover.go`](../../controlplane/gateway_failover.go).

Unless noted otherwise, requests require the admin bearer token. A successful HTTP response does not by itself prove the gateways are reachable from every network or that a live failover objective has been met.

## Gateway status

### `GET /api/gateways/status`

Returns each gateway's reachability, HAProxy and Keepalived state, local VIP ownership, probe timestamp, and any probe error. The response also includes the configured VIP address, detected VIP holder, latest configuration generation, fetch timestamp, and deployment method. `?refresh=true` or `?refresh=1` invalidates the short-lived status cache before fetching status.

The default VIP address is `10.20.20.246`; set `VIP_ADDRESS` to override it. Unreachable gateways are reported in the response rather than causing the entire status request to fail.

### `GET /api/gateways/dpa`

Probes the HAProxy Data Plane API for both configured gateways and returns readiness/version information and the configured DPA port.

## Gateway logs

### `GET /api/gateways/logs`

Reads a bounded log tail from a gateway using the configured Ansible/SSH path.

| Query parameter | Requirement | Behavior |
|---|---|---|
| `gateway` | Required: `gw1` or `gw2` | Selects the gateway |
| `source` | Optional: `haproxy` or `keepalived` | Defaults to `haproxy` |
| `limit` | Optional integer | Defaults to 50; clamped to 1–500 |
| `since` | Optional | Restricted to a safe character set before being passed to the log query |

Invalid parameters return `400`. A remote log-fetch failure returns a gateway error response; a timeout may return `504`.

## Gateway event records

### `GET /api/gateways/events`

Returns recent gateway events, newest first. Optional query parameters are `type`, `since` (epoch milliseconds, inclusive lower bound), and `limit` (default 50, clamped to 1–500).

### `POST /api/gateways/events`

Stores an event reported by a gateway notification process. Accepted event types are `failover`, `rollback`, `keepalived_state`, `sync`, `failover_test`, and `health_check`.

The JSON body supports `type`, `state`, `hostname`, `ts_ms`, `duration_ms`, `detail`, and `sandbox_id`. Hostname, state, sandbox ID, timestamp range, and detail length are validated. If `ts_ms` is omitted or zero, the server assigns the current time.

Authentication supports the admin bearer token or `X-Events-Token`. A trusted-subnet exception is available only when `EVENTS_ALLOW_SUBNET=true`; its network is configured by `GATEWAY_SUBNET` (default `10.20.10.0/24`). Do not enable subnet-based admission unless network-level restrictions make that trust decision appropriate.

Successful event creation returns `201 Created`. Invalid event data returns `400`; denied requests return `401`.

## Configuration generations

### `GET /api/gateways/generations`

Lists recent HAProxy configuration generations, newest first. The optional `limit` is accepted from 1 to 100; otherwise the default is 20. Each result includes the generation ID, status, creation time, backend count, and available gateway backup metadata.

Statuses observed in the deployment lifecycle include `PROPOSED`, `VALIDATED`, `COMMITTED`, `ROLLED_BACK`, and `FAILED`.

## Gateway changes

### `POST /api/gateways/sync`

Regenerates HAProxy configuration and deploys it through the gateway deployment path. The JSON request supports `dry_run` (boolean). A successful response includes a message and duration. Concurrent conflicting gateway operations return `409`; deployment failures return a gateway error response.

### `POST /api/gateways/rollback`

Restores a committed configuration. The JSON request may specify `target_generation`; an empty value uses the rollback logic's default target. The response includes the selected generation and duration. A conflicting operation returns `409`; rollback failure returns a gateway error response.

### `POST /api/gateways/failover`

Requests a manual failover. The request must include `confirm: true`; it may include `target_gateway` and `mode`. The endpoint coordinates the configured failover implementation. Do not treat an API response or a mock-mode result as proof of live failover; validate VIP ownership and traffic recovery in the target environment.

## Source references

- Route registration and status/log/event/generation/sync/rollback handlers: [`controlplane/server.go`](../../controlplane/server.go)
- Gateway event authentication: [`controlplane/auth.go`](../../controlplane/auth.go)
- Failover implementation: [`controlplane/gateway_failover.go`](../../controlplane/gateway_failover.go)
- Deployment and rollback internals: [`controlplane/gateway_deploy.go`](../../controlplane/gateway_deploy.go)
