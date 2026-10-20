package main

import (
	"database/sql"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type DBQueryer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func getDBConnection() (*sql.DB, error) {
	dbMutex.Lock()
	defer dbMutex.Unlock()

	// Ensure target directory exists
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create db dir: %w", err)
	}

	dsn := dbPath
	if !strings.Contains(dsn, "?") {
		dsn += "?_journal_mode=WAL&_busy_timeout=5000&_txlock=immediate"
	}

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	return db, nil
}

func initDB() error {
	db, err := getDBConnection()
	if err != nil {
		return err
	}
	defer db.Close()

	// 1. Subnets Table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS subnets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			cidr TEXT NOT NULL,
			gateway_ip TEXT NOT NULL,
			description TEXT
		);
	`)
	if err != nil {
		return fmt.Errorf("error creating subnets table: %w", err)
	}

	// 2. Check & create ip_allocations table
	var allocSQL string
	err = db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='ip_allocations'").Scan(&allocSQL)
	if err == sql.ErrNoRows {
		_, err = db.Exec(`
			CREATE TABLE ip_allocations (
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
		`)
		if err != nil {
			return fmt.Errorf("error creating ip_allocations table: %w", err)
		}
	} else if err == nil && !strings.Contains(allocSQL, "QUARANTINED") {
		db.Exec(`
			CREATE TABLE ip_allocations_new (
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
			INSERT OR IGNORE INTO ip_allocations_new (id, ip_address, subnet_name, entity_name, entity_type, status, assigned_at)
			SELECT id, ip_address, subnet_name, entity_name, entity_type, status, assigned_at FROM ip_allocations;
			DROP TABLE ip_allocations;
			ALTER TABLE ip_allocations_new RENAME TO ip_allocations;
		`)
	}

	// 3. Check & create sandboxes table
	var sbSQL string
	err = db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='sandboxes'").Scan(&sbSQL)
	if err == sql.ErrNoRows {
		_, err = db.Exec(`
			CREATE TABLE sandboxes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				sandbox_id TEXT UNIQUE NOT NULL,
				hostname TEXT UNIQUE NOT NULL,
				subnet_name TEXT NOT NULL,
				private_ip TEXT,
				status TEXT CHECK(status IN ('REQUESTED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'TEARING_DOWN', 'TEARDOWN_FAILED', 'FAILED', 'FAILED_HEALTH_CHECK', 'RELEASED', 'ROLLBACK')) DEFAULT 'REQUESTED',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				expires_at INTEGER,
				server_id TEXT,
				port_id TEXT,
				fixed_ip TEXT,
				provisioned_at INTEGER,
				managed_by TEXT NOT NULL DEFAULT 'external',
				teardown_step TEXT NOT NULL DEFAULT '',
				teardown_attempts INTEGER NOT NULL DEFAULT 0,
				teardown_step_attempts INTEGER NOT NULL DEFAULT 0,
				teardown_started_at INTEGER,
				teardown_route_removed_at INTEGER,
				teardown_resources_deleted_at INTEGER,
				teardown_verified_gone_at INTEGER,
				teardown_released_at INTEGER,
				teardown_last_error TEXT,
				custom_domain TEXT DEFAULT '',
				FOREIGN KEY(subnet_name) REFERENCES subnets(name)
			);
		`)
		if err != nil {
			return fmt.Errorf("error creating sandboxes table: %w", err)
		}
	} else if err == nil {
		if !strings.Contains(sbSQL, "FAILED_HEALTH_CHECK") || !strings.Contains(sbSQL, "EXPIRING") || !strings.Contains(sbSQL, "TEARDOWN_FAILED") {
			// Migrate: recreate table with expanded CHECK constraint, in one transaction,
			// with row-count verification before and after.
			if err := migrateSandboxesSchema(db); err != nil {
				return fmt.Errorf("sandboxes schema migration failed: %w", err)
			}
		}

		// Additive migration for expires_at column if missing
		var hasExpiresAt bool
		infoRows, infoErr := db.Query("PRAGMA table_info(sandboxes)")
		if infoErr == nil {
			for infoRows.Next() {
				var cid int
				var name, typeStr string
				var notNull int
				var dfltValue interface{}
				var pk int
				if err := infoRows.Scan(&cid, &name, &typeStr, &notNull, &dfltValue, &pk); err == nil {
					if name == "expires_at" {
						hasExpiresAt = true
					}
				}
			}
			infoRows.Close()
		}
		if !hasExpiresAt {
			if _, err := db.Exec("ALTER TABLE sandboxes ADD COLUMN expires_at INTEGER"); err != nil {
				return fmt.Errorf("failed to add expires_at column: %w", err)
			}
		}
	}
	if err := ensureProvisionColumns(db); err != nil {
		return fmt.Errorf("provisioning schema migration failed: %w", err)
	}
	if err := ensureTeardownColumns(db); err != nil {
		return fmt.Errorf("teardown schema migration failed: %w", err)
	}

	// 4. Config generations table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS config_generations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			generation_id TEXT UNIQUE NOT NULL,
			config_snapshot TEXT NOT NULL,
			status TEXT CHECK(status IN ('PROPOSED', 'VALIDATED', 'COMMITTED', 'ROLLED_BACK', 'FAILED')) DEFAULT 'PROPOSED',
			source_generation TEXT,
			content_sha TEXT,
			gw1_backup TEXT,
			gw2_backup TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`)
	if err != nil {
		return fmt.Errorf("error creating config_generations table: %w", err)
	}
	if err := ensureConfigGenerationBackupColumns(db); err != nil {
		return fmt.Errorf("config generation backup migration failed: %w", err)
	}
	if err := ensureConfigGenerationMetaColumns(db); err != nil {
		return fmt.Errorf("config generation metadata migration failed: %w", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS gateway_lock (
			id INTEGER PRIMARY KEY CHECK(id = 1),
			holder TEXT,
			expires_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS gateway_state (
			key TEXT PRIMARY KEY,
			value TEXT,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`)
	if err != nil {
		return fmt.Errorf("error creating gateway lock/state tables: %w", err)
	}

	// 5. Events table & index
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts_ms INTEGER NOT NULL,
			sandbox_id TEXT,
			type TEXT NOT NULL,
			detail TEXT,
			duration_ms INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_events_sandbox_ts ON events(sandbox_id, ts_ms);
	`)
	if err != nil {
		return fmt.Errorf("error creating events table: %w", err)
	}

	// Seed subnets
	subnets := [][]string{
		{"mgmt", "10.20.10.0/24", "10.20.10.1", "Management Subnet"},
		{"edge", "10.20.20.0/24", "10.20.20.1", "Edge Subnet"},
		{"sandbox", "10.20.30.0/24", "10.20.30.1", "Sandbox Subnet"},
	}
	for _, s := range subnets {
		db.Exec(`INSERT OR IGNORE INTO subnets (name, cidr, gateway_ip, description) VALUES (?, ?, ?, ?)`, s[0], s[1], s[2], s[3])
	}

	// Seed known allocations
	allocs := [][]string{
		{"10.20.10.24", "mgmt", "gw1", "GATEWAY"},
		{"10.20.10.164", "mgmt", "gw2", "GATEWAY"},
		{"10.20.10.246", "mgmt", "bastion", "BASTION"},
		{"10.20.20.82", "edge", "gw1", "GATEWAY"},
		{"10.20.20.190", "edge", "gw2", "GATEWAY"},
		{"10.20.20.177", "edge", "bastion", "BASTION"},
		{"10.20.20.246", "edge", "keepalived-vip", "VIP"},
		{"10.20.30.86", "sandbox", "gw1", "GATEWAY"},
		{"10.20.30.224", "sandbox", "gw2", "GATEWAY"},
		{"10.20.30.70", "sandbox", "team1", "TEAM_SANDBOX"},
		{"10.20.30.192", "sandbox", "team2", "TEAM_SANDBOX"},
	}
	for _, a := range allocs {
		db.Exec(`INSERT OR IGNORE INTO ip_allocations (ip_address, subnet_name, entity_name, entity_type, status) VALUES (?, ?, ?, ?, 'ALLOCATED')`, a[0], a[1], a[2], a[3])
	}

	fmt.Println("✓ IPAM database initialized successfully with quarantine and lifecycle tracking.")
	return nil
}

func ensureConfigGenerationBackupColumns(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(config_generations)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &defaultValue, &pk); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, name := range []string{"gw1_backup", "gw2_backup"} {
		if !columns[name] {
			if _, err := db.Exec(`ALTER TABLE config_generations ADD COLUMN ` + name + ` TEXT`); err != nil {
				return err
			}
		}
	}
	return nil
}

func ensureConfigGenerationMetaColumns(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(config_generations)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		columns[name] = true
	}
	for _, name := range []string{"source_generation", "content_sha"} {
		if !columns[name] {
			if _, err := db.Exec(`ALTER TABLE config_generations ADD COLUMN ` + name + ` TEXT`); err != nil {
				return err
			}
		}
	}
	return rows.Err()
}

func migrateSandboxesSchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration tx: %w", err)
	}
	defer tx.Rollback()

	// Preserve additive provisioning/teardown columns while expanding the state CHECK.
	oldCols := map[string]bool{}
	infoRows, infoErr := tx.Query("PRAGMA table_info(sandboxes)")
	if infoErr != nil {
		return fmt.Errorf("inspect old sandboxes schema: %w", infoErr)
	}
	for infoRows.Next() {
		var cid, notNull, pk int
		var name, typeStr string
		var dfltValue any
		if err := infoRows.Scan(&cid, &name, &typeStr, &notNull, &dfltValue, &pk); err != nil {
			infoRows.Close()
			return err
		}
		oldCols[name] = true
	}
	if err := infoRows.Err(); err != nil {
		infoRows.Close()
		return err
	}
	infoRows.Close()

	// Count rows before migration
	var countBefore int
	if err := tx.QueryRow("SELECT COUNT(*) FROM sandboxes").Scan(&countBefore); err != nil {
		return fmt.Errorf("pre-migration row count: %w", err)
	}

	_, err = tx.Exec(`
		CREATE TABLE sandboxes_new (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sandbox_id TEXT UNIQUE NOT NULL,
			hostname TEXT UNIQUE NOT NULL,
			subnet_name TEXT NOT NULL,
			private_ip TEXT,
		status TEXT CHECK(status IN ('REQUESTED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'TEARING_DOWN', 'TEARDOWN_FAILED', 'FAILED', 'FAILED_HEALTH_CHECK', 'RELEASED', 'ROLLBACK')) DEFAULT 'REQUESTED',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			expires_at INTEGER,
			server_id TEXT,
			port_id TEXT,
			fixed_ip TEXT,
			provisioned_at INTEGER,
			managed_by TEXT NOT NULL DEFAULT 'external',
			teardown_step TEXT NOT NULL DEFAULT '',
			teardown_attempts INTEGER NOT NULL DEFAULT 0,
			teardown_step_attempts INTEGER NOT NULL DEFAULT 0,
			teardown_started_at INTEGER,
			teardown_route_removed_at INTEGER,
			teardown_resources_deleted_at INTEGER,
			teardown_verified_gone_at INTEGER,
			teardown_released_at INTEGER,
			teardown_last_error TEXT,
			FOREIGN KEY(subnet_name) REFERENCES subnets(name)
		);
	`)
	if err != nil {
		return fmt.Errorf("create sandboxes_new: %w", err)
	}

	columns := []string{"expires_at", "server_id", "port_id", "fixed_ip", "provisioned_at", "managed_by", "teardown_step", "teardown_attempts", "teardown_step_attempts", "teardown_started_at", "teardown_route_removed_at", "teardown_resources_deleted_at", "teardown_verified_gone_at", "teardown_released_at", "teardown_last_error"}
	selects := make([]string, 0, len(columns))
	for _, column := range columns {
		if oldCols[column] {
			selects = append(selects, column)
			continue
		}
		fallback := "NULL"
		if column == "teardown_step" {
			fallback = "''"
		} else if column == "managed_by" {
			fallback = "'external'"
		} else if column == "teardown_attempts" || column == "teardown_step_attempts" {
			fallback = "0"
		}
		selects = append(selects, fallback)
	}
	_, err = tx.Exec(`INSERT INTO sandboxes_new (id,sandbox_id,hostname,subnet_name,private_ip,status,created_at,updated_at,` + strings.Join(columns, ",") + `)
		SELECT id,sandbox_id,hostname,subnet_name,private_ip,status,created_at,updated_at,` + strings.Join(selects, ",") + ` FROM sandboxes`)
	if err != nil {
		return fmt.Errorf("copy rows to sandboxes_new: %w", err)
	}

	// Count rows after copy
	var countAfter int
	if err := tx.QueryRow("SELECT COUNT(*) FROM sandboxes_new").Scan(&countAfter); err != nil {
		return fmt.Errorf("post-migration row count: %w", err)
	}
	if countAfter != countBefore {
		return fmt.Errorf("row count mismatch: before=%d after=%d", countBefore, countAfter)
	}

	if _, err := tx.Exec("DROP TABLE sandboxes"); err != nil {
		return fmt.Errorf("drop old sandboxes: %w", err)
	}
	if _, err := tx.Exec("ALTER TABLE sandboxes_new RENAME TO sandboxes"); err != nil {
		return fmt.Errorf("rename sandboxes_new: %w", err)
	}

	return tx.Commit()
}

func reclaimExpiredQuarantinesTx(q DBQueryer) int {
	nowStr := time.Unix(nowUnix(), 0).UTC().Format("2006-01-02 15:04:05")
	res, err := q.Exec(`
		UPDATE ip_allocations
		SET status = 'FREE', quarantined_at = NULL, quarantine_until = NULL
		WHERE status = 'QUARANTINED' AND (quarantine_until IS NULL OR quarantine_until <= ?);
	`, nowStr)
	if err != nil {
		return 0
	}

	rows, _ := res.RowsAffected()
	if rows > 0 {
		recordEvent(q, "", "reclaimed", fmt.Sprintf("count=%d", rows), 0)
		fmt.Printf("✓ Reclaimed %d expired quarantined IP address(es).\n", rows)
	}
	return int(rows)
}

func reclaimExpiredQuarantines() int {
	db, err := getDBConnection()
	if err != nil {
		return 0
	}
	defer db.Close()
	return reclaimExpiredQuarantinesTx(db)
}

func ipToUint32(ip net.IP) uint32 {
	ip = ip.To4()
	if ip == nil {
		return 0
	}
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}

func validateSandboxIP(cidr, gatewayIP, ip string) error {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil || parsed.String() != ip {
		return fmt.Errorf("sandbox IP %q must be a canonical IPv4 address", ip)
	}
	networkIP, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return fmt.Errorf("invalid sandbox CIDR %q: %w", cidr, err)
	}
	if !ipnet.Contains(parsed) {
		return fmt.Errorf("sandbox IP %s is outside sandbox CIDR %s", ip, cidr)
	}
	if ip == gatewayIP {
		return fmt.Errorf("sandbox IP %s is reserved as the subnet gateway", ip)
	}
	ones, bits := ipnet.Mask.Size()
	hostCount := uint32(1) << uint(bits-ones)
	start := ipToUint32(networkIP.Mask(ipnet.Mask))
	end := start + hostCount - 1
	value := ipToUint32(parsed)
	if value < start+2 || value > end-2 {
		return fmt.Errorf("sandbox IP %s is outside the allocator host range for %s", ip, cidr)
	}
	return nil
}

func uint32ToIP(n uint32) net.IP {
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}

func findAvailableIPTx(q DBQueryer, subnetName string, cidr string, gatewayIP string) (string, error) {
	return findAvailableIPTxExcluding(q, subnetName, cidr, gatewayIP, nil)
}

func findAvailableIPTxExcluding(q DBQueryer, subnetName string, cidr string, gatewayIP string, excluded map[string]bool) (string, error) {
	// Parse subnet CIDR dynamically using net.ParseCIDR
	ipParsed, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", fmt.Errorf("invalid CIDR '%s' for subnet '%s': %w", cidr, subnetName, err)
	}

	// 1. Look for explicitly FREE records in this subnet that fall inside current CIDR
	rowsFree, err := q.Query(`
		SELECT ip_address FROM ip_allocations
		WHERE subnet_name = ? AND status = 'FREE'
		ORDER BY assigned_at
	`, subnetName)
	if err == nil {
		var freeIP string
		for rowsFree.Next() {
			if err := rowsFree.Scan(&freeIP); err == nil && freeIP != "" {
				if parsedFree := net.ParseIP(freeIP); parsedFree != nil && ipnet.Contains(parsedFree) && !excluded[freeIP] &&
					validateSandboxIP(cidr, gatewayIP, freeIP) == nil {
					rowsFree.Close()
					return freeIP, nil
				}
			}
		}
		rowsFree.Close()
	}

	// 2. Iterate subnet hosts avoiding ALLOCATED, RESERVED, or QUARANTINED IPs
	rows, err := q.Query(`
		SELECT ip_address FROM ip_allocations
		WHERE subnet_name = ? AND status IN ('ALLOCATED', 'RESERVED', 'QUARANTINED')
	`, subnetName)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	activeOrQuarantined := make(map[string]bool)
	for rows.Next() {
		var ip string
		if err := rows.Scan(&ip); err == nil {
			activeOrQuarantined[ip] = true
		}
	}

	// 3. Dynamic Host Range Iteration based on Subnet CIDR (2nd host to 253rd host)
	startIP := ipToUint32(ipParsed.Mask(ipnet.Mask))
	ones, bits := ipnet.Mask.Size()
	hostCount := uint32(1) << uint(bits-ones)
	endIP := startIP + hostCount - 1

	for n := startIP + 2; n <= endIP-2; n++ {
		candIP := uint32ToIP(n).String()
		if candIP == gatewayIP || validateSandboxIP(cidr, gatewayIP, candIP) != nil {
			continue
		}
		if activeOrQuarantined[candIP] || excluded[candIP] {
			continue
		}
		return candIP, nil
	}

	return "", fmt.Errorf("No free IPs available in subnet '%s' (check quarantined addresses).", subnetName)
}

func findAvailableIP(subnetName string) (string, error) {
	db, err := getDBConnection()
	if err != nil {
		return "", err
	}
	defer db.Close()

	reclaimExpiredQuarantinesTx(db)

	var cidr, gatewayIP string
	err = db.QueryRow("SELECT cidr, gateway_ip FROM subnets WHERE name = ?", subnetName).Scan(&cidr, &gatewayIP)
	if err != nil {
		return "", fmt.Errorf("Subnet '%s' does not exist in IPAM database.", subnetName)
	}

	return findAvailableIPTx(db, subnetName, cidr, gatewayIP)
}

type LeaseResult struct {
	SandboxID  string `json:"sandbox_id"`
	Hostname   string `json:"hostname"`
	IPAddress  string `json:"ip_address"`
	PrivateIP  string `json:"private_ip"`
	Status     string `json:"status"`
	SubnetName string `json:"subnet_name,omitempty"`
	ExpiresAt  *int64 `json:"expires_at,omitempty"`
}

func allocateLease(sandboxID, hostname, subnetName, preferredIP string) (*LeaseResult, error) {
	return allocateLeaseTTL(sandboxID, hostname, subnetName, preferredIP, 0)
}

func allocateLeaseTTL(sandboxID, hostname, subnetName, preferredIP string, ttlSeconds int64) (*LeaseResult, error) {
	return allocateLeaseTTLState(sandboxID, hostname, subnetName, preferredIP, ttlSeconds, "ACTIVE")
}

func allocateProvisionLease(sandboxID, hostname string) (*LeaseResult, error) {
	return allocateProvisionLeaseExcluding(sandboxID, hostname, nil)
}

func allocateProvisionLeaseExcluding(sandboxID, hostname string, excluded map[string]bool) (*LeaseResult, error) {
	return allocateLeaseTTLStateExcluding(sandboxID, hostname, "sandbox", "", 0, "PROVISIONING", excluded)
}

func allocateLeaseTTLState(sandboxID, hostname, subnetName, preferredIP string, ttlSeconds int64, sandboxState string) (*LeaseResult, error) {
	return allocateLeaseTTLStateExcluding(sandboxID, hostname, subnetName, preferredIP, ttlSeconds, sandboxState, nil)
}

func allocateLeaseTTLStateExcluding(sandboxID, hostname, subnetName, preferredIP string, ttlSeconds int64, sandboxState string, excluded map[string]bool) (*LeaseResult, error) {
	if sandboxState != "ACTIVE" && sandboxState != "PROVISIONING" {
		return nil, fmt.Errorf("unsupported initial sandbox state %q", sandboxState)
	}
	if subnetName == "" {
		subnetName = "sandbox"
	}
	if hostname == "" {
		hostname = fmt.Sprintf("%s.%s", sandboxID, routingDomain)
	}

	// Validate sandbox_id regex
	if !dnsLabelRE.MatchString(sandboxID) {
		return nil, fmt.Errorf("Invalid sandbox ID '%s': must be a lowercase DNS label of 1-63 characters.", sandboxID)
	}

	effectiveTTL := ttlSeconds
	if effectiveTTL <= 0 {
		effectiveTTL = defaultTTLSeconds
	}
	if effectiveTTL > maxTTLSeconds {
		return nil, fmt.Errorf("requested TTL %d exceeds maximum allowed TTL %d", effectiveTTL, maxTTLSeconds)
	}

	exp := nowUnix() + effectiveTTL

	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	defer db.Close()

	tx, err := db.Begin()
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// 1. Reclaim expired quarantines in transaction
	reclaimExpiredQuarantinesTx(tx)

	// Check existing sandbox state if row exists
	var existingStatus string
	var existingPrivateIP sql.NullString
	var existingExp sql.NullInt64
	var existingSubnet, existingHostname string
	err = tx.QueryRow("SELECT status, private_ip, expires_at, subnet_name, hostname FROM sandboxes WHERE sandbox_id = ?", sandboxID).Scan(&existingStatus, &existingPrivateIP, &existingExp, &existingSubnet, &existingHostname)
	if err == nil {
		if existingStatus == "EXPIRING" || existingStatus == "TEARING_DOWN" {
			return nil, fmt.Errorf("%w: sandbox '%s' is in state %s and cannot be allocated", ErrWrongState, sandboxID, existingStatus)
		}
		if existingStatus == "PROVISIONING" {
			return nil, fmt.Errorf("%w: sandbox '%s' is already PROVISIONING", ErrWrongState, sandboxID)
		}
		if existingStatus == "ACTIVE" && sandboxState == "PROVISIONING" {
			return nil, fmt.Errorf("%w: sandbox '%s' is already ACTIVE", ErrWrongState, sandboxID)
		}
		if existingStatus == "ACTIVE" && existingPrivateIP.Valid && existingPrivateIP.String != "" {
			var expPtr *int64
			if existingExp.Valid {
				v := existingExp.Int64
				expPtr = &v
			}
			return &LeaseResult{
				SandboxID:  sandboxID,
				Hostname:   existingHostname,
				IPAddress:  existingPrivateIP.String,
				PrivateIP:  existingPrivateIP.String,
				Status:     "ALLOCATED",
				SubnetName: existingSubnet,
				ExpiresAt:  expPtr,
			}, nil
		}
	} else if err != sql.ErrNoRows {
		return nil, fmt.Errorf("failed to query existing sandbox: %w", err)
	}

	// 2. Lookup subnet CIDR & gateway IP
	var cidr, gatewayIP string
	err = tx.QueryRow("SELECT cidr, gateway_ip FROM subnets WHERE name = ?", subnetName).Scan(&cidr, &gatewayIP)
	if err != nil {
		return nil, fmt.Errorf("Subnet '%s' does not exist in IPAM database.", subnetName)
	}

	targetIP := preferredIP
	if targetIP == "" {
		ipFound, err := findAvailableIPTxExcluding(tx, subnetName, cidr, gatewayIP, excluded)
		if err != nil {
			return nil, err
		}
		targetIP = ipFound
	} else {
		if err := validateSandboxIP(cidr, gatewayIP, targetIP); err != nil {
			return nil, err
		}
	}

	// 3. Check existing allocation in transaction
	var entityName, entityType, status, quarantineUntil string
	row := tx.QueryRow("SELECT entity_name, entity_type, status, COALESCE(quarantine_until, '') FROM ip_allocations WHERE ip_address = ?", targetIP)
	err = row.Scan(&entityName, &entityType, &status, &quarantineUntil)
	if err == nil {
		if entityType == "GATEWAY" || entityType == "BASTION" || entityType == "VIP" {
			return nil, fmt.Errorf("CRITICAL: IP %s is permanently reserved for infrastructure entity '%s' (type: %s). It cannot be allocated to a sandbox.", targetIP, entityName, entityType)
		}
		if status == "ALLOCATED" && entityName != sandboxID {
			return nil, fmt.Errorf("IP %s is currently ALLOCATED to %s.", targetIP, entityName)
		}
		if status == "QUARANTINED" {
			return nil, fmt.Errorf("IP %s is currently QUARANTINED until %s.", targetIP, quarantineUntil)
		}
	}

	// 4. Upsert allocation
	_, err = tx.Exec(`
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
	`, targetIP, subnetName, sandboxID)
	if err != nil {
		return nil, fmt.Errorf("failed to insert allocation: %w", err)
	}

	// 5. Clear stale sandboxes referencing this IP
	_, err = tx.Exec("UPDATE sandboxes SET private_ip = NULL WHERE private_ip = ? AND status IN ('RELEASED', 'FAILED', 'FAILED_HEALTH_CHECK', 'ROLLBACK')", targetIP)
	if err != nil {
		return nil, fmt.Errorf("failed to clear stale sandboxes: %w", err)
	}

	// 6. Upsert sandbox with expires_at (preserves existing expires_at if already ACTIVE)
	_, err = tx.Exec(`
		INSERT INTO sandboxes (sandbox_id, hostname, subnet_name, private_ip, status, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(sandbox_id) DO UPDATE SET
			hostname = excluded.hostname,
			subnet_name = excluded.subnet_name,
			private_ip = excluded.private_ip,
			status = excluded.status,
			expires_at = CASE
				WHEN sandboxes.status = 'ACTIVE' AND sandboxes.expires_at IS NOT NULL THEN sandboxes.expires_at
				ELSE excluded.expires_at
			END,
			updated_at = CURRENT_TIMESTAMP;
	`, sandboxID, hostname, subnetName, targetIP, sandboxState, exp)
	if err != nil {
		return nil, fmt.Errorf("failed to insert sandbox: %w", err)
	}

	// Fetch the actual persisted expires_at
	var persistedExp sql.NullInt64
	_ = tx.QueryRow("SELECT expires_at FROM sandboxes WHERE sandbox_id = ?", sandboxID).Scan(&persistedExp)
	var expPtr *int64
	if persistedExp.Valid {
		v := persistedExp.Int64
		expPtr = &v
	} else {
		expPtr = &exp
	}

	// Record allocated event in same transaction
	recordEvent(tx, sandboxID, "allocated", fmt.Sprintf("ip=%s", targetIP), 0)

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &LeaseResult{
		SandboxID:  sandboxID,
		Hostname:   hostname,
		IPAddress:  targetIP,
		PrivateIP:  targetIP,
		Status:     "ALLOCATED",
		SubnetName: subnetName,
		ExpiresAt:  expPtr,
	}, nil
}

func extendSandbox(q DBQueryer, sandboxID string, extendSeconds int64) (int64, error) {
	if db, ok := q.(*sql.DB); ok {
		tx, err := db.Begin()
		if err != nil {
			return 0, fmt.Errorf("extendSandbox: begin tx for '%s': %w", sandboxID, err)
		}
		defer tx.Rollback()
		newExp, err := extendSandbox(tx, sandboxID, extendSeconds)
		if err != nil {
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("extendSandbox: commit tx for '%s': %w", sandboxID, err)
		}
		return newExp, nil
	}

	if extendSeconds < minExtendSeconds || extendSeconds <= 0 {
		return 0, fmt.Errorf("%w: extend_seconds (%d) must be at least %d", ErrInvalidExtend, extendSeconds, minExtendSeconds)
	}
	if extendSeconds > maxTTLSeconds {
		return 0, fmt.Errorf("%w: extend_seconds (%d) exceeds maximum allowed TTL %d", ErrTTLCapExceeded, extendSeconds, maxTTLSeconds)
	}

	var status string
	var expVal sql.NullInt64
	err := q.QueryRow("SELECT status, expires_at FROM sandboxes WHERE sandbox_id = ?", sandboxID).Scan(&status, &expVal)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, fmt.Errorf("%w: sandbox '%s'", ErrSandboxNotFound, sandboxID)
		}
		return 0, fmt.Errorf("failed to query sandbox '%s': %w", sandboxID, err)
	}

	if status != "ACTIVE" || !expVal.Valid {
		return 0, fmt.Errorf("%w: sandbox '%s' (status='%s', expires_at_valid=%v)", ErrWrongState, sandboxID, status, expVal.Valid)
	}

	now := nowUnix()
	baseTime := expVal.Int64
	if now > baseTime {
		baseTime = now
	}

	// Overflow-safe cap check
	remaining := baseTime - now
	if remaining < 0 {
		remaining = 0
	}
	if extendSeconds > maxTTLSeconds-remaining {
		return 0, ErrTTLCapExceeded
	}

	newExpiresAt := baseTime + extendSeconds

	res, err := q.Exec("UPDATE sandboxes SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE sandbox_id = ? AND status = 'ACTIVE'", newExpiresAt, sandboxID)
	if err != nil {
		return 0, fmt.Errorf("failed to update expires_at for sandbox '%s': %w", sandboxID, err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to check affected rows for sandbox '%s': %w", sandboxID, err)
	}
	if rows == 0 {
		return 0, fmt.Errorf("%w: sandbox '%s'", ErrTransitionConflict, sandboxID)
	}

	recordEvent(q, sandboxID, "extended", fmt.Sprintf("from=%d to=%d", expVal.Int64, newExpiresAt), 0)

	return newExpiresAt, nil
}

type ReleaseResult struct {
	SandboxID       string `json:"sandbox_id"`
	IPAddress       string `json:"ip_address"`
	Status          string `json:"status"`
	QuarantinedAt   string `json:"quarantined_at,omitempty"`
	QuarantineUntil string `json:"quarantine_until,omitempty"`
	CooldownSeconds int    `json:"cooldown_seconds,omitempty"`
	Message         string `json:"message,omitempty"`
}

func releaseLease(sandboxID, ipAddress string, quarantineSec int) (*ReleaseResult, error) {
	if quarantineSec <= 0 {
		quarantineSec = defaultQuarantineSeconds
	}

	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	defer db.Close()

	now := time.Now().UTC()
	quarantineUntilStr := now.Add(time.Duration(quarantineSec) * time.Second).Format("2006-01-02 15:04:05")
	quarantinedAtStr := now.Format("2006-01-02 15:04:05")

	tx, txErr := db.Begin()
	if txErr != nil {
		return nil, fmt.Errorf("releaseLease: begin tx: %w", txErr)
	}
	defer tx.Rollback()

	if sandboxID == "" && ipAddress != "" {
		if err := tx.QueryRow(`SELECT entity_name FROM ip_allocations WHERE ip_address=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED'`, ipAddress).Scan(&sandboxID); err != nil {
			return nil, fmt.Errorf("lease address %s is not an allocated sandbox lease: %w", ipAddress, err)
		}
	}
	var existingStatus, managedBy string
	var privateIP sql.NullString
	err = tx.QueryRow(`SELECT status,COALESCE(private_ip,''),COALESCE(managed_by,'external') FROM sandboxes WHERE sandbox_id=?`,
		sandboxID).Scan(&existingStatus, &privateIP, &managedBy)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: sandbox %q", ErrSandboxNotFound, sandboxID)
	}
	if err != nil {
		return nil, err
	}
	if managedBy == "control-plane" {
		return nil, fmt.Errorf("sandbox %q is managed by the control plane; use DELETE /api/sandboxes/%s", sandboxID, sandboxID)
	}
	targetIP := privateIP.String
	if ipAddress != "" && ipAddress != targetIP {
		return nil, fmt.Errorf("IP %s does not belong to sandbox %q", ipAddress, sandboxID)
	}
	if targetIP != "" {
		var leaseOwner, entityType, leaseStatus string
		if err := tx.QueryRow(`SELECT entity_name,entity_type,status FROM ip_allocations WHERE ip_address=?`, targetIP).Scan(&leaseOwner, &entityType, &leaseStatus); err != nil {
			return nil, fmt.Errorf("read sandbox lease for %s: %w", targetIP, err)
		}
		if leaseOwner != sandboxID || entityType != "TEAM_SANDBOX" || leaseStatus != "ALLOCATED" {
			return nil, fmt.Errorf("IP %s is not an allocated lease owned by sandbox %q", targetIP, sandboxID)
		}
	}
	if existingStatus != "ACTIVE" && existingStatus != "EXPIRING" {
		return nil, fmt.Errorf("%w: sandbox '%s' (status '%s') must be ACTIVE or EXPIRING to be released", ErrWrongState, sandboxID, existingStatus)
	}
	updRes, err := tx.Exec("UPDATE sandboxes SET status = 'RELEASED', private_ip = NULL, updated_at = CURRENT_TIMESTAMP WHERE sandbox_id = ? AND status IN ('ACTIVE', 'EXPIRING')", sandboxID)
	if err != nil {
		return nil, fmt.Errorf("releaseLease: update sandbox '%s': %w", sandboxID, err)
	}
	updRows, err := updRes.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("releaseLease: affected rows for sandbox '%s': %w", sandboxID, err)
	}
	if updRows == 0 {
		return nil, fmt.Errorf("%w: sandbox '%s' (status '%s') must be ACTIVE or EXPIRING to be released", ErrWrongState, sandboxID, existingStatus)
	}

	if targetIP != "" {
		leaseRes, err := tx.Exec(`
			UPDATE ip_allocations
			SET status = 'QUARANTINED', quarantined_at = ?, quarantine_until = ?
			WHERE ip_address = ? AND entity_name=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED';
		`, quarantinedAtStr, quarantineUntilStr, targetIP, sandboxID)
		if err != nil {
			return nil, err
		}
		leaseRows, err := leaseRes.RowsAffected()
		if err != nil {
			return nil, err
		}
		if leaseRows != 1 {
			return nil, fmt.Errorf("sandbox %q lease changed during release", sandboxID)
		}
	}

	recordEvent(tx, sandboxID, "released", fmt.Sprintf("ip=%s,cooldown=%d", targetIP, quarantineSec), 0)

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("releaseLease: commit tx: %w", err)
	}

	fmt.Printf("✓ IP %s placed in QUARANTINED state until %s (%ds cooldown).\n", targetIP, quarantineUntilStr, quarantineSec)

	return &ReleaseResult{
		SandboxID:       sandboxID,
		IPAddress:       targetIP,
		Status:          "QUARANTINED",
		QuarantinedAt:   quarantinedAtStr,
		QuarantineUntil: quarantineUntilStr,
		CooldownSeconds: quarantineSec,
	}, nil
}

func listAllocations() {
	reclaimExpiredQuarantines()
	db, err := getDBConnection()
	if err != nil {
		fmt.Println("Error connecting to DB:", err)
		return
	}
	defer db.Close()

	fmt.Println("\n================================================================================")
	fmt.Println("                           IPAM SUBNETS OVERVIEW                                ")
	fmt.Println("================================================================================")
	subRows, _ := db.Query("SELECT name, cidr, gateway_ip, COALESCE(description, '') FROM subnets")
	if subRows != nil {
		for subRows.Next() {
			var name, cidr, gw, desc string
			subRows.Scan(&name, &cidr, &gw, &desc)
			fmt.Printf(" • [%-7s] CIDR: %-14s | Gateway: %-12s | %s\n", strings.ToUpper(name), cidr, gw, desc)
		}
		subRows.Close()
	}

	fmt.Println("\n================================================================================")
	fmt.Println("                           IP ADDRESS ALLOCATIONS                               ")
	fmt.Println("================================================================================")
	fmt.Printf("%-18s %-10s %-16s %-14s %-12s %s\n", "IP Address", "Subnet", "Entity Name", "Type", "Status", "Quarantine Until")
	fmt.Println(strings.Repeat("-", 80))
	allocRows, _ := db.Query("SELECT ip_address, subnet_name, entity_name, entity_type, status, COALESCE(quarantine_until, '-') FROM ip_allocations ORDER BY subnet_name, ip_address")
	if allocRows != nil {
		for allocRows.Next() {
			var ip, sub, entity, eType, st, qUntil string
			allocRows.Scan(&ip, &sub, &entity, &eType, &st, &qUntil)
			fmt.Printf("%-18s %-10s %-16s %-14s %-12s %s\n", ip, sub, entity, eType, st, qUntil)
		}
		allocRows.Close()
	}

	fmt.Println("\n================================================================================")
	fmt.Println("                             SANDBOXES STATUS                                   ")
	fmt.Println("================================================================================")
	fmt.Printf("%-18s %-24s %-16s %s\n", "Sandbox ID", "Hostname", "IP Address", "Status")
	fmt.Println(strings.Repeat("-", 80))
	sbRows, _ := db.Query("SELECT sandbox_id, hostname, COALESCE(private_ip, '-'), status FROM sandboxes ORDER BY created_at")
	if sbRows != nil {
		for sbRows.Next() {
			var sID, host, ip, st string
			sbRows.Scan(&sID, &host, &ip, &st)
			fmt.Printf("%-18s %-24s %-16s %s\n", sID, host, ip, st)
		}
		sbRows.Close()
	}
}
