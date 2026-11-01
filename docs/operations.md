# Operator Runbook & Maintenance

This runbook outlines daily operational procedures, incident response steps, health inspection routines, database maintenance, and container lifecycle operations for FelCloud clusters.

---

## 1. Container Operations & Runbook (Docker Compose)

### 1.1 Essential Stack Commands

```bash
# Start control plane and dashboard in mock mode
docker compose up -d

# Check service health and container status
docker compose ps

# Follow container logs
docker compose logs -f controlplane

# Seed demo sandboxes and routes
docker compose --profile seed run --rm seed

# Run benchmark suite in dry-run mode
docker compose --profile bench run --rm bench

# Gracefully stop containers (preserves SQLite data volume)
docker compose down

# Stop containers and completely wipe data volume
docker compose down -v
```

### 1.2 Containerized SQLite Backup & Restore

The SQLite database is stored on the named volume `felcloud-data` at `/data/ipam.db`.

**Online Backup:**
Because SQLite operates in WAL mode, backups can be safely taken while the container is actively serving traffic:
```bash
docker compose exec -T controlplane sqlite3 /data/ipam.db ".backup '/tmp/backup.db'"
docker cp felcloud-controlplane:/tmp/backup.db ./ipam.db.backup-$(date +%Y%m%d%H%M%S)
```

**Restoration:**
```bash
# 1. Stop control plane container
docker compose down

# 2. Start a temporary helper container to restore the file
docker run --rm \
  -v felcloud-data:/data \
  -v $(pwd):/backup:ro \
  debian:bookworm-slim \
  bash -c "cp /backup/ipam.db.backup-<TIMESTAMP> /data/ipam.db && rm -f /data/ipam.db-wal /data/ipam.db-shm && chown -R 10001:10001 /data"

# 3. Restart control plane
docker compose up -d
```

### 1.3 Container Troubleshooting Guide

| Symptom | Probable Cause | Diagnostic Command / Resolution |
|---|---|---|
| `Bind for 0.0.0.0:8081 failed: port is already allocated` | Another process on the host is using port 8081. | Run `ss -tulpn \| grep 8081` to locate conflicting PID; stop conflicting container or override port in Compose. |
| Container status `unhealthy` or crashes on boot | `ADMIN_TOKEN` missing, shorter than 24 chars, or contains whitespace. | Run `docker compose logs controlplane`. Ensure `ADMIN_TOKEN` has at least 24 characters without spaces. |
| `attempt to write a readonly database` | Database path is not pointing to the `/data` volume or incorrect UID permissions. | Ensure `IPAM_DB_PATH=/data/ipam.db`. Volume must be owned by UID `10001:10001`. |
| `read-only file system` error during gateway sync | Temporary files being written to read-only container root instead of `/tmp`. | Verify that `tmpfs: [/tmp]` is configured in `docker-compose.yml`. |
| Ansible playbook failure in `controlplane-live` | Vault password file missing or SSH bastion unreachable. | Check `docker compose --profile live logs controlplane-live`. Verify `./secrets/vault_pass` exists and `BASTION_IP` is reachable. |
| Dashboard shows `API: unreachable` | Browser cannot communicate with port 8081 or auth token is missing. | Verify `curl -f http://127.0.0.1:8081/health`. Click "Set API token" in dashboard and enter your `ADMIN_TOKEN`. |

---

## 2. Routine Cluster Health Inspection

### 2.1 Check Gateway Status via CLI
Query the control plane's aggregated gateway health API:
```bash
curl -s http://127.0.0.1:8081/api/gateways/status | python3 -m json.tool
```
Verify that:
- Both `gw1` and `gw2` show `reachable: true`.
- One gateway is reported as `keepalived: "MASTER"` and `vip_holder_local: true`.
- The peer gateway shows `keepalived: "BACKUP"` and `vip_holder_local: false`.

### 2.2 Inspect Active IPAM Leases
```bash
curl -s http://127.0.0.1:8081/api/leases | python3 -m json.tool
```
Inspect the `pool_summary` count to ensure adequate free addresses remain in the sandbox subnet pool.

---

## 3. Incident Response: Gateway Degradation

### 3.1 Symptom: Keepalived Inactive or VIP Not Moving
If `gw1` fails but `gw2` does not assume the VIP:
1. Connect to `gw2` through the Bastion:
   ```bash
   ssh -J ansible@${BASTION_IP} ansible@10.20.10.164
   ```
2. Check Keepalived systemd service and journal logs:
   ```bash
   sudo systemctl status keepalived
   sudo journalctl -u keepalived -n 50 --no-pager
   ```
3. Verify network interface status and IP bindings:
   ```bash
   ip -br addr
   ```

### 3.2 Symptom: HAProxy Health Check Rejection
If HAProxy fails its local health script:
1. SSH into the affected gateway:
   ```bash
   ssh -J ansible@${BASTION_IP} ansible@<gateway-mgmt-ip>
   ```
2. Validate HAProxy configuration syntax:
   ```bash
   sudo haproxy -c -f /etc/haproxy/haproxy.cfg
   ```
3. Test local admin socket responsiveness:
   ```bash
   echo "show info" | sudo socat stdio unix-connect:/run/haproxy/admin.sock
   ```

---

## 4. Manual Failover & Maintenance Switchover

When performing routine host maintenance or kernel updates on the primary gateway (`gw1`):

1. **Trigger Soft Failover:**
   Issue a failover command to transition the VIP cleanly to `gw2`:
   ```bash
   curl -X POST http://127.0.0.1:8081/api/gateways/failover \
     -H "Authorization: Bearer ${ADMIN_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"confirm": true, "target_gateway": "gw2"}'
   ```
2. **Perform Gateway Maintenance on `gw1`:**
   Apply OS packages, update kernels, or reboot `gw1`.
3. **Verify and Restore `gw1`:**
   After `gw1` boots and its HAProxy daemon starts, Keepalived will safely resume `MASTER` priority (150).

---

## 5. Configuration Rollback Runbook

If a newly deployed route generation causes unintended behavior:
1. Revert to the last known good generation via API:
   ```bash
   curl -X POST http://127.0.0.1:8081/api/gateways/rollback \
     -H "Authorization: Bearer ${ADMIN_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"target_generation": ""}'
   ```
2. Or use the Web Dashboard:
   Navigate to **Configuration** -> Click **Revert Configuration** -> Confirm generation ID.
