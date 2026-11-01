# Security Model & Access Controls

FelCloud implements a defense-in-depth security model to safeguard multi-tenant microVM sandboxes, edge gateways, and cloud infrastructure.

## 1. Threat Model & Mitigations

| Threat | Attack Vector | Mitigation in FelCloud |
|---|---|---|
| **Cross-Tenant Network Probing** | Compromised sandbox attempting to port-scan or contact neighboring sandboxes. | OpenStack Neutron `sg-sandbox` blocks all inter-sandbox traffic; only traffic to/from gateway IPs (`10.20.30.86`, `10.20.30.224`) is permitted. |
| **Control Plane Impersonation** | Unauthorized client executing POST/DELETE operations on sandboxes or gateways. | Bearer token authentication (`ADMIN_TOKEN`) enforced on all mutating HTTP routes; rate limiting per IP. |
| **Address Hijacking & Replay** | New sandbox receiving an IP that still has active TCP sessions from a prior user. | Mandatory quarantine cooldown period (`IP_QUARANTINE_SECONDS=300`) flushes ARP tables and in-flight sockets before reallocation. |
| **Denial of Service (DoS)** | Volumetric HTTP requests aimed at exhausting microVM backend resources. | HAProxy sticky-table rate limiting (100 req/s window) rejects abusive traffic with HTTP 429 at the gateway edge. |
| **Gateway Host Compromise** | Direct SSH attacks from external internet against gateway instances. | Gateway management interfaces (`10.20.10.0/24`) have no public IPs; SSH is accessible exclusively via the Bastion jump host. |
| **Bad Configuration Injection** | Malformed routing rules or syntax errors crashing the ingress proxy. | HAProxy Data Plane API syntax pre-validation and automated health verification with transactional rollback. |

## 2. API Authentication & Token Handling

- **Token Requirement:** All mutating control plane endpoints require a secret bearer token:
  ```http
  Authorization: Bearer <ADMIN_TOKEN>
  ```
- **Token Generation:** The `ADMIN_TOKEN` should be a cryptographically random string of at least 24 characters, configured via the `.env` file:
  ```bash
  # Generate a secure token
  openssl rand -hex 24
  ```
- **Fail-Closed Design:** In production, if `ADMIN_TOKEN` is unset or shorter than 24 characters, the control plane refuses to boot unless `AUTH_DISABLED=true` is explicitly provided.

## 3. Network Segmentation & Isolation

FelCloud strictly segregates traffic across three independent OpenStack subnets:

```
[ External Internet ]
         │
         ▼ (Floating IP)
┌─────────────────────────────────┐
│     felcloud-edge (10.20.20.0/24)│
│  - Gateway Edge Interfaces      │
│  - Keepalived VRRP VIP          │
└────────────────┬────────────────┘
                 │ (HAProxy Reverse Proxy)
┌────────────────▼────────────────┐
│   felcloud-sandbox (10.20.30.0/24)│
│  - Isolated MicroVM Instances   │
│  - Inter-Sandbox Traffic BLOCKED│
└─────────────────────────────────┘

┌─────────────────────────────────┐
│     felcloud-mgmt (10.20.10.0/24)│
│  - Bastion Jump Host            │
│  - Gateway Mgmt Interfaces      │
│  - Control Plane API            │
└─────────────────────────────────┘
```

Tenant instances on `felcloud-sandbox` have no routing path to `felcloud-mgmt`.

### 3.1 Security Group Policies & Gateway Host Hardening

| Security Group | Attached Ports | Permitted Ingress | Notes |
|---|---|---|---|
| `sg-gateway` (`sg_edge`) | Gateway edge & sandbox ports | 80/tcp, 443/tcp (`0.0.0.0/0`), VRRP protocol 112 (`10.20.20.0/24`) | Ingress port 22 is explicitly omitted. |
| `sg-management` (`sg_mgmt`) | Gateway management ports, Bastion | 22/tcp (SSH), 5555/tcp (HAProxy DPA), 8081/tcp (Control Plane) | Strictly restricted to `10.20.10.0/24`. |
| `sg-sandbox` | Tenant sandbox microVMs | 8080/tcp, 80/tcp from `sg-gateway` only | Inter-sandbox traffic is blocked; outbound limited to DNS, HTTP/HTTPS mirrors, and gateway edge. |

**Gateway Daemon Isolation (T7 Defect Fix):**
To ensure tenant sandboxes cannot reach administrative services on gateway sandbox NICs (`10.20.30.86`, `10.20.30.224`), `sshd` is explicitly bound to the management interface address (`ListenAddress {{ ansible_host }}` in `/etc/ssh/sshd_config.d/50-felcloud-mgmt.conf`). Gateway sandbox ports do not expose port 22.

## 4. Secret & Credential Management

- **Zero Plaintext Secrets in Git:**
  - The repository contains no plaintext passwords, private SSH keys, or cloud credentials.
  - `.gitignore` explicitly blocks `.env`, `*.pem`, `*.key`, `id_rsa*`, `.vault_pass`, and `vault.yml`.
- **Ansible Vault for Gateway Credentials:**
  - Gateway credentials (e.g., `haproxy_dpa_pass`) are encrypted using Ansible Vault (AES-256).
  - An unencrypted template [`ansible/group_vars/gateways/vault.yml.example`](../ansible/group_vars/gateways/vault.yml.example) illustrates the variable schema without committing credentials.
- **SSH Keypair Isolation:**
  - A dedicated OpenStack keypair (`felcloud-resilient-v2`) is generated during Pulumi infrastructure provisioning; the private key is stored locally with `0600` permissions.

## 5. Audit Logging & Non-Repudiation

Every mutating administrative action is recorded into the SQLite `audit_events` table:
- **Timestamp:** ISO 8601 UTC timestamp.
- **Event Category:** `SANDBOX_PROVISION`, `SANDBOX_TEARDOWN`, `GATEWAY_FAILOVER`, `CONFIG_ROLLBACK`, `IP_RECLAIM`.
- **Target Entity:** Sandbox identifier, IP address, or gateway host.
- **Origin Client:** Source IP address and user-agent.
- **Audit Retention:** Retained for a minimum of 72 hours (configurable via `EVENTS_RETENTION_SECONDS`).

## 6. Container Hardening & Runtime Isolation

The Docker runtime containers adhere to enterprise container security standards:

| Security Control | Implementation | Purpose |
|---|---|---|
| **Non-Root Execution** | `USER 10001:10001` (`felcloud:felcloud`) | Ensures the application daemon cannot exploit container breakout to gain root access on the host. |
| **Read-Only Root Filesystem** | `read_only: true` | Prevents runtime tampering, binary replacement, or malware persistence in image layers. |
| **Capability Dropping** | `cap_drop: [ALL]` | Removes all default Linux root capabilities (e.g. `CAP_NET_RAW`, `CAP_SYS_ADMIN`, `CAP_CHOWN`). |
| **No Privilege Escalation** | `security_opt: [no-new-privileges:true]` | Prevents `setuid` binaries from escalating privileges within the container. |
| **Ephemeral Writable Storage** | `tmpfs: /tmp` | Allows transient configuration validation files without writing to permanent container disk. |
| **Dedicated State Volume** | `volume: felcloud-data:/data` | SQLite state is isolated strictly to the dedicated volume owned by UID 10001. |
| **Localhost Interface Binding** | `ports: ["127.0.0.1:8081:8081"]` | Host-side port publishing is restricted strictly to loopback (`127.0.0.1`), preventing exposure on public interfaces without an authenticating reverse proxy. |

