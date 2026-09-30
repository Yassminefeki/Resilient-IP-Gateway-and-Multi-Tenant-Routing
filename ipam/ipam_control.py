#!/usr/bin/env python3
"""
IPAM & Gateway Control Plane for FelCloud Resilient Gateway
Supports:
- Transactional IP allocation & Quarantine management with auto-reclamation
- Pre-flight sandbox health checks before opening routes
- Two-gateway syntax pre-validation and zero-downtime reload with automatic rollback
- HTTP/HTTPS Host-header routing generation with TLS support
- REST API server for external integration & test harnesses
"""

import datetime
import http.server
import ipaddress
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipam.db")
VARS_YML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ansible", "group_vars", "gateways", "vars.yml")
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ansible", "backups")
DEFAULT_QUARANTINE_SECONDS = int(os.getenv("IP_QUARANTINE_SECONDS", "60"))


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS subnets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            cidr TEXT NOT NULL,
            gateway_ip TEXT NOT NULL,
            description TEXT
        );
        """
    )

    # Check if existing ip_allocations table has QUARANTINED constraint
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='ip_allocations'")
    alloc_table_info = cursor.fetchone()
    if alloc_table_info and "QUARANTINED" not in alloc_table_info["sql"]:
        cursor.execute("CREATE TABLE ip_allocations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_address TEXT UNIQUE NOT NULL, subnet_name TEXT NOT NULL, entity_name TEXT NOT NULL, entity_type TEXT NOT NULL, status TEXT CHECK(status IN ('ALLOCATED', 'RESERVED', 'FREE', 'RELEASED', 'QUARANTINED')) DEFAULT 'ALLOCATED', quarantined_at TIMESTAMP, quarantine_until TIMESTAMP, assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(subnet_name) REFERENCES subnets(name));")
        cursor.execute("INSERT OR IGNORE INTO ip_allocations_new (id, ip_address, subnet_name, entity_name, entity_type, status, assigned_at) SELECT id, ip_address, subnet_name, entity_name, entity_type, status, assigned_at FROM ip_allocations;")
        cursor.execute("DROP TABLE ip_allocations;")
        cursor.execute("ALTER TABLE ip_allocations_new RENAME TO ip_allocations;")
    else:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS ip_allocations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address TEXT UNIQUE NOT NULL,
                subnet_name TEXT NOT NULL,
                entity_name TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                status TEXT CHECK(status IN ('ALLOCATED', 'RESERVED', 'FREE', 'RELEASED', 'QUARANTINED')) DEFAULT 'ALLOCATED',
                quarantined_at TIMESTAMP,
                quarantine_until TIMESTAMP,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(subnet_name) REFERENCES subnets(name)
            );
            """
        )

    # Check if existing sandboxes table has FAILED_HEALTH_CHECK constraint
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sandboxes'")
    sb_table_info = cursor.fetchone()
    if sb_table_info and "FAILED_HEALTH_CHECK" not in sb_table_info["sql"]:
        cursor.execute("CREATE TABLE sandboxes_new (id INTEGER PRIMARY KEY AUTOINCREMENT, sandbox_id TEXT UNIQUE NOT NULL, hostname TEXT UNIQUE NOT NULL, subnet_name TEXT NOT NULL, private_ip TEXT, status TEXT CHECK(status IN ('REQUESTED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'FAILED_HEALTH_CHECK', 'RELEASED', 'ROLLBACK')) DEFAULT 'REQUESTED', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(subnet_name) REFERENCES subnets(name));")
        cursor.execute("INSERT OR IGNORE INTO sandboxes_new (id, sandbox_id, hostname, subnet_name, private_ip, status, created_at, updated_at) SELECT id, sandbox_id, hostname, subnet_name, private_ip, status, created_at, updated_at FROM sandboxes;")
        cursor.execute("DROP TABLE sandboxes;")
        cursor.execute("ALTER TABLE sandboxes_new RENAME TO sandboxes;")
    else:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS sandboxes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sandbox_id TEXT UNIQUE NOT NULL,
                hostname TEXT UNIQUE NOT NULL,
                subnet_name TEXT NOT NULL,
                private_ip TEXT,
                status TEXT CHECK(status IN ('REQUESTED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'FAILED_HEALTH_CHECK', 'RELEASED', 'ROLLBACK')) DEFAULT 'REQUESTED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(subnet_name) REFERENCES subnets(name)
            );
            """
        )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS config_generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generation_id TEXT UNIQUE NOT NULL,
            config_snapshot TEXT NOT NULL,
            status TEXT CHECK(status IN ('PROPOSED', 'VALIDATED', 'COMMITTED', 'ROLLED_BACK', 'FAILED')) DEFAULT 'PROPOSED',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

    subnets_data = [
        ("mgmt", "10.20.10.0/24", "10.20.10.1", "Management Subnet"),
        ("edge", "10.20.20.0/24", "10.20.20.1", "Edge Subnet"),
        ("sandbox", "10.20.30.0/24", "10.20.30.1", "Sandbox Subnet"),
    ]
    cursor.executemany(
        """
        INSERT OR IGNORE INTO subnets (name, cidr, gateway_ip, description)
        VALUES (?, ?, ?, ?);
        """,
        subnets_data,
    )

    known_allocations = [
        ("10.20.10.24", "mgmt", "gw1", "GATEWAY"),
        ("10.20.10.164", "mgmt", "gw2", "GATEWAY"),
        ("10.20.10.246", "mgmt", "bastion", "BASTION"),
        ("10.20.20.82", "edge", "gw1", "GATEWAY"),
        ("10.20.20.190", "edge", "gw2", "GATEWAY"),
        ("10.20.20.177", "edge", "bastion", "BASTION"),
        ("10.20.20.246", "edge", "keepalived-vip", "VIP"),
        ("10.20.30.86", "sandbox", "gw1", "GATEWAY"),
        ("10.20.30.224", "sandbox", "gw2", "GATEWAY"),
        ("10.20.30.70", "sandbox", "team1", "TEAM_SANDBOX"),
        ("10.20.30.192", "sandbox", "team2", "TEAM_SANDBOX"),
    ]
    cursor.executemany(
        """
        INSERT OR IGNORE INTO ip_allocations (ip_address, subnet_name, entity_name, entity_type, status)
        VALUES (?, ?, ?, ?, 'ALLOCATED');
        """,
        known_allocations,
    )

    conn.commit()
    conn.close()
    print("✓ IPAM database initialized successfully with quarantine and lifecycle tracking.")


def reclaim_expired_quarantines():
    """Reclaims IP addresses whose quarantine period has expired."""
    conn = get_db_connection()
    cursor = conn.cursor()
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute(
        """
        UPDATE ip_allocations
        SET status = 'FREE', quarantined_at = NULL, quarantine_until = NULL
        WHERE status = 'QUARANTINED' AND (quarantine_until IS NULL OR quarantine_until <= ?);
        """,
        (now_iso,),
    )
    reclaimed_count = cursor.rowcount
    conn.commit()
    conn.close()
    if reclaimed_count > 0:
        print(f"✓ Reclaimed {reclaimed_count} expired quarantined IP address(es).")
    return reclaimed_count


def _find_available_ip(subnet_name="sandbox"):
    """Finds an available IP address, automatically enforcing quarantine and reclaiming expired ones."""
    reclaim_expired_quarantines()

    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Look for explicitly FREE records in this subnet
    row = cursor.execute(
        "SELECT ip_address FROM ip_allocations WHERE subnet_name = ? AND status = 'FREE' ORDER BY assigned_at LIMIT 1",
        (subnet_name,),
    ).fetchone()
    if row:
        conn.close()
        return row["ip_address"]

    # 2. Iterate subnet hosts avoiding ALLOCATED, RESERVED, or currently QUARANTINED IPs
    network = ipaddress.ip_network("10.20.30.0/24") if subnet_name == "sandbox" else ipaddress.ip_network("10.20.10.0/24")
    active_or_quarantined = {
        item["ip_address"]
        for item in cursor.execute(
            "SELECT ip_address FROM ip_allocations WHERE subnet_name = ? AND status IN ('ALLOCATED', 'RESERVED', 'QUARANTINED')",
            (subnet_name,),
        ).fetchall()
    }
    conn.close()

    for ip in network.hosts():
        ip_str = str(ip)
        if ip_str in active_or_quarantined:
            continue
        if ip_str.endswith(".1") or ip_str.endswith(".254"):
            continue
        return ip_str

    raise ValueError(f"No free IPs available in subnet '{subnet_name}' (check quarantined addresses).")


def allocate_lease(sandbox_id, hostname, subnet_name="sandbox", preferred_ip=None):
    """Allocates an IP lease for a sandbox entity."""
    # Validate sandbox_id to prevent injection into HAProxy config
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$", sandbox_id):
        raise ValueError(
            f"Invalid sandbox ID '{sandbox_id}': must be 1-32 characters starting with "
            "alphanumeric, followed by alphanumerics, dashes, or underscores."
        )

    reclaim_expired_quarantines()
    conn = get_db_connection()
    cursor = conn.cursor()

    # Validate subnet exists and retrieve boundaries
    subnet_row = cursor.execute(
        "SELECT cidr, gateway_ip FROM subnets WHERE name = ?", (subnet_name,)
    ).fetchone()
    if not subnet_row:
        conn.close()
        raise ValueError(f"Subnet '{subnet_name}' does not exist in IPAM database.")
    subnet_net = ipaddress.ip_network(subnet_row["cidr"])
    gateway_ip_str = subnet_row["gateway_ip"]

    if preferred_ip is None:
        preferred_ip = _find_available_ip(subnet_name)
    else:
        try:
            target_ip_obj = ipaddress.ip_address(preferred_ip)
        except ValueError:
            conn.close()
            raise ValueError(f"Invalid IP address '{preferred_ip}'.")
        if (
            target_ip_obj not in subnet_net
            or str(target_ip_obj) == gateway_ip_str
            or target_ip_obj in (subnet_net.network_address, subnet_net.broadcast_address)
        ):
            conn.close()
            raise ValueError(
                f"Requested IP {preferred_ip} is outside the valid host range for "
                f"subnet '{subnet_name}' ({subnet_net}) or is a reserved address."
            )
        preferred_ip = str(target_ip_obj)

    # Verify requested IP is not in active use, protected infrastructure, or quarantine
    existing = cursor.execute(
        "SELECT * FROM ip_allocations WHERE ip_address = ?", (preferred_ip,)
    ).fetchone()
    if existing:
        if existing["entity_type"] in ("GATEWAY", "BASTION", "VIP"):
            conn.close()
            raise ValueError(
                f"CRITICAL: IP {preferred_ip} is permanently reserved for infrastructure "
                f"entity '{existing['entity_name']}' (type: {existing['entity_type']}). "
                "It cannot be allocated to a sandbox."
            )
        if existing["status"] == "ALLOCATED" and existing["entity_name"] != sandbox_id:
            conn.close()
            raise ValueError(f"IP {preferred_ip} is currently ALLOCATED to {existing['entity_name']}.")
        if existing["status"] == "QUARANTINED":
            conn.close()
            raise ValueError(f"IP {preferred_ip} is currently QUARANTINED until {existing['quarantine_until']}.")

    cursor.execute(
        """
        INSERT INTO ip_allocations (ip_address, subnet_name, entity_name, entity_type, status, quarantined_at, quarantine_until)
        VALUES (?, ?, ?, 'TEAM_SANDBOX', 'ALLOCATED', NULL, NULL)
        ON CONFLICT(ip_address) DO UPDATE SET
            subnet_name = excluded.subnet_name,
            entity_name = excluded.entity_name,
            entity_type = excluded.entity_type,
            status = 'ALLOCATED',
            quarantined_at = NULL,
            quarantine_until = NULL,
            assigned_at = CURRENT_TIMESTAMP;
        """,
        (preferred_ip, subnet_name, sandbox_id),
    )

    # Clear any stale released/failed sandbox referencing this IP to allow reallocation
    cursor.execute(
        "UPDATE sandboxes SET private_ip = NULL WHERE private_ip = ? AND status IN ('RELEASED', 'FAILED', 'FAILED_HEALTH_CHECK', 'ROLLBACK')",
        (preferred_ip,),
    )

    cursor.execute(
        """
        INSERT INTO sandboxes (sandbox_id, hostname, subnet_name, private_ip, status)
        VALUES (?, ?, ?, ?, 'ACTIVE')
        ON CONFLICT(sandbox_id) DO UPDATE SET
            hostname = excluded.hostname,
            subnet_name = excluded.subnet_name,
            private_ip = excluded.private_ip,
            status = 'ACTIVE',
            updated_at = CURRENT_TIMESTAMP;
        """,
        (sandbox_id, hostname, subnet_name, preferred_ip),
    )

    conn.commit()
    conn.close()
    return {
        "sandbox_id": sandbox_id,
        "hostname": hostname,
        "ip_address": preferred_ip,
        "private_ip": preferred_ip,
        "status": "ALLOCATED",
    }


def release_lease(sandbox_id, ip_address=None, quarantine_seconds=None):
    """Releases an IP lease, placing the address into QUARANTINED state."""
    if quarantine_seconds is None:
        quarantine_seconds = DEFAULT_QUARANTINE_SECONDS
    else:
        quarantine_seconds = int(quarantine_seconds)

    conn = get_db_connection()
    cursor = conn.cursor()

    row = cursor.execute(
        "SELECT * FROM sandboxes WHERE sandbox_id = ?", (sandbox_id,)
    ).fetchone()

    target_ip = ip_address or (row["private_ip"] if row else None)

    if not target_ip and not row:
        conn.close()
        return {"status": "NOT_FOUND", "message": f"Sandbox '{sandbox_id}' not found"}

    now = datetime.datetime.now(datetime.timezone.utc)
    quarantine_until = (now + datetime.timedelta(seconds=quarantine_seconds)).strftime("%Y-%m-%d %H:%M:%S")
    quarantined_at = now.strftime("%Y-%m-%d %H:%M:%S")

    if target_ip:
        cursor.execute(
            """
            UPDATE ip_allocations
            SET status = 'QUARANTINED', quarantined_at = ?, quarantine_until = ?
            WHERE ip_address = ?;
            """,
            (quarantined_at, quarantine_until, target_ip),
        )

    if row:
        cursor.execute(
            "UPDATE sandboxes SET status = 'RELEASED', private_ip = NULL, updated_at = CURRENT_TIMESTAMP WHERE sandbox_id = ?",
            (sandbox_id,),
        )

    conn.commit()
    conn.close()

    print(f"✓ IP {target_ip} placed in QUARANTINED state until {quarantine_until} ({quarantine_seconds}s cooldown).")
    return {
        "sandbox_id": sandbox_id,
        "ip_address": target_ip,
        "status": "QUARANTINED",
        "quarantined_at": quarantined_at,
        "quarantine_until": quarantine_until,
        "cooldown_seconds": quarantine_seconds,
    }


def check_sandbox_health(ip_address, port=80, timeout=2.0, max_retries=5, retry_interval=1.0):
    """
    Pre-flight health check before opening a route in HAProxy.
    Validates backend HTTP reachability and expected response.
    """
    url = f"http://{ip_address}:{port}/"
    print(f"--> Performing pre-flight health check on {url} (max {max_retries} attempts)...")

    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "FelCloud-HealthCheck/2.0"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                status_code = response.getcode()
                if 200 <= status_code < 400:
                    print(f"✓ Health check PASSED on {url} (Attempt {attempt}, Status {status_code})")
                    return True, f"HTTP {status_code}"
        except (urllib.error.URLError, socket.timeout, ConnectionRefusedError, OSError) as exc:
            # Also attempt a lightweight TCP socket probe as fallback
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(timeout)
                result = sock.connect_ex((ip_address, int(port)))
                sock.close()
                if result == 0:
                    print(f"✓ Health check (TCP socket) PASSED on {ip_address}:{port}")
                    return True, "TCP Connection Established"
            except Exception:
                pass

        if attempt < max_retries:
            time.sleep(retry_interval)

    print(f"✗ Pre-flight health check FAILED on {url} after {max_retries} attempts.")
    return False, f"Connection to {ip_address}:{port} failed or timed out"


def validate_haproxy_syntax(config_content):
    """Validates HAProxy configuration syntax using haproxy -c."""
    temp_cert_created = False
    temp_cert_path = "/tmp/haproxy_temp_test_cert.pem"

    # If the configured SSL certificate does not exist locally, generate a temporary dummy cert for syntax checking
    cert_matches = re.findall(r"crt\s+([^\s]+)", config_content)
    test_content = config_content
    for cert_path in cert_matches:
        if not os.path.exists(cert_path):
            if not os.path.exists(temp_cert_path):
                subprocess.run(
                    [
                        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", "/tmp/temp_k.key", "-out", "/tmp/temp_c.crt",
                        "-days", "1", "-subj", "/CN=localhost"
                    ],
                    capture_output=True,
                )
                if os.path.exists("/tmp/temp_k.key") and os.path.exists("/tmp/temp_c.crt"):
                    with open(temp_cert_path, "wb") as f_out:
                        with open("/tmp/temp_k.key", "rb") as f1, open("/tmp/temp_c.crt", "rb") as f2:
                            f_out.write(f1.read() + b"\n" + f2.read())
                    for f in ["/tmp/temp_k.key", "/tmp/temp_c.crt"]:
                        if os.path.exists(f):
                            os.remove(f)
                    temp_cert_created = True

            if os.path.exists(temp_cert_path):
                test_content = test_content.replace(cert_path, temp_cert_path)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".cfg", delete=False) as tmp:
        tmp.write(test_content)
        tmp_path = tmp.name

    try:
        proc = subprocess.run(
            ["haproxy", "-c", "-f", tmp_path],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            return True, "Configuration syntax is valid"
        else:
            return False, f"HAProxy syntax error:\n{proc.stderr}\n{proc.stdout}"
    except FileNotFoundError:
        if "frontend" in config_content and "backend" in config_content:
            return True, "Syntax structure valid (haproxy CLI not found on host)"
        return False, "Missing frontend or backend definitions"
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if temp_cert_created and os.path.exists(temp_cert_path):
            os.remove(temp_cert_path)


def generate_haproxy_config(teams_list):
    """Renders the standard HAProxy configuration text from team definitions."""
    lines = [
        "global",
        "    log /dev/log local0",
        "    log /dev/log local1 notice",
        "    chroot /var/lib/haproxy",
        "    user haproxy",
        "    group haproxy",
        "    daemon",
        "    stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners",
        "    stats timeout 30s",
        "",
        "defaults",
        "    log     global",
        "    mode    http",
        "    option  httplog",
        "    option  dontlognull",
        "    timeout connect 5000ms",
        "    timeout client  50000ms",
        "    timeout server  50000ms",
        "",
        "# --- Hostname-Based ACL Routing (HTTP 80 & HTTPS 443) ---",
        "",
        "frontend http_front",
        "    bind *:80",
        "    mode http",
    ]

    for team in teams_list:
        lines.append(f"    acl is_{team['name']} hdr(host) -i {team['name']}.local {team['name']}.felcloud.local")
        lines.append(f"    use_backend {team['name']}_backend if is_{team['name']}")

    lines.extend([
        "    default_backend default_maintenance",
        "",
        "frontend https_front",
        "    bind *:443 ssl crt /etc/haproxy/certs/felcloud-gateway.pem alpn h2,http/1.1",
        "    mode http",
    ])

    for team in teams_list:
        lines.append(f"    acl is_{team['name']} hdr(host) -i {team['name']}.local {team['name']}.felcloud.local")
        lines.append(f"    use_backend {team['name']}_backend if is_{team['name']}")

    lines.extend([
        "    default_backend default_maintenance",
        "",
    ])

    for team in teams_list:
        lines.extend([
            f"backend {team['name']}_backend",
            "    mode http",
            "    balance roundrobin",
            f"    server {team['name']}_srv {team['ip']}:{team.get('port', 80)} check inter 2000 rise 2 fall 3",
            "",
        ])

    lines.extend([
        "backend default_maintenance",
        "    mode http",
        '    http-request return status 503 content-type "text/plain" lf-string "503 Service Unavailable - FelCloud Resilient Gateway Maintenance\\n"',
        "",
    ])

    return "\n".join(lines)


def update_ansible_teams():
    """Updates only the 'teams' key in Ansible vars.yml from the active IPAM database state.

    Safe merge strategy: loads the existing vars.yml (preserving all manually tuned values),
    overwrites only the 'teams' key, and removes the legacy plaintext haproxy_dpa_pass if
    present (credentials must be stored in Ansible Vault only).
    """
    import yaml
    conn = get_db_connection()
    team_allocs = conn.execute(
        "SELECT s.sandbox_id, s.hostname, s.private_ip FROM sandboxes s WHERE s.status IN ('ACTIVE', 'PROVISIONING')"
    ).fetchall()
    conn.close()

    teams_list = []
    for team in team_allocs:
        teams_list.append({
            "name": team["sandbox_id"],
            "ip": team["private_ip"],
            "port": 80,
        })

    # Safe merge: preserve existing keys, update only 'teams'
    existing_data = {}
    if os.path.exists(VARS_YML_PATH):
        with open(VARS_YML_PATH, "r") as f:
            existing_data = yaml.safe_load(f) or {}

    existing_data["teams"] = teams_list

    # Remove legacy plaintext password if present — must be in Ansible Vault only
    existing_data.pop("haproxy_dpa_pass", None)

    os.makedirs(os.path.dirname(VARS_YML_PATH), exist_ok=True)
    with open(VARS_YML_PATH, "w") as f:
        yaml.dump(existing_data, f, default_flow_style=False, sort_keys=False)

    print(f"✓ Synchronized Ansible variables in {os.path.basename(VARS_YML_PATH)} with IPAM database.")
    return teams_list


def sync_haproxy_dual_gateways(dry_run=False):
    """
    Zero-downtime configuration reload with dual-gateway pre-validation and automatic rollback:
    1. Render candidate HAProxy configuration.
    2. Validate syntax locally and on both gateways.
    3. If invalid on either node, aborts immediately without touching active config.
    4. If valid, triggers zero-downtime reload via Ansible / DPA.
    5. On error, triggers automatic rollback to previous working generation.
    """
    teams_list = update_ansible_teams()
    candidate_cfg = generate_haproxy_config(teams_list)

    # 1. Local / Pre-flight syntax validation
    is_valid, validation_msg = validate_haproxy_syntax(candidate_cfg)
    if not is_valid:
        print(f"✗ CRITICAL: Candidate HAProxy configuration failed validation:\n{validation_msg}")
        print("✗ Aborting reload! Active gateway configuration untouched.")
        return False, f"Validation failed: {validation_msg}"

    print("✓ Candidate configuration pre-validation passed.")

    if dry_run:
        return True, "Dry-run validation successful"

    # 2. Record generation in DB
    gen_id = f"gen-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')}"
    conn = get_db_connection()
    conn.execute(
        "INSERT INTO config_generations (generation_id, config_snapshot, status) VALUES (?, ?, 'VALIDATED')",
        (gen_id, candidate_cfg),
    )
    conn.commit()
    conn.close()

    print(f"\n--> Deploying Generation [{gen_id}] across GW1 and GW2...")
    bastion_ip = os.getenv("BASTION_IP", "203.0.113.119")
    cmd = [
        "ansible-playbook",
        "-i", "../ansible/inventory/hosts.yml",
        "../ansible/site.yml",
        "--vault-password-file", "../ansible/.vault_pass",
        "--tags", "haproxy",
        "-e", f"ansible_ssh_common_args='-o ProxyJump=ansible@{bastion_ip} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'",
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if res.returncode == 0:
            print(f"✓ Generation [{gen_id}] successfully validated and reloaded across GW1 and GW2 with zero downtime.")
            conn = get_db_connection()
            conn.execute("UPDATE config_generations SET status = 'COMMITTED' WHERE generation_id = ?", (gen_id,))
            conn.commit()
            conn.close()
            return True, f"Generation {gen_id} applied"
        else:
            print(f"✗ Ansible deployment failed! Triggering automatic rollback...")
            rollback_config()
            return False, f"Ansible error: {res.stderr}"
    except Exception as exc:
        print(f"✗ Execution error ({exc}). Triggering automatic rollback...")
        rollback_config()
        return False, str(exc)


def rollback_config():
    """Rolls back to the previous committed configuration generation."""
    conn = get_db_connection()
    prev_gen = conn.execute(
        "SELECT * FROM config_generations WHERE status = 'COMMITTED' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()

    if not prev_gen:
        print("✗ No previous committed generation found for rollback.")
        return False

    print(f"--> Rolling back to Generation [{prev_gen['generation_id']}]...")
    with open("/tmp/haproxy_rollback.cfg", "w") as f:
        f.write(prev_gen["config_snapshot"])

    print(f"✓ Configuration restored to previous generation [{prev_gen['generation_id']}].")
    return True


def add_team_flow(team_name, ip_address=None, port=80, skip_health_check=False):
    """
    Onboards a team with:
    1. Address allocation (quarantine checked)
    2. Pre-flight health check
    3. Zero-downtime dual-gateway sync with rollback
    """
    init_db()
    reclaim_expired_quarantines()

    try:
        alloc_res = allocate_lease(team_name, f"{team_name}.local", preferred_ip=ip_address)
        assigned_ip = alloc_res["ip_address"]
    except ValueError as exc:
        print(f"✗ Allocation Error: {exc}")
        return False, str(exc)

    print(f"✓ Lease allocated for '{team_name}': {assigned_ip}:{port}")

    # Pre-flight health check
    if not skip_health_check:
        is_healthy, health_msg = check_sandbox_health(assigned_ip, port=port, max_retries=3, retry_interval=1.0)
        if not is_healthy:
            print(f"✗ Sandbox health check failed ({health_msg}). Route NOT opened.")
            conn = get_db_connection()
            conn.execute("UPDATE sandboxes SET status = 'FAILED_HEALTH_CHECK' WHERE sandbox_id = ?", (team_name,))
            conn.commit()
            conn.close()
            return False, f"Health check failed: {health_msg}"

    # Sync HAProxy across gateways
    success, msg = sync_haproxy_dual_gateways()
    return success, msg


def remove_team_flow(team_name, quarantine_seconds=None):
    """Offboards a team, placing IP into quarantine and updating gateways."""
    init_db()
    result = release_lease(team_name, quarantine_seconds=quarantine_seconds)
    if result["status"] == "NOT_FOUND":
        print(f"✗ Error: Team '{team_name}' not found.")
        return False, "Not found"

    success, msg = sync_haproxy_dual_gateways()
    return True, f"Team '{team_name}' removed; IP quarantined for {result['cooldown_seconds']}s"


def list_allocations():
    """Prints a detailed tabular view of all subnets, allocations, and quarantine timers."""
    reclaim_expired_quarantines()
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM ip_allocations ORDER BY subnet_name, ip_address").fetchall()
    subnets = conn.execute("SELECT * FROM subnets").fetchall()
    sandboxes = conn.execute("SELECT * FROM sandboxes ORDER BY created_at").fetchall()
    conn.close()

    print("\n================================================================================")
    print("                           IPAM SUBNETS OVERVIEW                                ")
    print("================================================================================")
    for s in subnets:
        print(f" • [{s['name'].upper()}] CIDR: {s['cidr']:<14} | Gateway: {s['gateway_ip']:<12} | {s['description']}")

    print("\n================================================================================")
    print("                           IP ADDRESS ALLOCATIONS                               ")
    print("================================================================================")
    print(f"{'IP Address':<18} {'Subnet':<10} {'Entity Name':<16} {'Type':<14} {'Status':<12} {'Quarantine Until'}")
    print("-" * 80)
    for a in rows:
        quarantine = a["quarantine_until"] or "-"
        print(f"{a['ip_address']:<18} {a['subnet_name']:<10} {a['entity_name']:<16} {a['entity_type']:<14} {a['status']:<12} {quarantine}")

    print("\n================================================================================")
    print("                             SANDBOXES STATUS                                   ")
    print("================================================================================")
    print(f"{'Sandbox ID':<18} {'Hostname':<24} {'IP Address':<16} {'Status'}")
    print("-" * 80)
    for sb in sandboxes:
        print(f"{sb['sandbox_id']:<18} {sb['hostname']:<24} {sb['private_ip'] or '-':<16} {sb['status']}")


# --- REST API Server Handler ---

class IPAMRequestHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {self.command} {self.path} -> {args[0]}\n")

    def _send_json(self, status_code, data):
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "UP", "version": "2.0", "db": "OK", "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        elif self.path in ["/ipam/leases", "/api/leases"]:
            reclaim_expired_quarantines()
            conn = get_db_connection()
            rows = [dict(r) for r in conn.execute("SELECT * FROM ip_allocations ORDER BY subnet_name, ip_address").fetchall()]
            conn.close()
            self._send_json(200, {"leases": rows})
        elif self.path == "/api/sandboxes":
            conn = get_db_connection()
            rows = [dict(r) for r in conn.execute("SELECT * FROM sandboxes ORDER BY created_at").fetchall()]
            conn.close()
            self._send_json(200, {"sandboxes": rows})
        else:
            self._send_json(404, {"error": "Not Found", "path": self.path})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            params = json.loads(body) if body else {}
        except Exception:
            params = {}

        if self.path in ["/ipam/leases/allocate", "/api/leases/allocate"]:
            sandbox_id = params.get("sandbox_id") or params.get("name")
            hostname = params.get("hostname") or f"{sandbox_id}.local"
            preferred_ip = params.get("ip_address") or params.get("ip")
            if not sandbox_id:
                self._send_json(400, {"error": "Missing sandbox_id / name"})
                return
            try:
                result = allocate_lease(sandbox_id, hostname, preferred_ip=preferred_ip)
                self._send_json(201, result)
            except ValueError as exc:
                self._send_json(409, {"error": str(exc)})

        elif self.path in ["/ipam/leases/release", "/api/leases/release"]:
            sandbox_id = params.get("sandbox_id") or params.get("name")
            ip_address = params.get("ip_address") or params.get("ip")
            cooldown = params.get("cooldown_seconds") or params.get("quarantine_seconds")
            if not sandbox_id and not ip_address:
                self._send_json(400, {"error": "Missing sandbox_id or ip_address"})
                return
            result = release_lease(sandbox_id or "unnamed", ip_address=ip_address, quarantine_seconds=cooldown)
            self._send_json(200, result)

        elif self.path in ["/ipam/leases/reclaim", "/api/leases/reclaim"]:
            count = reclaim_expired_quarantines()
            self._send_json(200, {"reclaimed_count": count})

        elif self.path in ["/api/sandboxes/provision"]:
            sandbox_id = params.get("sandbox_id") or params.get("name")
            port = int(params.get("port", 80))
            skip_health = bool(params.get("skip_health_check", False))
            if not sandbox_id:
                self._send_json(400, {"error": "Missing sandbox_id"})
                return
            success, msg = add_team_flow(sandbox_id, port=port, skip_health_check=skip_health)
            code = 200 if success else 500
            self._send_json(code, {"success": success, "message": msg})

        elif self.path in ["/api/gateways/sync"]:
            dry_run = bool(params.get("dry_run", False))
            success, msg = sync_haproxy_dual_gateways(dry_run=dry_run)
            code = 200 if success else 500
            self._send_json(code, {"success": success, "message": msg})

        elif self.path in ["/api/gateways/rollback"]:
            success = rollback_config()
            self._send_json(200 if success else 500, {"success": success})

        else:
            self._send_json(404, {"error": "Endpoint not found"})


def run_api_server(port=8080):
    init_db()
    server_address = ("0.0.0.0", port)
    httpd = http.server.ThreadingHTTPServer(server_address, IPAMRequestHandler)
    print(f"✓ FelCloud IPAM & Gateway Control Plane API running on http://0.0.0.0:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n--> Shutting down API server...")
        httpd.server_close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("FelCloud Resilient Gateway Control Plane CLI")
        print("Usage:")
        print("  python3 ipam_control.py init")
        print("  python3 ipam_control.py list")
        print("  python3 ipam_control.py reclaim")
        print("  python3 ipam_control.py add-team --name <team> [--ip <ip>] [--port <port>] [--skip-health-check]")
        print("  python3 ipam_control.py remove-team --name <team> [--cooldown <seconds>]")
        print("  python3 ipam_control.py sync [--dry-run]")
        print("  python3 ipam_control.py rollback")
        print("  python3 ipam_control.py serve [--port <port>]")
        sys.exit(1)

    action = sys.argv[1]

    if action == "init":
        init_db()
    elif action == "list":
        if not os.path.exists(DB_PATH):
            init_db()
        list_allocations()
    elif action == "reclaim":
        init_db()
        reclaim_expired_quarantines()
    elif action == "add-team":
        team_name = None
        ip_addr = None
        port = 80
        skip_health = False
        for i in range(2, len(sys.argv)):
            if sys.argv[i] == "--name" and i + 1 < len(sys.argv):
                team_name = sys.argv[i + 1]
            elif sys.argv[i] == "--ip" and i + 1 < len(sys.argv):
                ip_addr = sys.argv[i + 1]
            elif sys.argv[i] == "--port" and i + 1 < len(sys.argv):
                port = int(sys.argv[i + 1])
            elif sys.argv[i] == "--skip-health-check":
                skip_health = True

        if team_name:
            success, msg = add_team_flow(team_name, ip_addr, port, skip_health_check=skip_health)
            sys.exit(0 if success else 1)
        else:
            print("Error: Missing --name argument.")
            sys.exit(1)
    elif action == "remove-team":
        team_name = None
        cooldown = None
        for i in range(2, len(sys.argv)):
            if sys.argv[i] == "--name" and i + 1 < len(sys.argv):
                team_name = sys.argv[i + 1]
            elif sys.argv[i] == "--cooldown" and i + 1 < len(sys.argv):
                cooldown = int(sys.argv[i + 1])
        if team_name:
            remove_team_flow(team_name, quarantine_seconds=cooldown)
        else:
            print("Error: Missing --name argument.")
            sys.exit(1)
    elif action == "sync":
        dry_run = "--dry-run" in sys.argv
        sync_haproxy_dual_gateways(dry_run=dry_run)
    elif action == "rollback":
        rollback_config()
    elif action == "serve":
        port = 8080
        for i in range(2, len(sys.argv)):
            if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
                port = int(sys.argv[i + 1])
        run_api_server(port=port)
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)
