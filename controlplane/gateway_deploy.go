package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

type gatewayDeployment struct {
	Generation string
	DurationMS int64
	GW1Backup  string
	GW2Backup  string
	DetectMS   int64
	RestoreMS  int64
}

// gatewayDeploymentRunner is the active config-push implementation.
// Default: DPA REST API (no Ansible/SSH required for config changes).
// Set to runTransactionalGatewayDeploy to fall back to Ansible-based push.
var gatewayDeploymentRunner = func(genID, snapshot, active, standby string) (gatewayDeployment, error) {
	return runDPAGatewayDeploy(genID, snapshot, active, standby)
}
var gatewayHealthCheck = liveGatewayHealthCheck
var gatewayHealthSleep = time.Sleep
var gatewayStoreFactory = newGatewayStore

func sshCommonArgs(connectTimeout int) string {
	if connectTimeout <= 0 {
		connectTimeout = 3
	}
	knownHosts := strings.TrimSpace(os.Getenv("ANSIBLE_KNOWN_HOSTS"))
	if knownHosts == "" {
		knownHosts = filepath.Join("..", "ansible", "known_hosts")
	}
	if _, err := os.Stat(knownHosts); err == nil {
		return fmt.Sprintf("-o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s -o ConnectTimeout=%d -o BatchMode=yes", knownHosts, connectTimeout)
	}
	log.Printf("ANSIBLE_KNOWN_HOSTS=%q missing; falling back to accept-new for SSH trust", knownHosts)
	return fmt.Sprintf("-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=%d -o BatchMode=yes -o IPQoS=none", connectTimeout)
}

// Compatibility shims retained for legacy tests and earlier gateway-config flows.
var varsYmlPath = ""
var gatewayConfigValidator = func(cfg string) (bool, string) { return validateHAProxySyntax(cfg) }
var gatewayPlaybookRunner = func(_ string) error { return nil }
var backupDir = "/tmp"

func createGeneratedRoutesVars(cfg string, generation string) (string, error) {
	file, err := os.CreateTemp("", "felcloud-generated-routes-*.yml")
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err := file.WriteString(cfg); err != nil {
		return "", err
	}
	if generation != "" {
		_ = generation
	}
	return file.Name(), nil
}

func parseApplyGuardMetrics(output string) (detectMS int64, restoreMS int64) {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
			continue
		}
		var payload struct {
			Host      string `json:"host"`
			DetectMS  int64  `json:"detect_ms"`
			RestoreMS int64  `json:"restore_ms"`
		}
		if err := json.Unmarshal([]byte(trimmed), &payload); err == nil {
			if payload.DetectMS > 0 {
				detectMS = payload.DetectMS
			}
			if payload.RestoreMS >= 0 {
				restoreMS = payload.RestoreMS
			}
		}
	}
	return detectMS, restoreMS
}

func generationID(prefix string) string {
	return fmt.Sprintf("%s-%s", prefix, time.Now().UTC().Format("20060102T150405.000000000"))
}

func generationContentSHA(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func gatewayStateValue(db *sql.DB, key string) (string, error) {
	var value string
	err := db.QueryRow(`SELECT value FROM gateway_state WHERE key = ?`, key).Scan(&value)
	if err != nil {
		return "", err
	}
	return value, nil
}

func gatewayDeployTimeoutSeconds() int {
	v := strings.TrimSpace(os.Getenv("GATEWAY_DEPLOY_TIMEOUT_SECONDS"))
	if v == "" {
		return 120
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 120
	}
	return n
}

func setGatewayState(db *sql.DB, key string, value string) error {
	_, err := db.Exec(`INSERT INTO gateway_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, key, value)
	return err
}

func recordGatewayOperationEvent(eventType, trigger, reason string, durationMS int64) {
	db, err := getDBConnection()
	if err != nil {
		return
	}
	defer db.Close()
	recordEvent(db, "", eventType, fmt.Sprintf("trigger=%s reason=%s", trigger, reason), durationMS)
}

func gatewayConfigForHost(config, host string) string {
	config = strings.ReplaceAll(config, "__FELCLOUD_GATEWAY_ID__", host)
	header := "    http-response set-header X-Gateway-ID " + host + "\n"
	for _, frontend := range []string{"frontend http_front\n", "frontend https_front\n"} {
		if at := strings.Index(config, frontend); at >= 0 {
			end := strings.Index(config[at+len(frontend):], "\nfrontend ")
			frontendConfig := config[at:]
			if end >= 0 {
				frontendConfig = config[at : at+len(frontend)+end]
			}
			if strings.Contains(frontendConfig, "http-response set-header X-Gateway-ID") {
				continue
			}
			modeAt := strings.Index(config[at:], "    mode http\n")
			if modeAt >= 0 {
				insertAt := at + modeAt + len("    mode http\n")
				config = config[:insertAt] + header + config[insertAt:]
			}
		}
	}
	return config
}

func runTransactionalGatewayDeploy(genID, snapshot, active, standby string) (gatewayDeployment, error) {
	if active == "" || standby == "" || active == standby || !allowedGateways[active] || !allowedGateways[standby] {
		return gatewayDeployment{}, errors.New("could not determine distinct active and standby gateways")
	}
	paths := map[string]string{}
	cleanup := func() {
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
	defer cleanup()
	for _, host := range gatewayHosts {
		file, err := os.CreateTemp("", "felcloud-haproxy-"+host+"-*.cfg")
		if err != nil {
			return gatewayDeployment{}, err
		}
		paths[host] = file.Name()
		if _, err = file.WriteString(gatewayConfigForHost(snapshot, host)); err != nil {
			file.Close()
			return gatewayDeployment{}, err
		}
		if err = file.Close(); err != nil {
			return gatewayDeployment{}, err
		}
	}
	vars := map[string]any{"haproxy_generation_id": genID, "haproxy_candidate_sources": paths, "haproxy_active_gateway": active, "haproxy_standby_gateway": standby}
	data, err := yaml.Marshal(vars)
	if err != nil {
		return gatewayDeployment{}, err
	}
	file, err := os.CreateTemp("", "felcloud-haproxy-deploy-*.yml")
	if err != nil {
		return gatewayDeployment{}, err
	}
	varsPath := file.Name()
	defer os.Remove(varsPath)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return gatewayDeployment{}, err
	}
	if err = file.Close(); err != nil {
		return gatewayDeployment{}, err
	}

	started := time.Now()
	inventory := resolveRepoFilePath("ANSIBLE_INVENTORY", "ansible/inventory/hosts.yml")
	playbook := resolveRepoFilePath("HAPROXY_TRANSACTION_PLAYBOOK", "ansible/haproxy-transaction.yml")
	vault := resolveRepoFilePath("ANSIBLE_VAULT_PASS", "ansible/.vault_pass")
	bastion := envOr("BASTION_IP", "197.5.133.77")
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(gatewayDeployTimeoutSeconds())*time.Second)
	defer cancel()
	args := []string{"-i", inventory, playbook, "--vault-password-file", vault, "-e", "@" + varsPath,
		"-e", fmt.Sprintf("ansible_ssh_common_args='-o ProxyJump=ansible@%s %s'", bastion, sshCommonArgs(5))}
	cmd := exec.CommandContext(ctx, "ansible-playbook", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			if cmd.Process != nil {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
			return gatewayDeployment{Generation: genID, DurationMS: time.Since(started).Milliseconds()}, fmt.Errorf("gateway deploy timed out after %ds: %w: %s", gatewayDeployTimeoutSeconds(), ctx.Err(), strings.TrimSpace(output.String()))
		}
		return gatewayDeployment{Generation: genID, DurationMS: time.Since(started).Milliseconds()}, fmt.Errorf("remote stage/validate/apply failed: %w: %s", err, strings.TrimSpace(output.String()))
	}
	detectMS, restoreMS := parseApplyGuardMetrics(output.String())
	return gatewayDeployment{Generation: genID, DurationMS: time.Since(started).Milliseconds(), GW1Backup: "/etc/haproxy/backups/haproxy.cfg." + genID, GW2Backup: "/etc/haproxy/backups/haproxy.cfg." + genID, DetectMS: detectMS, RestoreMS: restoreMS}, nil
}

type gatewayHealthSnapshot struct {
	Probes    ProbeResult
	VIPStatus int
	Backends  map[string]string
}

func liveGatewayHealthCheck(ctx context.Context, store *gatewayStore) (gatewayHealthSnapshot, error) {
	probes := runGatewayProbes(store)
	for _, host := range gatewayHosts {
		p, ok := probes.Gateways[host]
		if !ok || !p.Reachable || p.HAProxy != "UP" {
			return gatewayHealthSnapshot{}, fmt.Errorf("%s HAProxy is not active", host)
		}
	}
	target, host, err := failoverProbeTarget()
	if err != nil {
		return gatewayHealthSnapshot{}, err
	}
	vip := failoverVIPProbe(ctx, target, host)
	if vip.Err != nil || vip.Status < 200 || vip.Status >= 400 {
		return gatewayHealthSnapshot{}, fmt.Errorf("VIP health check failed: status=%d error=%v", vip.Status, vip.Err)
	}
	backends, err := readGatewayBackendStates(ctx)
	if err != nil {
		return gatewayHealthSnapshot{}, err
	}
	return gatewayHealthSnapshot{Probes: probes, VIPStatus: vip.Status, Backends: backends}, nil
}

// readGatewayBackendStates queries DPA /v3/services/haproxy/stats on each gateway
// and returns a map of "host/backend/server" → status strings.
// Falls back to the Ansible socket probe when DPA_PASS is not set.
func readGatewayBackendStates(ctx context.Context) (map[string]string, error) {
	_, _, dpaErr := dpaCredentials()
	if dpaErr != nil {
		// DPA not configured — fall back to Ansible stats socket probe.
		return readGatewayBackendStatesViaAnsible(ctx)
	}
	return readGatewayBackendStatesViaDPA(ctx)
}

// readGatewayBackendStatesViaDPA queries the HAProxy Data Plane API /stats endpoint.
func readGatewayBackendStatesViaDPA(ctx context.Context) (map[string]string, error) {
	user, pass, _ := dpaCredentials()
	states := map[string]string{}
	for _, host := range gatewayHosts {
		base := dpaBaseURL(host)
		probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		body, status, err := dpaRequest(probeCtx, "GET", base+"/services/haproxy/stats", nil, user, pass, "")
		cancel()
		if err != nil {
			return nil, fmt.Errorf("DPA stats %s: %w", host, err)
		}
		if status != 200 {
			return nil, fmt.Errorf("DPA stats %s: HTTP %d: %s", host, status, truncate(string(body), 200))
		}
		// DPA returns a JSON array of stat objects.
		var entries []struct {
			BackendName string `json:"backend_name"`
			Name        string `json:"name"`
			Type        string `json:"type"` // "server", "backend", "frontend"
			Stats       struct {
				Status string `json:"status"`
			} `json:"stats"`
		}
		if err := json.Unmarshal(body, &entries); err != nil {
			return nil, fmt.Errorf("DPA stats %s: parse: %w", host, err)
		}
		for _, e := range entries {
			if e.Type == "server" && e.Name != "" && e.BackendName != "" {
				states[host+"/"+e.BackendName+"/"+e.Name] = e.Stats.Status
			}
		}
	}
	return states, nil
}

// readGatewayBackendStatesViaAnsible is the legacy fallback (Ansible → UNIX socket).
func readGatewayBackendStatesViaAnsible(ctx context.Context) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	bastion := envOr("BASTION_IP", "197.5.133.77")
	statsCommand := `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect("/run/haproxy/admin.sock"); s.sendall(b"show stat\n"); s.shutdown(socket.SHUT_WR); print(s.recv(1048576).decode())'`
	args := []string{"-i", resolveRepoFilePath("ANSIBLE_INVENTORY", "ansible/inventory/hosts.yml"), "gateways", "-m", "shell", "-a", statsCommand, "-b", "--vault-password-file", resolveRepoFilePath("ANSIBLE_VAULT_PASS", "ansible/.vault_pass"), "-e", fmt.Sprintf("ansible_ssh_common_args='-o ProxyJump=ansible@%s -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -o IPQoS=none'", bastion)}
	cmd := exec.CommandContext(ctx, "ansible", args...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("read HAProxy backend status: %w: %s", err, strings.TrimSpace(out.String()))
	}
	if !strings.Contains(out.String(), "# pxname") {
		return nil, errors.New("HAProxy backend status output contained no CSV header")
	}
	return parseBackendStates(out.String()), nil
}

func parseBackendStates(output string) map[string]string {
	states := map[string]string{}
	currentHost := "unknown"
	var block strings.Builder
	flush := func() {
		if block.Len() == 0 {
			return
		}
		reader := csv.NewReader(strings.NewReader(block.String()))
		reader.FieldsPerRecord = -1
		var header []string
		for {
			row, err := reader.Read()
			if err != nil {
				break
			}
			if len(row) == 0 {
				continue
			}
			if strings.TrimSpace(row[0]) == "# pxname" {
				header = row
				continue
			}
			if len(header) == 0 || len(row) < len(header) {
				continue
			}
			indexes := map[string]int{}
			for i, h := range header {
				indexes[strings.TrimSpace(h)] = i
			}
			px, pxOK := indexes["# pxname"]
			if !pxOK {
				px, pxOK = indexes["pxname"]
			}
			sv, svOK := indexes["svname"]
			status, statusOK := indexes["status"]
			if !pxOK || !svOK || !statusOK || px >= len(row) || sv >= len(row) || status >= len(row) {
				continue
			}
			name := strings.TrimSpace(row[sv])
			if name != "BACKEND" && name != "FRONTEND" {
				states[currentHost+"/"+strings.TrimSpace(row[px])+"/"+name] = strings.TrimSpace(row[status])
			}
		}
		block.Reset()
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, " | ") && strings.HasSuffix(strings.TrimSpace(line), ">>") {
			flush()
			currentHost = strings.SplitN(line, " | ", 2)[0]
			continue
		}
		if strings.Contains(line, " | FAILED | ") || strings.Contains(line, " | UNREACHABLE!") {
			flush()
			continue
		}
		block.WriteString(line)
		block.WriteByte('\n')
	}
	flush()
	return states
}

func healthWindow() (time.Duration, error) {
	seconds := 45
	if value := strings.TrimSpace(os.Getenv("HEALTH_REGRESSION_WINDOW_SECONDS")); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 0 || n > 3600 {
			return 0, errors.New("HEALTH_REGRESSION_WINDOW_SECONDS must be 0..3600")
		}
		seconds = n
	}
	return time.Duration(seconds) * time.Second, nil
}

func verifyGatewayHealthWindow(store *gatewayStore, before gatewayHealthSnapshot) error {
	window, err := healthWindow()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(window)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		after, checkErr := gatewayHealthCheck(ctx, store)
		cancel()
		if checkErr != nil {
			return checkErr
		}
		for backend, beforeStatus := range before.Backends {
			afterStatus, exists := after.Backends[backend]
			if !strings.HasPrefix(beforeStatus, "DOWN") && (!exists || strings.HasPrefix(afterStatus, "DOWN")) {
				return fmt.Errorf("backend %s became DOWN (before=%q after=%q)", backend, beforeStatus, afterStatus)
			}
		}
		if !time.Now().Before(deadline) {
			return nil
		}
		gatewayHealthSleep(time.Second)
	}
}

func loadActiveAndStandby(store *gatewayStore) (string, string, gatewayHealthSnapshot, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	snapshot, err := gatewayHealthCheck(ctx, store)
	if err != nil {
		return "", "", gatewayHealthSnapshot{}, fmt.Errorf("baseline gateway health failed: %w", err)
	}
	active := snapshot.Probes.VIPHolder
	if active != "gw1" && active != "gw2" {
		return "", "", gatewayHealthSnapshot{}, errors.New("could not identify current VIP holder")
	}
	standby := "gw1"
	if active == "gw1" {
		standby = "gw2"
	}
	return active, standby, snapshot, nil
}

func loadGatewayOrderForRollback(store *gatewayStore) (string, string, gatewayHealthSnapshot, error) {
	probes := runGatewayProbes(store)
	active := probes.VIPHolder
	if active != "gw1" && active != "gw2" {
		return "", "", gatewayHealthSnapshot{}, errors.New("could not identify current VIP holder for rollback")
	}
	standby := "gw1"
	if active == "gw1" {
		standby = "gw2"
	}
	return active, standby, gatewayHealthSnapshot{Probes: probes, Backends: map[string]string{}}, nil
}

func rollbackConfigWithOptions(targetGeneration, trigger, reason string) (generation string, durationMS int64, resultErr error) {
	started := time.Now()
	defer func() {
		if resultErr != nil {
			if eventDB, openErr := getDBConnection(); openErr == nil {
				recordEvent(eventDB, "", "rollback", fmt.Sprintf("trigger=%s reason=%s result=failed error=%s", trigger, reason, resultErr), time.Since(started).Milliseconds())
				_ = eventDB.Close()
			}
		}
	}()
	db, err := getDBConnection()
	if err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	var sourceID, snapshot string
	if strings.TrimSpace(targetGeneration) == "" {
		if trigger == "auto" {
			err = db.QueryRow(`SELECT generation_id, config_snapshot FROM config_generations WHERE status='COMMITTED' ORDER BY id DESC LIMIT 1`).Scan(&sourceID, &snapshot)
		} else {
			err = db.QueryRow(`SELECT generation_id, config_snapshot FROM config_generations WHERE status='COMMITTED' ORDER BY id DESC LIMIT 1 OFFSET 1`).Scan(&sourceID, &snapshot)
		}
	} else {
		err = db.QueryRow(`SELECT generation_id, config_snapshot FROM config_generations WHERE generation_id=? AND status='COMMITTED'`, targetGeneration).Scan(&sourceID, &snapshot)
	}
	db.Close()
	if err != nil {
		return "", time.Since(started).Milliseconds(), fmt.Errorf("committed rollback snapshot not found: %w", err)
	}
	store, err := gatewayStoreFactory()
	if err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	defer store.close()
	active, standby, baseline, err := loadGatewayOrderForRollback(store)
	if err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	rollbackID := generationID("rollback")
	if _, err = gatewayDeploymentRunner(rollbackID, snapshot, active, standby); err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	if err = verifyGatewayHealthWindow(store, baseline); err != nil {
		return "", time.Since(started).Milliseconds(), fmt.Errorf("rollback health check failed: %w", err)
	}
	db, err = getDBConnection()
	if err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	_, err = db.Exec(`INSERT INTO config_generations (generation_id, config_snapshot, status, gw1_backup, gw2_backup) VALUES (?, ?, 'COMMITTED', ?, ?)`, rollbackID, snapshot, "/etc/haproxy/backups/haproxy.cfg."+rollbackID, "/etc/haproxy/backups/haproxy.cfg."+rollbackID)
	if err == nil {
		recordEvent(db, "", "rollback", fmt.Sprintf("trigger=%s reason=%s target=%s result=success", trigger, reason, sourceID), time.Since(started).Milliseconds())
	}
	db.Close()
	if err != nil {
		return "", time.Since(started).Milliseconds(), err
	}
	gwCache.Invalidate()
	return rollbackID, time.Since(started).Milliseconds(), nil
}
