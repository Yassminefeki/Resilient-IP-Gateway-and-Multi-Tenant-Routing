# FelCloud Web Dashboard

The FelCloud Web Dashboard is an enterprise operator console for monitoring and managing the resilient IP gateway cluster, tenant sandbox allocations, traffic routing rules, and audit telemetry.

## Quick Start with Docker (Recommended)

The dashboard is built into the FelCloud container image and served directly by the Go control plane under `/ui/`.

From the project root:
```bash
# 1. Start control plane with bundled dashboard
docker compose up -d

# 2. Access dashboard
# Navigate to http://localhost:8081/ui/
```

To run demo data:
```bash
docker compose --profile seed run --rm seed
```

---

## Architecture & Technology Stack

- **Framework:** [React 19](https://react.dev/) with TypeScript
- **Build Tool:** [Vite](https://vitejs.dev/) (base path `/ui/`)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) with responsive dark-mode support
- **Icons:** [Lucide React](https://lucide.dev/)
- **State & Data Fetching:** React Query with integrated polling and fallback management
- **Testing:** [Vitest](https://vitest.dev/) with React Testing Library (40 unit and integration tests)
- **Linting:** [ESLint](https://eslint.org/)

## Views & Capabilities

1. **Dashboard Overview:** Live cluster health indicators, active sandbox counters, IP pool allocation distribution, and gateway VIP ownership telemetry.
2. **Sandboxes View:** Interactive creation form, TTL duration configuration, real-time lifecycle tracking (Accepted -> Provisioning -> Active), and teardown controls.
3. **IPAM Management:** Filterable table of all IPv4 leases across `FREE`, `ALLOCATED`, and `QUARANTINED` states with remaining quarantine cooldown timers.
4. **Gateways & Resilience:** Live telemetry for `gw1` and `gw2`, Keepalived VRRP role inspection, HAProxy uptime/metrics, and one-click manual failover triggers.
5. **Traffic & Routing:** Ingress route table, host-header mappings, custom external domain SNI binding, and TLS 1.3 certificate status.
6. **Configuration & Rollback:** Versioned configuration generations, syntax diff viewer, 45-second health verification monitor, and atomic rollback triggers.
7. **Audit & Observability:** Live stream of control plane audit events, security group state transitions, and real-time HAProxy access logs.
8. **Benchmarks & Verification:** Interactive viewer for official benchmark runs (T1 through T7) with latency percentiles, error rates, and stage durations.

---

## Local Development & Testing (Native npm)

For frontend-only development with hot reload:

### 1. Installation
From the `dashboard/` directory:
```bash
npm install
```

### 2. Run Local Development Server
Starts Vite development server with proxy to `http://localhost:8081`:
```bash
npm run dev
```
Open `http://localhost:5173` in your browser.

### 3. Run Tests
Executes the comprehensive Vitest test suite:
```bash
npm test
```

### 4. Build Production Bundle
Generates optimized static assets in `dist/` with `/ui/` asset base:
```bash
npm run build
```

## Mock Mode vs Live Mode

- **Live Mode:** By default, the dashboard communicates with the Go control plane API at `http://127.0.0.1:8081`. It surfaces real gateway metrics, active OpenStack sandbox allocations, and live IPAM state.
- **Mock Mode:** When the control plane is started with `PROVISIONER=mock`, the API returns simulated OpenStack responses with zero external dependencies. The dashboard handles mock data identically to live cloud data.
