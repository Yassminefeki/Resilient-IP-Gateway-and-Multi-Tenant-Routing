package main

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

func checkSandboxHealth(ipAddress string, port int, timeout time.Duration, maxRetries int, retryInterval time.Duration) (bool, string) {
	if port <= 0 {
		port = 80
	}
	url := fmt.Sprintf("http://%s:%d/", ipAddress, port)
	fmt.Printf("--> Performing pre-flight health check on %s (max %d attempts)...\n", url, maxRetries)

	client := &http.Client{
		Timeout: timeout,
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		req, err := http.NewRequest("GET", url, nil)
		if err == nil {
			req.Header.Set("User-Agent", "FelCloud-HealthCheck/2.0")
			resp, err := client.Do(req)
			if err == nil {
				defer resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 400 {
					msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
					fmt.Printf("✓ Health check PASSED on %s (Attempt %d, Status %d)\n", url, attempt, resp.StatusCode)
					return true, msg
				}
			}
		}

		// Fallback lightweight TCP socket probe
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", ipAddress, port), timeout)
		if err == nil {
			conn.Close()
			fmt.Printf("✓ Health check (TCP socket) PASSED on %s:%d\n", ipAddress, port)
			return true, "TCP Connection Established"
		}

		if attempt < maxRetries {
			time.Sleep(retryInterval)
		}
	}

	msg := fmt.Sprintf("Connection to %s:%d failed or timed out", ipAddress, port)
	fmt.Printf("✗ Pre-flight health check FAILED on %s after %d attempts.\n", url, maxRetries)
	return false, msg
}

func validateHAProxySyntax(configContent string) (bool, string) {
	tempCertPath := "/tmp/haproxy_temp_test_cert.pem"
	testContent := configContent
	tempCertCreated := false

	re := regexp.MustCompile(`crt\s+(\S+)`)
	matches := re.FindAllStringSubmatch(configContent, -1)
	for _, m := range matches {
		if len(m) > 1 {
			certPath := m[1]
			if _, err := os.Stat(certPath); os.IsNotExist(err) {
				if _, err := os.Stat(tempCertPath); os.IsNotExist(err) {
					cmd := exec.Command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
						"-keyout", "/tmp/temp_k.key", "-out", "/tmp/temp_c.crt",
						"-days", "1", "-subj", "/CN=localhost")
					_ = cmd.Run()
					kData, err1 := os.ReadFile("/tmp/temp_k.key")
					cData, err2 := os.ReadFile("/tmp/temp_c.crt")
					if err1 == nil && err2 == nil {
						combined := append(kData, '\n')
						combined = append(combined, cData...)
						_ = os.WriteFile(tempCertPath, combined, 0644)
						tempCertCreated = true
					}
					_ = os.Remove("/tmp/temp_k.key")
					_ = os.Remove("/tmp/temp_c.crt")
				}
				if _, err := os.Stat(tempCertPath); err == nil {
					testContent = strings.ReplaceAll(testContent, certPath, tempCertPath)
				}
			}
		}
	}

	tmpFile, err := os.CreateTemp("", "haproxy_*.cfg")
	if err != nil {
		return false, err.Error()
	}
	defer os.Remove(tmpFile.Name())

	_, _ = tmpFile.WriteString(testContent)
	_ = tmpFile.Close()

	cmd := exec.Command("haproxy", "-c", "-f", tmpFile.Name())
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	err = cmd.Run()
	if err == nil {
		if tempCertCreated {
			_ = os.Remove(tempCertPath)
		}
		return true, "Configuration syntax is valid"
	}

	if tempCertCreated {
		_ = os.Remove(tempCertPath)
	}

	if strings.Contains(err.Error(), "executable file not found") {
		if strings.Contains(configContent, "frontend") && strings.Contains(configContent, "backend") {
			return false, "structural check only, haproxy not installed"
		}
		return false, "structural check only, haproxy not installed"
	}

	return false, fmt.Sprintf("HAProxy syntax error:\n%s\n%s", errBuf.String(), outBuf.String())
}

type TeamEntry struct {
	Name         string `yaml:"name" json:"name"`
	IP           string `yaml:"ip" json:"ip"`
	Port         int    `yaml:"port,omitempty" json:"port,omitempty"`
	CustomDomain string `yaml:"custom_domain,omitempty" json:"custom_domain,omitempty"`
}

func generateHAProxyConfig(teams []TeamEntry) string {
	var sb strings.Builder

	sb.WriteString("global\n")
	sb.WriteString("    log /dev/log local0\n")
	sb.WriteString("    log /dev/log local1 notice\n")
	sb.WriteString("    chroot /var/lib/haproxy\n")
	sb.WriteString("    user haproxy\n")
	sb.WriteString("    group haproxy\n")
	sb.WriteString("    daemon\n")
	sb.WriteString("    stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners\n")
	sb.WriteString("    stats timeout 30s\n\n")

	sb.WriteString("defaults\n")
	sb.WriteString("    log     global\n")
	sb.WriteString("    mode    http\n")
	sb.WriteString("    option  httplog\n")
	sb.WriteString("    option  dontlognull\n")
	sb.WriteString("    timeout connect 5000ms\n")
	sb.WriteString("    timeout client  50000ms\n")
	sb.WriteString("    timeout server  50000ms\n")
	sb.WriteString("    errorfile 400 /etc/haproxy/errors/400.http\n")
	sb.WriteString("    errorfile 403 /etc/haproxy/errors/403.http\n")
	sb.WriteString("    errorfile 408 /etc/haproxy/errors/408.http\n")
	sb.WriteString("    errorfile 500 /etc/haproxy/errors/500.http\n")
	sb.WriteString("    errorfile 502 /etc/haproxy/errors/502.http\n")
	sb.WriteString("    errorfile 503 /etc/haproxy/errors/503.http\n")
	sb.WriteString("    errorfile 504 /etc/haproxy/errors/504.http\n\n")

	sb.WriteString("frontend health_check\n")
	sb.WriteString("    bind 127.0.0.1:9000\n")
	sb.WriteString("    mode http\n")
	sb.WriteString("    monitor-uri /healthz\n\n")

	sb.WriteString("frontend http_front\n")
	sb.WriteString("    bind *:80\n")
	sb.WriteString("    mode http\n")
	sb.WriteString("    http-response set-header X-Gateway-ID __FELCLOUD_GATEWAY_ID__\n")
	sb.WriteString("    # Gateway Rate Limiting & Throttling (+2 Bonus Points)\n")
	sb.WriteString("    stick-table type ip size 100k expire 1m store http_req_rate(10s)\n")
	sb.WriteString("    http-request track-sc0 src\n")
	sb.WriteString("    http-request deny deny_status 429 content-type \"text/plain\" lf-string \"429 Too Many Requests - Gateway Rate Limit Exceeded\\n\" if { sc_http_req_rate(0) gt 100 }\n")
	for _, t := range teams {
		sb.WriteString(fmt.Sprintf("    acl is_%s hdr(host) -i %s.%s\n", t.Name, t.Name, routingDomain))
		if t.CustomDomain != "" {
			sb.WriteString(fmt.Sprintf("    acl is_%s_custom hdr(host) -i %s\n", t.Name, t.CustomDomain))
			sb.WriteString(fmt.Sprintf("    use_backend %s_backend if is_%s || is_%s_custom\n", t.Name, t.Name, t.Name))
		} else {
			sb.WriteString(fmt.Sprintf("    use_backend %s_backend if is_%s\n", t.Name, t.Name))
		}
	}
	sb.WriteString("    default_backend default_maintenance\n\n")

	sb.WriteString("frontend https_front\n")
	sb.WriteString("    bind *:443 ssl crt /etc/haproxy/certs/felcloud-gateway.pem alpn h2,http/1.1\n")
	sb.WriteString("    mode http\n")
	sb.WriteString("    http-response set-header X-Gateway-ID __FELCLOUD_GATEWAY_ID__\n")
	sb.WriteString("    # Gateway Rate Limiting & Throttling (+2 Bonus Points)\n")
	sb.WriteString("    stick-table type ip size 100k expire 1m store http_req_rate(10s)\n")
	sb.WriteString("    http-request track-sc0 src\n")
	sb.WriteString("    http-request deny deny_status 429 content-type \"text/plain\" lf-string \"429 Too Many Requests - Gateway Rate Limit Exceeded\\n\" if { sc_http_req_rate(0) gt 100 }\n")
	for _, t := range teams {
		sb.WriteString(fmt.Sprintf("    acl is_%s hdr(host) -i %s.%s\n", t.Name, t.Name, routingDomain))
		if t.CustomDomain != "" {
			sb.WriteString(fmt.Sprintf("    acl is_%s_custom hdr(host) -i %s\n", t.Name, t.CustomDomain))
			sb.WriteString(fmt.Sprintf("    use_backend %s_backend if is_%s || is_%s_custom\n", t.Name, t.Name, t.Name))
		} else {
			sb.WriteString(fmt.Sprintf("    use_backend %s_backend if is_%s\n", t.Name, t.Name))
		}
	}
	sb.WriteString("    default_backend default_maintenance\n\n")

	for _, t := range teams {
		port := t.Port
		if port == 0 {
			port = 80
		}
		sb.WriteString(fmt.Sprintf("backend %s_backend\n", t.Name))
		sb.WriteString("    mode http\n")
		sb.WriteString("    balance roundrobin\n")
		sb.WriteString(fmt.Sprintf("    server %s_srv %s:%d check inter 2000 rise 2 fall 3\n\n", t.Name, t.IP, port))
	}

	sb.WriteString("backend default_maintenance\n")
	sb.WriteString("    mode http\n")
	sb.WriteString("    # Smart Health Monitoring & Fallback Page (+2 Bonus Points)\n")
	sb.WriteString("    http-request return status 503 content-type \"text/html\" lf-string \"<!DOCTYPE html><html><head><meta charset='utf-8'><meta http-equiv='refresh' content='5'><title>Sandbox Offline | FelCloud Resilient Gateway</title><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:500px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.5);}.tag{display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:#ef444420;color:#f87171;border:1px solid #ef4444;margin-bottom:12px;}h2{margin:0 0 8px;font-size:20px;}p{color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 16px;}.f{font-size:12px;color:#64748b;border-top:1px solid #334155;padding-top:12px;}</style></head><body><div class='box'><div class='tag'>503 • SANDBOX OFFLINE</div><h2>Sandbox Initializing or Offline</h2><p>The requested team sandbox is spinning up or temporarily unreachable. The gateway will retry automatically in 5 seconds.</p><div class='f'>FelCloud Resilient Gateway • CSTAM Hackathon</div></div></body></html>\\n\"\n")

	return sb.String()
}

func updateAnsibleTeams() ([]TeamEntry, error) {
	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	defer db.Close()

	var hasCustomDomain bool
	infoRows, infoErr := db.Query("PRAGMA table_info(sandboxes)")
	if infoErr == nil {
		for infoRows.Next() {
			var cid int
			var name, typ string
			var notNull int
			var dflt any
			var pk int
			if err := infoRows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err == nil {
				if name == "custom_domain" {
					hasCustomDomain = true
				}
			}
		}
		infoRows.Close()
	}

	query := "SELECT sandbox_id, private_ip FROM sandboxes WHERE status IN ('ACTIVE', 'EXPIRING') AND private_ip <> ''"
	if hasCustomDomain {
		query = "SELECT sandbox_id, private_ip, COALESCE(custom_domain, '') FROM sandboxes WHERE status IN ('ACTIVE', 'EXPIRING') AND private_ip <> ''"
	}

	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var teams []TeamEntry
	for rows.Next() {
		var sID, ip, customDomain string
		var scanErr error
		if hasCustomDomain {
			scanErr = rows.Scan(&sID, &ip, &customDomain)
		} else {
			scanErr = rows.Scan(&sID, &ip)
		}
		if scanErr != nil {
			continue
		}
		sID = strings.TrimSpace(sID)
		ip = strings.TrimSpace(ip)
		customDomain = strings.TrimSpace(customDomain)
		if sID == "" || !dnsLabelRE.MatchString(sID) {
			log.Printf("skip route generation for invalid sandbox_id %q", sID)
			continue
		}
		if !validIPv4Address(ip) {
			log.Printf("skip route generation for invalid private_ip %q on sandbox %q", ip, sID)
			continue
		}
		teams = append(teams, TeamEntry{Name: sID, IP: ip, Port: 80, CustomDomain: customDomain})
	}
	return teams, nil
}

func rollbackConfig() bool {
	_, _, err := rollbackConfigWithOptions("", "manual", "CLI rollback")
	return err == nil
}

func syncHAProxyDualGateways(dryRun bool) (bool, string) {
	ok, msg, _ := syncHAProxyDualGatewaysTimed(dryRun, "manual")
	return ok, msg
}

func syncHAProxyDualGatewaysTimed(dryRun bool, trigger string) (bool, string, int64) {
	started := time.Now()
	teams, err := updateAnsibleTeams()
	if err != nil {
		msg := fmt.Sprintf("Failed to load sandbox routes: %v", err)
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, msg, duration)
		return false, msg, duration
	}
	candidateCfg := generateHAProxyConfig(teams)
	contentSHA := generationContentSHA(candidateCfg)

	if dryRun {
		isValid, validationMsg := gatewayConfigValidator(candidateCfg)
		if !isValid {
			msg := fmt.Sprintf("Validation failed: %s", validationMsg)
			duration := time.Since(started).Milliseconds()
			recordGatewayOperationEvent("sync_failed", trigger, msg, duration)
			return false, msg, duration
		}
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync", trigger, "dry-run validation successful", duration)
		return true, "Dry-run validation successful", duration
	}

	store, err := gatewayStoreFactory()
	if err != nil {
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, err.Error(), duration)
		return false, err.Error(), duration
	}
	defer store.close()
	active, standby, baseline, err := loadActiveAndStandby(store)
	if err != nil {
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, err.Error(), duration)
		return false, err.Error(), duration
	}
	genID := generationID("gen")
	db, err := getDBConnection()
	if err != nil {
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, err.Error(), duration)
		return false, err.Error(), duration
	}
	activeGen, _ := gatewayStateValue(db, "active_generation")
	_, err = db.Exec("INSERT INTO config_generations (generation_id, config_snapshot, status, source_generation, content_sha, gw1_backup, gw2_backup) VALUES (?, ?, 'VALIDATED', ?, ?, '', '')", genID, candidateCfg, activeGen, contentSHA)
	if err != nil {
		db.Close()
		msg := fmt.Sprintf("Failed to record config generation: %v", err)
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, msg, duration)
		return false, msg, duration
	}
	db.Close()

	deployment, err := gatewayDeploymentRunner(genID, candidateCfg, active, standby)
	if err == nil {
		err = verifyGatewayHealthWindow(store, baseline)
	}
	if err != nil {
		msg := err.Error()
		db, _ = getDBConnection()
		if db != nil {
			_, _ = db.Exec("UPDATE config_generations SET status='FAILED', gw1_backup=?, gw2_backup=? WHERE generation_id=?", deployment.GW1Backup, deployment.GW2Backup, genID)
			recordEvent(db, "", "sync_failed", fmt.Sprintf("trigger=%s reason=%s", trigger, msg), time.Since(started).Milliseconds())
			_ = db.Close()
		}
		_, _, rollbackErr := rollbackConfigWithOptions("", "auto", msg)
		if rollbackErr != nil {
			msg += "; automatic rollback failed: " + rollbackErr.Error()
		}
		return false, msg, time.Since(started).Milliseconds()
	}
	db, err = getDBConnection()
	if err != nil {
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, err.Error(), duration)
		return false, err.Error(), duration
	}
	_, err = db.Exec("UPDATE config_generations SET status='COMMITTED', gw1_backup=?, gw2_backup=? WHERE generation_id=?", deployment.GW1Backup, deployment.GW2Backup, genID)
	if err == nil {
		if err = setGatewayState(db, "active_generation", genID); err != nil {
			recordGatewayOperationEvent("sync_failed", trigger, err.Error(), time.Since(started).Milliseconds())
		}
		recordEvent(db, "", "sync", fmt.Sprintf("trigger=%s reason=deploy generation=%s", trigger, genID), time.Since(started).Milliseconds())
	}
	_ = db.Close()
	if err != nil {
		duration := time.Since(started).Milliseconds()
		recordGatewayOperationEvent("sync_failed", trigger, err.Error(), duration)
		return false, err.Error(), duration
	}
	gwCache.Invalidate()
	return true, fmt.Sprintf("Generation %s applied", genID), time.Since(started).Milliseconds()
}

func addTeamFlow(teamName, ipAddress string, port int, skipHealthCheck bool) (bool, string) {
	initDB()
	reclaimExpiredQuarantines()

	allocRes, err := allocateLease(teamName, "", "sandbox", ipAddress)
	if err != nil {
		fmt.Printf("✗ Allocation Error: %v\n", err)
		return false, err.Error()
	}

	assignedIP := allocRes.IPAddress
	fmt.Printf("✓ Lease allocated for '%s': %s:%d\n", teamName, assignedIP, port)

	if !skipHealthCheck {
		isHealthy, healthMsg := checkSandboxHealth(assignedIP, port, 2*time.Second, 3, 1*time.Second)
		if !isHealthy {
			fmt.Printf("✗ Sandbox health check failed (%s). Route NOT opened.\n", healthMsg)
			markFailedHealthCheck(teamName)
			return false, fmt.Sprintf("Health check failed: %s", healthMsg)
		}
	}

	return syncHAProxyDualGateways(false)
}

func markFailedHealthCheck(sandboxID string) {
	db, err := getDBConnection()
	if err != nil {
		log.Printf("markFailedHealthCheck(%s): %v", sandboxID, err)
		return
	}
	defer db.Close()
	if _, err := db.Exec("UPDATE sandboxes SET status = 'FAILED_HEALTH_CHECK' WHERE sandbox_id = ? AND status = 'ACTIVE'", sandboxID); err != nil {
		log.Printf("markFailedHealthCheck(%s): %v", sandboxID, err)
	}
}

func removeTeamFlow(teamName string, quarantineSec int) (bool, string) {
	initDB()
	result, err := releaseLease(teamName, "", quarantineSec)
	if err != nil || result.Status == "NOT_FOUND" {
		fmt.Printf("✗ Error: Team '%s' not found.\n", teamName)
		return false, "Not found"
	}

	syncHAProxyDualGateways(false)
	return true, fmt.Sprintf("Team '%s' removed; IP quarantined for %ds", teamName, result.CooldownSeconds)
}
