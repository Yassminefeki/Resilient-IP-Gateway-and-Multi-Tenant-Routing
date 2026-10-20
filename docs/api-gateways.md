# Gateway API reference

The API reference is organized into focused guides:

- [Gateway status, logs, events, generations, sync, rollback, and failover](api/gateways.md)
- [Sandbox and IPAM endpoints](api/sandboxes-ipam.md)
- [Health, reconciliation, global events, runtime config, and dashboard](api/operations.md)
- [API overview, authentication, and route index](api/README.md)

The current implementation is registered in [`../controlplane/server.go`](../controlplane/server.go). These guides are based on that source and replace older examples that described routes or environment variables no longer used by the service.
