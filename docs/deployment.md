# Deployment Guide

This guide details deployment procedures for FelCloud Phase 3. **Containerised deployment via Docker Compose is the primary and recommended method** for both local evaluation (mock mode) and cloud deployment (live mode). Native installation steps are documented in [Section 2](#2-native-host-deployment-alternative).

---

## 1. Container Deployment (Docker & Compose)

FelCloud provides a multi-stage BuildKit container architecture that bundles the Go control plane, static React operator dashboard, Ansible gateway automation, and the reproducible benchmark suite.

### Architecture & Build Targets

The multi-stage [Dockerfile](../Dockerfile) defines three distinct operational targets:

| Build Target | Base Image | Size (Uncompressed) | User | Purpose |
|---|---|---|---|---|
| `runtime-mock` | `debian:bookworm-slim` | ~150 MB (38 MB download) | `10001:10001` | **Default target.** Self-contained control plane and dashboard running simulated OpenStack and mock gateway backends. No cloud credentials required. |
| `runtime-live` | `debian:bookworm-slim` | ~308 MB (73 MB download) | `10001:10001` | **Production gateway operator.** Extends `runtime-mock` with `ansible-core`, `openssh-client`, Python 3, and `ansible.posix`. Connects to real OpenStack and dual HAProxy gateways. |
| `bench` | `python:3.12-slim` | ~470 MB (111 MB download) | `10001:10001` | **Benchmark suite harness.** Bundles Python dependencies (`httpx`, `matplotlib`, `pyyaml`, `aiohttp`) to execute scenarios T1–T7 and output results to mounted storage. |

### Compose Profiles

The stack is managed via [docker-compose.yml](../docker-compose.yml) (Compose v2 specification). Features and services are segmented into profiles:

| Profile | Command | Included Services | Description |
|---|---|---|---|
| *(none / default)* | `docker compose up -d` | `controlplane` | Starts mock control plane and dashboard on `127.0.0.1:8081`. |
| `seed` | `docker compose --profile seed run --rm seed` | `seed` | Idempotently provisions demo sandboxes (`team-alpha`, `team-beta`, `team-gamma`) and binds sample custom domain. |
| `live` | `docker compose --profile live up -d controlplane-live` | `controlplane-live` | Runs live OpenStack control plane with Ansible transactional gateway reloading. |
| `bench` | `docker compose --profile bench run --rm bench` | `bench` | Runs the benchmark harness in dry-run or smoke mode against the control plane. |

### Volumes & State Persistence

- **`felcloud-data` (Named Volume):** Mounted at `/data` inside control plane containers. Houses the SQLite database (`/data/ipam.db`). The control plane configures SQLite in WAL (`Write-Ahead Logging`) mode with `busy_timeout=5000`. Database state persists across container restarts, image updates, and rebuilds. To destroy state completely, use `docker compose down -v`.
- **`tmpfs: /tmp`:** In-memory writable temporary filesystem. Enables ephemeral HAProxy configuration staging and validation while maintaining a read-only root container filesystem.
- **`./secrets:/secrets:ro` (Live Mode):** Read-only host directory containing sensitive deployment credentials (`vault_pass`, SSH private keys).
- **`./bench/results:/app/bench/results` (Bench Mode):** Read-write host volume for saving raw JSON/CSV telemetry and generated benchmark plots.

### Security Hardening

All runtime containers enforce strict container-level isolation:
- **Non-Root Execution:** Runs under dedicated system UID `10001` and GID `10001` (`felcloud:felcloud`). No root privileges are granted in runtime.
- **Read-Only Root Filesystem:** Root filesystem is mounted read-only (`read_only: true`). All disk writes are constrained to `/data` (named volume) and `/tmp` (`tmpfs`).
- **Dropped Capabilities:** All Linux kernel capabilities are dropped (`cap_drop: [ALL]`).
- **No Privilege Escalation:** `security_opt: [no-new-privileges:true]` prevents child processes from gaining elevated permissions.
- **Localhost Publishing:** Port publishing is strictly bound to `127.0.0.1:8081:8081` on the host, preventing accidental exposure of internal management endpoints to public interfaces.

### Quick Start: Mock Mode

```bash
# 1. Clone repository
git clone <repository-url> && cd <repository-directory>

# 2. Set admin token (minimum 24 characters, no whitespace)
export ADMIN_TOKEN="$(openssl rand -hex 32)"

# 3. Start control plane and dashboard
docker compose up -d --build

# 4. Access the web dashboard
# Open http://localhost:8081/ui/ in your browser and enter $ADMIN_TOKEN

# 5. Populate demo sandboxes
docker compose --profile seed run --rm seed

# 6. Stop containers (preserves database)
docker compose down
```

### Production Deployment: Live OpenStack Mode

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure `.env` with your OpenStack credentials, bastion host IP, and tokens.
3. Place your Ansible Vault password in `./secrets/vault_pass`:
   ```bash
   mkdir -p secrets
   echo "your-vault-password" > secrets/vault_pass
   chmod 600 secrets/vault_pass
   ```
4. Start the live control plane:
   ```bash
   docker compose --profile live up -d controlplane-live
   ```

### Configuration Environment Variables

| Variable | Default / Example | Mock Mode | Live Mode | Description |
|---|---|---|---|---|
| `ADMIN_TOKEN` | *(required in production)* | Optional (fallback set) | **Required** | Secret Bearer token for control plane API. Min 24 characters. |
| `PORT` | `8081` | Used | Used | Port the HTTP daemon listens on. |
| `LISTEN_ADDR` | `0.0.0.0` | Used | Used | Network interface to bind inside the container. |
| `IPAM_DB_PATH` | `/data/ipam.db` | Used | Used | SQLite database storage path. |
| `DASHBOARD_DIR` | `/app/dashboard` | Used | Used | Directory containing static SPA build assets. |
| `PROVISIONER` | `mock` / `openstack` | `mock` | `openstack` | Selects backend driver: simulated memory store or live OpenStack APIs. |
| `MOCK_GATEWAYS` | `true` / `false` | `true` | `false` | Enables simulated VIP failover and HAProxy backend status. |
| `VIP_ADDRESS` | `10.20.20.246` | Used | Used | Public virtual IP address managed by Keepalived VRRP. |
| `ROUTING_DOMAIN` | `sandbox.example.com` | Used | Used | Base domain used for sandbox host routing and DNS. |
| `OS_AUTH_URL` | `https://identity...` | *Ignored* | **Required** | Keystone v3 endpoint. |
| `OS_USERNAME` | `admin` | *Ignored* | **Required** | Keystone username. |
| `OS_PASSWORD` | *(secret)* | *Ignored* | **Required** | Keystone password. |
| `OS_PROJECT_NAME` | `felcloud-prod` | *Ignored* | **Required** | OpenStack tenant/project name. |
| `BASTION_IP` | `203.0.113.10` | *Ignored* | **Required** | Jump host IP for gateway SSH ProxyJump. |
| `ANSIBLE_VAULT_PASS`| `/secrets/vault_pass` | *Ignored* | **Required** | Path to Ansible Vault password file. |

---

## 2. Native Host Deployment (Alternative)

For developers contributing directly to Go or frontend codebases outside of Docker, the stack can be run natively.

### Prerequisites

- `go` >= 1.22
- `node` >= 18 and `npm`
- `python3` >= 3.10
- `ansible` >= 2.14
- `pulumi` CLI (for cloud infrastructure provisioning)

### Native Setup Steps

1. **Infrastructure Provisioning (Pulumi):**
   ```bash
   cd infra
   pulumi stack select prod || pulumi stack init prod
   pulumi up --yes
   cd ..
   ```

2. **Edge Gateway Configuration (Ansible):**
   ```bash
   cd ansible
   cp group_vars/gateways/vault.yml.example group_vars/gateways/vault.yml
   # Set vault_haproxy_dpa_pass in vault.yml and encrypt:
   ansible-vault encrypt group_vars/gateways/vault.yml
   echo "vault-password" > .vault_pass && chmod 600 .vault_pass
   ansible-playbook -i inventory/hosts.yml site.yml
   cd ..
   ```

3. **Dashboard Compilation:**
   ```bash
   cd dashboard
   npm ci
   npm run build
   cd ..
   ```

4. **Control Plane Launch:**
   ```bash
   export ADMIN_TOKEN="$(openssl rand -hex 32)"
   export DASHBOARD_DIR="$(pwd)/dashboard/dist"
   export IPAM_DB_PATH="$(pwd)/controlplane/ipam.db"
   cd controlplane
   go run . serve --port 8081
   ```
