package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var ErrTransitionConflict = errors.New("concurrent state transition conflict")

var (
	ErrIllegalTransition = errors.New("illegal state transition")
	ErrTTLCapExceeded    = errors.New("requested TTL extension exceeds maximum allowed cap")
	ErrSandboxNotFound   = errors.New("sandbox not found")
	ErrWrongState        = errors.New("sandbox in invalid state for operation")
	ErrInvalidExtend     = errors.New("invalid extend seconds value")
)

var (
	dbMutex                  sync.Mutex
	dbPath                   string
	defaultQuarantineSeconds int
	routingDomain            string       = "cstam.felcloud.tn"
	defaultTTLSeconds        int64        = 14400
	maxTTLSeconds            int64        = 86400
	minExtendSeconds         int64        = 60
	nowUnix                  func() int64 = func() int64 { return time.Now().UTC().Unix() }

	reaperIntervalSeconds  int = 10
	reaperBatchSize        int = 20
	teardownMaxAttempts    int = 5
	eventsRetentionSeconds int = 259200
)

var (
	reaperTickMutex sync.Mutex

	lastTickUnix         atomic.Int64
	lastTickDurationMs   atomic.Int64
	oldestOverdueSeconds atomic.Int64
	teardownsDone        atomic.Int64
	teardownFailures     atomic.Int64
	eventsPruned         atomic.Int64
)

func validateRoutingDomain(domain string) error {
	if len(domain) == 0 || len(domain) > 190 {
		return fmt.Errorf("invalid routing domain length (%d): must be between 1 and 190 characters", len(domain))
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.HasPrefix(domain, "-") || strings.HasSuffix(domain, "-") {
		return fmt.Errorf("invalid routing domain '%s': cannot start or end with '.' or '-'", domain)
	}

	labels := strings.Split(domain, ".")
	labelRegex := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return fmt.Errorf("invalid routing domain label '%s': label length must be 1-63 chars", label)
		}
		if !labelRegex.MatchString(label) {
			return fmt.Errorf("invalid routing domain label '%s': must contain only lowercase letters, digits, and hyphens, and cannot start/end with hyphen", label)
		}
	}
	return nil
}

func parseTTLConfig(lookupEnv func(string) string) (int64, int64, int64, error) {
	defTTL := int64(14400)
	maxTTL := int64(86400)
	minExt := int64(60)

	if envDefTTL := lookupEnv("DEFAULT_TTL_SECONDS"); envDefTTL != "" {
		v, err := strconv.ParseInt(envDefTTL, 10, 64)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid DEFAULT_TTL_SECONDS '%s': %w", envDefTTL, err)
		}
		defTTL = v
	}
	if envMaxTTL := lookupEnv("MAX_TTL_SECONDS"); envMaxTTL != "" {
		v, err := strconv.ParseInt(envMaxTTL, 10, 64)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid MAX_TTL_SECONDS '%s': %w", envMaxTTL, err)
		}
		maxTTL = v
	}
	if envMinExt := lookupEnv("MIN_EXTEND_SECONDS"); envMinExt != "" {
		v, err := strconv.ParseInt(envMinExt, 10, 64)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid MIN_EXTEND_SECONDS '%s': %w", envMinExt, err)
		}
		minExt = v
	}

	if defTTL > maxTTL || defTTL <= 0 || maxTTL <= 0 || minExt <= 0 {
		return 0, 0, 0, fmt.Errorf("invalid TTL configuration: default=%d, max=%d, min_extend=%d (must have 0 < default <= max and min_extend > 0)", defTTL, maxTTL, minExt)
	}

	return defTTL, maxTTL, minExt, nil
}

func parseReaperConfig(lookupEnv func(string) string) (int, int, int, int, error) {
	interval := 10
	batchSize := 20
	maxAttempts := 5
	retention := 259200

	if v := lookupEnv("REAPER_INTERVAL_SECONDS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("invalid REAPER_INTERVAL_SECONDS '%s': %w", v, err)
		}
		interval = n
	}
	if v := lookupEnv("REAPER_BATCH_SIZE"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("invalid REAPER_BATCH_SIZE '%s': %w", v, err)
		}
		batchSize = n
	}
	if v := lookupEnv("TEARDOWN_MAX_ATTEMPTS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("invalid TEARDOWN_MAX_ATTEMPTS '%s': %w", v, err)
		}
		maxAttempts = n
	}
	if v := lookupEnv("EVENTS_RETENTION_SECONDS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("invalid EVENTS_RETENTION_SECONDS '%s': %w", v, err)
		}
		retention = n
	}

	if interval < 1 || batchSize < 1 || maxAttempts < 1 || retention < 1 {
		return 0, 0, 0, 0, fmt.Errorf("invalid reaper configuration: interval=%d (min 1), batch=%d (min 1), max_attempts=%d (min 1), retention=%d (min 1)", interval, batchSize, maxAttempts, retention)
	}
	return interval, batchSize, maxAttempts, retention, nil
}

func parseIPQuarantineSeconds(value string) (int, error) {
	seconds := 60
	if value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return 0, fmt.Errorf("IP_QUARANTINE_SECONDS must be an integer from 1 to 86400: %w", err)
		}
		seconds = parsed
	}
	if seconds < 1 || seconds > 86400 {
		return 0, fmt.Errorf("IP_QUARANTINE_SECONDS must be an integer from 1 to 86400 (got %d)", seconds)
	}
	return seconds, nil
}

func loadDotEnv() {
	paths := []string{".env", "../.env"}
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				k := strings.TrimSpace(parts[0])
				v := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
				if os.Getenv(k) == "" {
					os.Setenv(k, v)
				}
			}
		}
		break
	}
}

func initEnv() {
	loadDotEnv()
	execDir, err := os.Getwd()
	if err != nil {
		execDir = "."
	}

	// Determine DB path
	if envDB := os.Getenv("IPAM_DB_PATH"); envDB != "" {
		dbPath = envDB
	} else if _, err := os.Stat(filepath.Join(execDir, "ipam.db")); err == nil {
		dbPath = filepath.Join(execDir, "ipam.db")
	} else if _, err := os.Stat(filepath.Join(execDir, "ipam", "ipam.db")); err == nil {
		dbPath = filepath.Join(execDir, "ipam", "ipam.db")
	} else {
		// Fallback relative to project root
		dbPath = filepath.Join(execDir, "ipam", "ipam.db")
	}
	dbPath, err = filepath.Abs(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: cannot resolve IPAM database path: %v\n", err)
		os.Exit(1)
	}

	defaultQuarantineSeconds, err = parseIPQuarantineSeconds(os.Getenv("IP_QUARANTINE_SECONDS"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	routingDomain = "cstam.felcloud.tn"
	if envRD := os.Getenv("ROUTING_DOMAIN"); envRD != "" {
		routingDomain = envRD
	}
	if err := validateRoutingDomain(routingDomain); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Invalid ROUTING_DOMAIN '%s': %v\n", routingDomain, err)
		os.Exit(1)
	}

	defTTL, maxTTL, minExt, err := parseTTLConfig(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	defaultTTLSeconds = defTTL
	maxTTLSeconds = maxTTL
	minExtendSeconds = minExt

	repInt, repBatch, repMaxAtt, repRet, err := parseReaperConfig(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	reaperIntervalSeconds = repInt
	reaperBatchSize = repBatch
	teardownMaxAttempts = repMaxAtt
	eventsRetentionSeconds = repRet
	tdTimeout, tdConcurrency, tdErr := parseTeardownConfig(os.Getenv)
	if tdErr != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", tdErr)
		os.Exit(1)
	}
	teardownTimeout = tdTimeout
	teardownConcurrency = tdConcurrency
}

func printUsage() {
	fmt.Println("FelCloud Resilient Gateway Control Plane CLI (Go)")
	fmt.Println("Usage:")
	fmt.Println("  felcloud-controlplane init")
	fmt.Println("  felcloud-controlplane list")
	fmt.Println("  felcloud-controlplane reclaim")
	fmt.Println("  felcloud-controlplane add-team --name <team> [--ip <ip>] [--port <port>] [--skip-health-check]")
	fmt.Println("  felcloud-controlplane remove-team --name <team> [--cooldown <seconds>]")
	fmt.Println("  felcloud-controlplane allocate --name <team> [--ip <ip>] [--subnet <subnet>]")
	fmt.Println("  felcloud-controlplane sync [--dry-run]")
	fmt.Println("  felcloud-controlplane rollback")
	fmt.Println("  felcloud-controlplane teardown --name <team>")
	fmt.Println("  felcloud-controlplane serve [--port <port>]")
	fmt.Println("  felcloud-controlplane gateway-api")
}

func main() {
	initEnv()

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	action := os.Args[1]
	switch action {
	case "init":
		if err := initDB(); err != nil {
			fmt.Printf("Init Error: %v\n", err)
			os.Exit(1)
		}

	case "list":
		if _, err := os.Stat(dbPath); os.IsNotExist(err) {
			_ = initDB()
		}
		listAllocations()

	case "reclaim":
		_ = initDB()
		reclaimExpiredQuarantines()

	case "allocate":
		var name, ip, subnet string
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--name" && i+1 < len(os.Args) {
				name = os.Args[i+1]
			} else if os.Args[i] == "--ip" && i+1 < len(os.Args) {
				ip = os.Args[i+1]
			} else if os.Args[i] == "--subnet" && i+1 < len(os.Args) {
				subnet = os.Args[i+1]
			}
		}
		if name == "" {
			fmt.Println("Error: Missing --name argument.")
			os.Exit(1)
		}
		_ = initDB()
		res, err := allocateLease(name, "", subnet, ip)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}
		out, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(out))

	case "add-team":
		var teamName, ipAddr string
		port := 80
		skipHealth := false
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--name" && i+1 < len(os.Args) {
				teamName = os.Args[i+1]
			} else if os.Args[i] == "--ip" && i+1 < len(os.Args) {
				ipAddr = os.Args[i+1]
			} else if os.Args[i] == "--port" && i+1 < len(os.Args) {
				port, _ = strconv.Atoi(os.Args[i+1])
			} else if os.Args[i] == "--skip-health-check" {
				skipHealth = true
			}
		}
		if teamName == "" {
			fmt.Println("Error: Missing --name argument.")
			os.Exit(1)
		}
		success, _ := addTeamFlow(teamName, ipAddr, port, skipHealth)
		if !success {
			os.Exit(1)
		}

	case "remove-team":
		var teamName string
		cooldown := 0
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--name" && i+1 < len(os.Args) {
				teamName = os.Args[i+1]
			} else if os.Args[i] == "--cooldown" && i+1 < len(os.Args) {
				cooldown, _ = strconv.Atoi(os.Args[i+1])
			}
		}
		if teamName == "" {
			fmt.Println("Error: Missing --name argument.")
			os.Exit(1)
		}
		success, _ := removeTeamFlow(teamName, cooldown)
		if !success {
			os.Exit(1)
		}

	case "teardown":
		var name string
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--name" && i+1 < len(os.Args) {
				name = os.Args[i+1]
			}
		}
		if !dnsLabelRE.MatchString(name) {
			fmt.Fprintln(os.Stderr, "Error: --name must be a lowercase DNS label of 1-63 characters.")
			os.Exit(1)
		}
		result, err := teardownCLI(name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Teardown Error: %v\n", err)
			os.Exit(1)
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(out))

	case "sync":
		dryRun := false
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--dry-run" {
				dryRun = true
			}
		}
		_ = initDB()
		success, _ := syncHAProxyDualGateways(dryRun)
		if !success {
			os.Exit(1)
		}

	case "rollback":
		_ = initDB()
		if !rollbackConfig() {
			os.Exit(1)
		}

	case "serve":
		port := 8081
		// Honour PORT env var as a fallback (original gateway.go behaviour).
		if envPort := os.Getenv("PORT"); envPort != "" {
			if p, err := strconv.Atoi(envPort); err == nil {
				port = p
			}
		}
		// --port flag always wins over the env var.
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--port" && i+1 < len(os.Args) {
				port, _ = strconv.Atoi(os.Args[i+1])
			}
		}
		startGatewayServer(port)

	case "gateway-api":
		runGatewayAPIServer()

	default:
		fmt.Printf("Unknown action: %s\n", action)
		printUsage()
		os.Exit(1)
	}
}

func teardownCLI(name string) (*teardownResult, error) {
	if err := initDB(); err != nil {
		return nil, err
	}
	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	snapshot, err := loadTeardownSnapshot(db, name)
	if err == nil && snapshot.managedBy != "control-plane" {
		// Route through the shared guard so refusal is durably recorded once.
		db.Close()
		return teardownSandbox(context.Background(), name)
	}
	if closeErr := db.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if err := configureProvisioner(context.Background()); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), teardownTimeout)
	defer cancel()
	return teardownSandbox(ctx, name)
}
