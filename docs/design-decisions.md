# Design decisions

## Embedded SQLite for control-plane state

The current control plane stores IPAM, sandbox lifecycle, events, and configuration-generation state in SQLite. The database is embedded in the Go service; the repository does not currently implement a PostgreSQL-backed runtime.

### Why SQLite fits this deployment

- **Smaller attack surface:** there is no separate database server or remotely reachable database listener to expose or harden.
- **Fewer credentials and secrets:** the service does not need a database account/password pair in its environment or deployment configuration.
- **Fewer network trust boundaries:** database access is local to the control-plane process and its host rather than crossing a network.
- **Low operational overhead:** deployment, startup, backup, and local development do not require a separate database service.
- **Efficient local access:** IPAM and lifecycle queries avoid a remote database round trip, which suits the current single-control-plane deployment model.
- **Transactional state updates:** SQLite transactions support the control plane's local lease and lifecycle state changes.

These are security and operational risk reductions, not a claim that SQLite is automatically secure. Protect the database file with host permissions, control access to backups, keep the control-plane host restricted, and use the application's authentication and authorization controls for API access.

### Trade-offs and upgrade criteria

SQLite is appropriate while the service has a bounded local-state workload and one active control-plane writer. It does not by itself provide multi-host active-active database coordination, remote replication, or managed high availability. SQLite's write concurrency and file-local nature must be considered as workload and deployment scale increase.

A PostgreSQL migration should be evaluated if the service requires multiple active control-plane instances sharing state, centralized database operations, database-level replication, or materially higher concurrent write throughput. PostgreSQL would add a network service, credentials, firewall policy, backup/restore responsibilities, and another component to monitor and secure.

### Source references

- [`controlplane/ipam.go`](../controlplane/ipam.go) — lease allocation and IPAM schema/state
- [`controlplane/server.go`](../controlplane/server.go) — database-backed API reads and gateway state
- [`controlplane/go.mod`](../controlplane/go.mod) — SQLite driver dependency
