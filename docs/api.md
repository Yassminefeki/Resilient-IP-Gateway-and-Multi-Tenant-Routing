# REST API Reference

The FelCloud Control Plane exposes an HTTP REST API on port `8081` (configurable via `PORT` or `CONTROL_PLANE_BASE_URL`).

## 1. Authentication & Security

- Mutating endpoints (`POST`, `DELETE`, `PUT`) require an HTTP Bearer token:
  ```http
  Authorization: Bearer <ADMIN_TOKEN>
  ```
- If `ADMIN_TOKEN` is unset and `AUTH_DISABLED=true` is exported, authentication is bypassed (recommended only for local development).
- Rate limiting is enforced per client IP (default: 30 mutating requests/minute). Exceeding the threshold returns HTTP `429 Too Many Requests`.

---

## 2. Sandbox Management Endpoints

### 2.1 Provision Sandbox
Allocates an IP from IPAM, reserves an OpenStack port, launches a Nova microVM, and injects routing rules into both gateways.

- **URL:** `/api/sandboxes/provision`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Request Body:**
  ```json
  {
    "team": "student-alpha",
    "ttl": 3600
  }
  ```
- **Response (`202 Accepted` / `200 OK`):**
  ```json
  {
    "sandbox_id": "student-alpha",
    "fixed_ip": "10.20.30.42",
    "hostname": "student-alpha.sandbox.example.com",
    "status": "ALLOCATED",
    "allocated_at": "2026-10-31T01:00:00Z",
    "expires_at": "2026-10-31T02:00:00Z"
  }
  ```

### 2.2 Teardown Sandbox
Terminates the sandbox, deletes routing rules, and transitions the allocated IP into quarantine.

- **URL:** `/api/sandboxes/{id}`
- **Method:** `DELETE`
- **Headers:** `Authorization: Bearer <token>`
- **Response (`200 OK`):**
  ```json
  {
    "message": "Sandbox student-alpha deleted successfully",
    "quarantine_until": "2026-10-31T02:05:00Z"
  }
  ```

### 2.3 Bind Custom Domain
Binds an external custom domain to an active sandbox route.

- **URL:** `/api/sandboxes/custom-domain`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Request Body:**
  ```json
  {
    "sandbox_id": "student-alpha",
    "custom_domain": "demo.sandbox.example.com"
  }
  ```
- **Response (`200 OK`):**
  ```json
  {
    "sandbox_id": "student-alpha",
    "custom_domain": "demo.sandbox.example.com",
    "backend_ip": "10.20.30.42",
    "status": "ACTIVE"
  }
  ```

### 2.4 List Sandboxes
Returns active sandboxes and routing records.

- **URL:** `/api/sandboxes`
- **Method:** `GET`
- **Response (`200 OK`):**
  ```json
  {
    "sandboxes": [
      {
        "id": "student-alpha",
        "fixed_ip": "10.20.30.42",
        "hostname": "student-alpha.sandbox.example.com",
        "status": "ACTIVE",
        "created_at": "2026-10-31T01:00:00Z",
        "expires_at": "2026-10-31T02:00:00Z"
      }
    ],
    "total": 1
  }
  ```

---

## 3. IPAM & Lease Endpoints

### 3.1 List IP Leases
Returns all IPAM records across all lifecycle states.

- **URL:** `/api/leases`
- **Method:** `GET`
- **Query Parameters:** `?status=FREE` or `?status=ALLOCATED` or `?status=QUARANTINED`
- **Response (`200 OK`):**
  ```json
  {
    "leases": [
      {
        "ip_address": "10.20.30.42",
        "status": "ALLOCATED",
        "sandbox_id": "student-alpha",
        "allocated_at": "2026-10-31T01:00:00Z",
        "expires_at": "2026-10-31T02:00:00Z",
        "quarantine_until": null
      }
    ],
    "pool_summary": {
      "total": 240,
      "free": 239,
      "allocated": 1,
      "quarantined": 0
    }
  }
  ```

---

## 4. Gateway Resilience Endpoints

### 4.1 Cluster & Gateway Health Status
Inspects the state of both edge gateways, HAProxy processes, and VIP ownership.

- **URL:** `/api/gateways/status`
- **Method:** `GET`
- **Response (`200 OK`):**
  ```json
  {
    "vip_address": "10.20.20.246",
    "vip_holder": "gw1",
    "latest_generation": "gen-1792310860",
    "gateways": {
      "gw1": {
        "reachable": true,
        "haproxy": "UP",
        "keepalived": "MASTER",
        "vip_holder_local": true,
        "probed_at": "2026-10-31T01:10:00Z"
      },
      "gw2": {
        "reachable": true,
        "haproxy": "UP",
        "keepalived": "BACKUP",
        "vip_holder_local": false,
        "probed_at": "2026-10-31T01:10:00Z"
      }
    }
  }
  ```

### 4.2 Manual Failover Trigger
Simulates primary gateway termination or switches VIP ownership.

- **URL:** `/api/gateways/failover`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Request Body:**
  ```json
  {
    "confirm": true,
    "target_gateway": "gw2"
  }
  ```
- **Response (`200 OK`):**
  ```json
  {
    "message": "Failover initiated to gw2",
    "status": "COMPLETED",
    "vip_holder": "gw2"
  }
  ```

### 4.3 Atomic Configuration Rollback
Rolls back gateway routing configuration to the previous valid snapshot.

- **URL:** `/api/gateways/rollback`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Request Body:**
  ```json
  {
    "target_generation": ""
  }
  ```
- **Response (`200 OK`):**
  ```json
  {
    "success": true,
    "generation": "rollback-1729348123",
    "duration_ms": 9414,
    "rollback_commit_ms": 4414,
    "post_rollback_health_window_ms": 5000
  }
  ```

---

## 5. System Health & Observability Endpoints

### 5.1 Health Check (Unauthenticated Liveness)
Used by Docker healthchecks, probes, and load balancers to verify service and database availability without credentials.

- **URL:** `/health` (also aliased under `/api/health`)
- **Method:** `GET`
- **Response (`200 OK`):**
  ```json
  {
    "status": "UP",
    "source": "controlplane-gateway",
    "db": "OK",
    "timestamp": "2026-10-31T01:00:00Z",
    "reaper_last_tick_unix": 1729348120,
    "reaper_last_tick_duration_ms": 12,
    "oldest_overdue_seconds": 0
  }
  ```

### 5.2 Audit Events
- **URL:** `/api/events`
- **Method:** `GET`
- **Query Parameters:** `?limit=50`
- **Response (`200 OK`):**
  ```json
  {
    "events": [
      {
        "id": 104,
        "event_type": "SANDBOX_PROVISIONED",
        "sandbox_id": "student-alpha",
        "timestamp": "2026-10-31T01:00:00Z",
        "details": { "ip": "10.20.30.42", "duration_ms": 320 }
      }
    ]
  }
  ```
