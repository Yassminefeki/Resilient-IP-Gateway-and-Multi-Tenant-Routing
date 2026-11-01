# Glossary of Terms

| Term | Definition |
|---|---|
| **Sandbox** | An ephemeral, single-tenant microVM instance provisioned on the OpenStack cloud to execute isolated student tasks or service workloads. |
| **Edge Gateway** | A high-performance reverse proxy node (`gw1` or `gw2`) situated on the boundary between public ingress and the internal cloud subnets. |
| **VIP (Virtual IP)** | A shared IP address (`10.20.20.246`) dynamically assigned to whichever edge gateway currently holds the active VRRP master role. |
| **VRRP (Virtual Router Redundancy Protocol)** | The networking standard (RFC 5798, Protocol 112) used by Keepalived to broadcast gateway heartbeats and coordinate failover election. |
| **IPAM (IP Address Management)** | The deterministic address allocation engine managing the tenant IPv4 address space (`10.20.30.0/24`) and tracking lease state transitions. |
| **Lease** | A time-bound IP reservation granting a specific tenant microVM an address in the sandbox subnet for a specified Time-to-Live (TTL). |
| **Quarantine** | A mandatory post-teardown cooldown state (`IP_QUARANTINE_SECONDS`) preventing recycled IPs from being immediately reassigned before network ARP caches and TCP sockets clear. |
| **Reaper** | An autonomous background worker thread in the control plane that sweeps expired leases, triggers VM teardown, and reclaims quarantined addresses. |
| **Data Plane API** | A high-performance REST API daemon running on port 5555 alongside HAProxy, enabling dynamic, transactional configuration reloads without process restarts. |
| **Generation** | An immutable, versioned snapshot of the HAProxy routing table stored in SQLite (`config_generations`), enabling immediate transactional rollback. |
| **Bastion** | A hardened jump-host compute instance located on the management network (`10.20.10.0/24`) through which administrative SSH connections are tunneled. |
| **Designate** | OpenStack's DNSaaS (DNS-as-a-Service) component, used to maintain the tenant root DNS zone and wildcard A-records pointing to the gateway VIP. |
