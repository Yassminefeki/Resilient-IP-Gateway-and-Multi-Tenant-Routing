package main

// dpa_client.go — HAProxy Data Plane API (DPA) v3 client
//
// Replaces the Ansible haproxy-transaction.yml playbook.
// For each gateway it:
//   1. Opens a DPA transaction  (POST /v3/services/haproxy/transactions)
//   2. Pushes the raw config    (PUT  /v3/services/haproxy/configuration/raw?transaction_id=…)
//   3. Commits the transaction  (PUT  /v3/services/haproxy/transactions/{id})
//
// Env vars (all optional — sane defaults for the felcloud lab):
//   DPA_PORT              (default: 5555)
//   DPA_USER              (default: admin)
//   DPA_PASS              DPA password — must be set in production
//   DPA_TIMEOUT_SECONDS   per-request timeout (default: 30)
//   DPA_SKIP_VERIFY       set "true" to skip TLS verification (http only in lab)

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// ── gateway address map ────────────────────────────────────────────────────────

// gatewayMgmtIP maps gateway names to their management-network IP addresses.
// Overridable via GW1_MGMT_IP / GW2_MGMT_IP environment variables.
var gatewayMgmtIP = map[string]string{
	"gw1": "10.20.10.24",
	"gw2": "10.20.10.164",
}

func resolveGatewayMgmtIP(host string) string {
	switch host {
	case "gw1":
		if v := strings.TrimSpace(os.Getenv("GW1_MGMT_IP")); v != "" {
			return v
		}
	case "gw2":
		if v := strings.TrimSpace(os.Getenv("GW2_MGMT_IP")); v != "" {
			return v
		}
	}
	if ip, ok := gatewayMgmtIP[host]; ok {
		return ip
	}
	return host
}

// ── DPA config accessors ───────────────────────────────────────────────────────

func dpaPort() int {
	if v := strings.TrimSpace(os.Getenv("DPA_PORT")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return 5555
}

func dpaCredentials() (user, pass string, err error) {
	user = envOr("DPA_USER", "admin")
	pass = strings.TrimSpace(os.Getenv("DPA_PASS"))
	if pass == "" {
		return "", "", errors.New("DPA_PASS environment variable is not set")
	}
	return user, pass, nil
}

func dpaTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("DPA_TIMEOUT_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 30 * time.Second
}

func dpaBaseURL(host string) string {
	ip := resolveGatewayMgmtIP(host)
	return fmt.Sprintf("http://%s:%d/v3", ip, dpaPort())
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

func dpaRequest(ctx context.Context, method, url string, body []byte, user, pass, contentType string) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.SetBasicAuth(user, pass)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: dpaTimeout()}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
}

// ── Transaction flow ───────────────────────────────────────────────────────────

type dpaTransaction struct {
	ID string `json:"id"`
}

// dpaOpenTransaction opens a new DPA transaction and returns its ID.
// dpaConfigVersion returns the integer HAProxy configuration version
// that DPA requires when opening a transaction.
func dpaConfigVersion(ctx context.Context, baseURL, user, pass string) (string, error) {
	body, status, err := dpaRequest(ctx, http.MethodGet, baseURL+"/services/haproxy/configuration/version", nil, user, pass, "")
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("DPA configuration version: HTTP %d: %s", status, truncate(string(body), 200))
	}
	v := strings.TrimSpace(string(body))
	if n, convErr := strconv.Atoi(v); convErr != nil || n < 0 {
		return "", fmt.Errorf("DPA configuration version: unexpected response %q", truncate(v, 80))
	}
	return v, nil
}

// dpaOpenTransaction opens a new DPA transaction and returns its ID.
func dpaOpenTransaction(ctx context.Context, baseURL, user, pass string) (string, error) {
	// DPA requires the integer configuration version (not the HAProxy
	// software version) as the "version" query parameter.
	version, err := dpaConfigVersion(ctx, baseURL, user, pass)
	if err != nil {
		return "", fmt.Errorf("open transaction: %w", err)
	}
	url := baseURL + "/services/haproxy/transactions?version=" + version

	body, status, err := dpaRequest(ctx, http.MethodPost, url, nil, user, pass, "")
	if err != nil {
		return "", fmt.Errorf("open transaction: %w", err)
	}
	if status != http.StatusCreated && status != http.StatusOK {
		return "", fmt.Errorf("open transaction: HTTP %d: %s", status, truncate(string(body), 200))
	}
	var tx dpaTransaction
	if err := json.Unmarshal(body, &tx); err != nil || tx.ID == "" {
		return "", fmt.Errorf("open transaction: could not parse transaction ID from response: %s", truncate(string(body), 200))
	}
	return tx.ID, nil
}

// dpaHAProxyVersion fetches the running HAProxy version string from DPA /info.
func dpaHAProxyVersion(ctx context.Context, baseURL, user, pass string) (string, error) {
	body, status, err := dpaRequest(ctx, http.MethodGet, baseURL+"/info", nil, user, pass, "")
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("DPA /info: HTTP %d", status)
	}
	var info struct {
		HaproxyInfo struct {
			Version string `json:"version"`
		} `json:"haproxy_info"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return "", err
	}
	return info.HaproxyInfo.Version, nil
}

// dpaPushRawConfig uploads the raw haproxy.cfg content within a transaction.
func dpaPushRawConfig(ctx context.Context, baseURL, txID, cfgContent, user, pass string) error {
	url := fmt.Sprintf("%s/services/haproxy/configuration/raw?transaction_id=%s", baseURL, txID)
	body, status, err := dpaRequest(ctx, http.MethodPut, url, []byte(cfgContent), user, pass, "text/plain")
	if err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	// DPA returns 202 Accepted or 200 OK for raw config push
	if status != http.StatusOK && status != http.StatusAccepted {
		return fmt.Errorf("push config: HTTP %d: %s", status, truncate(string(body), 300))
	}
	return nil
}

// dpaCommitTransaction commits (applies) a transaction on the gateway.
func dpaCommitTransaction(ctx context.Context, baseURL, txID, user, pass string) error {
	url := fmt.Sprintf("%s/services/haproxy/transactions/%s", baseURL, txID)
	body, status, err := dpaRequest(ctx, http.MethodPut, url, nil, user, pass, "")
	if err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	if status != http.StatusOK && status != http.StatusAccepted {
		return fmt.Errorf("commit transaction: HTTP %d: %s", status, truncate(string(body), 300))
	}
	return nil
}

// dpaDeleteTransaction deletes (aborts) a transaction — called on error cleanup.
func dpaDeleteTransaction(ctx context.Context, baseURL, txID, user, pass string) {
	url := fmt.Sprintf("%s/services/haproxy/transactions/%s", baseURL, txID)
	_, _, _ = dpaRequest(ctx, http.MethodDelete, url, nil, user, pass, "")
}

// ── Per-gateway push ───────────────────────────────────────────────────────────

// dpaPostRawConfig sends a full haproxy.cfg to DPA's raw endpoint.
// With onlyValidate=true DPA checks the config without applying it.
func dpaPostRawConfig(ctx context.Context, baseURL, cfgContent, user, pass string, onlyValidate bool) (int, error) {
	version, err := dpaConfigVersion(ctx, baseURL, user, pass)
	if err != nil {
		return 0, err
	}
	url := baseURL + "/services/haproxy/configuration/raw?version=" + version
	if onlyValidate {
		url += "&only_validate=true"
	}
	body, status, err := dpaRequest(ctx, http.MethodPost, url, []byte(cfgContent), user, pass, "text/plain")
	if err != nil {
		return 0, err
	}
	if status < 200 || status > 299 {
		return status, fmt.Errorf("raw config: HTTP %d: %s", status, truncate(string(body), 300))
	}
	return status, nil
}

// dpaPushConfigToGateway validates, then applies, a complete haproxy.cfg.
// A version conflict (409) is retried once with a fresh version.
func dpaPushConfigToGateway(host, cfgContent string) error {
	user, pass, err := dpaCredentials()
	if err != nil {
		return err
	}
	base := dpaBaseURL(host)
	ctx, cancel := context.WithTimeout(context.Background(), dpaTimeout()*3)
	defer cancel()

	if _, err := dpaPostRawConfig(ctx, base, cfgContent, user, pass, true); err != nil {
		return fmt.Errorf("gateway %s: validate: %w", host, err)
	}
	status, err := dpaPostRawConfig(ctx, base, cfgContent, user, pass, false)
	if status == http.StatusConflict {
		_, err = dpaPostRawConfig(ctx, base, cfgContent, user, pass, false)
	}
	if err != nil {
		return fmt.Errorf("gateway %s: apply: %w", host, err)
	}
	return nil
}

// ── Transactional dual-gateway deploy via DPA ──────────────────────────────────

// dpaDeployResult holds per-gateway timing info for a DPA deploy.
type dpaDeployResult struct {
	Generation string
	DurationMS int64
	GW1Backup  string
	GW2Backup  string
	DetectMS   int64
	RestoreMS  int64
}

// runDPAGatewayDeploy pushes config to standby first, then active, using
// the HAProxy Data Plane API.  It mirrors the contract of
// runTransactionalGatewayDeploy so it can be plugged into gatewayDeploymentRunner.
func runDPAGatewayDeploy(genID, snapshot, active, standby string) (gatewayDeployment, error) {
	if active == "" || standby == "" || active == standby || !allowedGateways[active] || !allowedGateways[standby] {
		return gatewayDeployment{}, errors.New("could not determine distinct active and standby gateways")
	}
	started := time.Now()

	// Push to standby first (safer — it is not serving VIP traffic).
	standbyCfg := gatewayConfigForHost(snapshot, standby)
	if err := dpaPushConfigToGateway(standby, standbyCfg); err != nil {
		return gatewayDeployment{Generation: genID, DurationMS: time.Since(started).Milliseconds()},
			fmt.Errorf("DPA deploy standby %s failed: %w", standby, err)
	}

	// Push to active gateway.
	activeCfg := gatewayConfigForHost(snapshot, active)
	if err := dpaPushConfigToGateway(active, activeCfg); err != nil {
		return gatewayDeployment{Generation: genID, DurationMS: time.Since(started).Milliseconds()},
			fmt.Errorf("DPA deploy active %s failed: %w", active, err)
	}

	backupPath := "/etc/haproxy/backups/haproxy.cfg." + genID
	return gatewayDeployment{
		Generation: genID,
		DurationMS: time.Since(started).Milliseconds(),
		GW1Backup:  backupPath,
		GW2Backup:  backupPath,
	}, nil
}

// ── DPA health probe ───────────────────────────────────────────────────────────

// DPAGatewayInfo contains the status information returned by DPA /info.
type DPAGatewayInfo struct {
	Host    string `json:"host"`
	Version string `json:"version"`
	Uptime  string `json:"uptime"`
	Ready   bool   `json:"ready"`
	Error   string `json:"error,omitempty"`
}

// ProbeDPAGateway queries the DPA /info endpoint on one gateway and returns
// its version and readiness. Used by /api/gateways/status enrichment.
func ProbeDPAGateway(host string) DPAGatewayInfo {
	user, pass, err := dpaCredentials()
	if err != nil {
		return DPAGatewayInfo{Host: host, Error: err.Error()}
	}
	base := dpaBaseURL(host)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	body, status, err := dpaRequest(ctx, http.MethodGet, base+"/info", nil, user, pass, "")
	if err != nil {
		return DPAGatewayInfo{Host: host, Error: err.Error()}
	}
	if status != http.StatusOK {
		return DPAGatewayInfo{Host: host, Error: fmt.Sprintf("HTTP %d", status)}
	}
	var info struct {
		HaproxyInfo struct {
			Version string `json:"version"`
			Uptime  string `json:"uptime_sec"`
		} `json:"haproxy_info"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return DPAGatewayInfo{Host: host, Error: "parse error: " + err.Error()}
	}
	return DPAGatewayInfo{
		Host:    host,
		Version: info.HaproxyInfo.Version,
		Uptime:  info.HaproxyInfo.Uptime,
		Ready:   true,
	}
}
