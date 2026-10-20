package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Probe result types ─────────────────────────────────────────────────────────

// GWProbe is the live state of one gateway.
type GWProbe struct {
	Reachable  bool   `json:"reachable"`
	HAProxy    string `json:"haproxy"`    // "UP" | "DOWN" | "UNKNOWN"
	Keepalived string `json:"keepalived"` // MASTER | BACKUP | FAULT | UNKNOWN
	VIPHolder  bool   `json:"vip_holder_local"`
	ProbedAt   string `json:"probed_at"`
	Error      string `json:"error,omitempty"`
}

// ProbeResult is the full cached snapshot.
type ProbeResult struct {
	Gateways      map[string]GWProbe `json:"gateways"`
	VIPHolder     string             `json:"vip_holder"` // "gw1" | "gw2" | "unknown"
	LatestGenID   string             `json:"latest_generation"`
	FetchedAtUnix int64              `json:"fetched_at_ms"`
}

// ── Singleflight + cache ───────────────────────────────────────────────────────

// probeCache holds the last result with a TTL.
// Singleflight is implemented inline: inflight != nil means a probe is running;
// all concurrent callers wait on the same channel instead of spawning new runs.
type probeCache struct {
	mu       sync.Mutex
	result   *ProbeResult
	expiry   time.Time
	ttl      time.Duration
	inflight chan struct{} // non-nil while a probe is running
}

// gwCache is the package-level singleton; TTL 3 s (inclusive of failed probes).
var gwCache = &probeCache{ttl: 3 * time.Second}

// Get returns the cached probe result, refreshing it when the TTL has expired.
// Concurrent callers share one in-flight probe — no pile-up.
func (c *probeCache) Get(store *gatewayStore) ProbeResult {
	c.mu.Lock()

	// Cache hit (including negative / failed probes)
	if c.result != nil && time.Now().Before(c.expiry) {
		r := *c.result
		c.mu.Unlock()
		return r
	}

	// Another goroutine is already fetching — join it
	if c.inflight != nil {
		ch := c.inflight
		c.mu.Unlock()
		<-ch // wait for the in-flight probe to finish
		// Result is now in cache
		c.mu.Lock()
		r := *c.result
		c.mu.Unlock()
		return r
	}

	// We are the leader — set up the singleflight channel
	ch := make(chan struct{})
	c.inflight = ch
	c.mu.Unlock()

	r := runGatewayProbes(store) // ← runs in this goroutine, takes ≤ 2 s

	c.mu.Lock()
	c.result = &r
	c.expiry = time.Now().Add(c.ttl) // cache failures too
	c.inflight = nil
	close(ch) // wake all waiters
	c.mu.Unlock()

	return r
}

// Invalidate forces a fresh probe on the next request.
func (c *probeCache) Invalidate() {
	c.mu.Lock()
	c.expiry = time.Time{}
	c.mu.Unlock()
}

// ── Probe orchestration ────────────────────────────────────────────────────────

var gatewayHosts = []string{"gw1", "gw2"}

func runGatewayProbes(store *gatewayStore) ProbeResult {
	vip := envOr("VIP_ADDRESS", "10.20.20.246")
	if vip == "" || net.ParseIP(vip) == nil {
		vip = "10.20.20.246"
	}
	inv := resolveRepoFilePath("ANSIBLE_INVENTORY", "ansible/inventory/hosts.yml")
	bastion := envOr("BASTION_IP", "197.5.133.77")
	vault := resolveRepoFilePath("ANSIBLE_VAULT_PASS", "ansible/.vault_pass")

	type namedResult struct {
		host  string
		probe GWProbe
	}
	ch := make(chan namedResult, len(gatewayHosts))
	for _, h := range gatewayHosts {
		go func(host string) {
			ch <- namedResult{host: host, probe: probeOneGateway(host, inv, bastion, vault, vip)}
		}(h)
	}

	gateways := make(map[string]GWProbe, len(gatewayHosts))
	for range gatewayHosts {
		nr := <-ch
		gateways[nr.host] = nr.probe
	}

	vipHolder := "unknown"
	for name, p := range gateways {
		if p.VIPHolder {
			vipHolder = name
			break
		}
	}

	latestGen := "none"
	if store != nil {
		var g string
		if err := store.db.QueryRow(
			`SELECT generation_id FROM config_generations WHERE status='COMMITTED' ORDER BY id DESC LIMIT 1`,
		).Scan(&g); err == nil {
			latestGen = g
		}
	}

	return ProbeResult{
		Gateways:      gateways,
		VIPHolder:     vipHolder,
		LatestGenID:   latestGen,
		FetchedAtUnix: time.Now().UTC().UnixMilli(),
	}
}

func gatewayProbeTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("GATEWAY_PROBE_TIMEOUT_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 8 * time.Second
}

func probeOneGateway(host, inv, bastion, vault, vip string) GWProbe {
	// Wrap probe in configurable context timeout (default 8s for live jump host).
	script := fmt.Sprintf(
		"echo haproxy=$(systemctl is-active haproxy 2>/dev/null || echo inactive);"+
			"echo keepalived=$(cat /run/keepalived/state 2>/dev/null | tr -d '[:space:]' || echo UNKNOWN);"+
			"echo vip=$(ip addr show 2>/dev/null | grep -c %q || echo 0)",
		vip,
	)

	timeout := gatewayProbeTimeout()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	args := []string{
		"-i", inv,
		host,
		"-m", "shell",
		"-a", script,
		"-b",
		"--vault-password-file", vault,
		"-e", fmt.Sprintf(
			"ansible_ssh_common_args='-o ProxyJump=ansible@%s -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -o IPQoS=none'",
			bastion,
		),
	}

	cmd := exec.CommandContext(ctx, "ansible", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out

	now := time.Now().UTC().Format(time.RFC3339)
	if err := cmd.Run(); err != nil {
		reason := "unreachable"
		if ctx.Err() == context.DeadlineExceeded {
			reason = fmt.Sprintf("probe timeout (%s)", timeout)
		}
		return GWProbe{
			Reachable:  false,
			HAProxy:    "UNKNOWN",
			Keepalived: "UNKNOWN",
			ProbedAt:   now,
			Error:      reason,
		}
	}
	p := parseProbeOutput(out.String())
	p.ProbedAt = now
	return p
}

// parseProbeOutput turns "haproxy=active\nkeepalived=MASTER\nvip=1" into a GWProbe.
func parseProbeOutput(raw string) GWProbe {
	p := GWProbe{
		Reachable:  true,
		HAProxy:    "UNKNOWN",
		Keepalived: "UNKNOWN",
	}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if val, ok := cutPrefix(line, "haproxy="); ok {
			if strings.TrimSpace(val) == "active" {
				p.HAProxy = "UP"
			} else {
				p.HAProxy = "DOWN"
			}
		}
		if val, ok := cutPrefix(line, "keepalived="); ok {
			s := strings.ToUpper(strings.TrimSpace(val))
			switch s {
			case "MASTER", "BACKUP", "FAULT":
				p.Keepalived = s
			default:
				p.Keepalived = "UNKNOWN"
			}
		}
		if val, ok := cutPrefix(line, "vip="); ok {
			p.VIPHolder = strings.TrimSpace(val) != "0" && strings.TrimSpace(val) != ""
		}
	}
	return p
}

// ── Ansible log tail ──────────────────────────────────────────────────────────

const logFetchTimeout = 10 * time.Second

var gatewayLogSinceRE = regexp.MustCompile(`^[0-9A-Za-z:.+ -]{1,40}$`)

func shellQuoteSingle(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

// FetchGatewayLogs runs journalctl/tail on the target gateway via Ansible.
// gateway and source are already whitelist-validated by the caller.
func FetchGatewayLogs(gateway, source, since string, limit int) ([]string, error) {
	if since != "" && !gatewayLogSinceRE.MatchString(since) {
		return nil, fmt.Errorf("invalid since value")
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}

	var shellCmd string
	sinceArg := ""
	if since != "" {
		sinceArg = " --since " + shellQuoteSingle(since)
	}
	switch source {
	case "keepalived":
		shellCmd = fmt.Sprintf("journalctl -u keepalived --no-pager%s -n %d 2>/dev/null; echo '---events---'; tail -n %d /var/log/keepalived-events.log 2>/dev/null || true", sinceArg, limit, limit)
	default: // haproxy
		shellCmd = fmt.Sprintf("journalctl -u haproxy --no-pager%s -n %d 2>/dev/null || tail -n %d /var/log/haproxy.log 2>/dev/null || echo 'no haproxy log'", sinceArg, limit, limit)
	}

	inv := resolveRepoFilePath("ANSIBLE_INVENTORY", "ansible/inventory/hosts.yml")
	bastion := envOr("BASTION_IP", "197.5.133.77")
	vault := resolveRepoFilePath("ANSIBLE_VAULT_PASS", "ansible/.vault_pass")

	ctx, cancel := context.WithTimeout(context.Background(), logFetchTimeout)
	defer cancel()

	args := []string{
		"-i", inv,
		gateway,
		"-m", "shell",
		"-a", shellCmd,
		"-b",
		"--vault-password-file", vault,
		"-e", fmt.Sprintf(
			"ansible_ssh_common_args='-o ProxyJump=ansible@%s -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -o IPQoS=none'",
			bastion,
		),
	}

	ac := exec.CommandContext(ctx, "ansible", args...)
	var out bytes.Buffer
	ac.Stdout = &out
	ac.Stderr = &out

	if err := ac.Run(); err != nil {
		reason := truncate(out.String(), 200)
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("gateway %s: log fetch timed out after %s", gateway, logFetchTimeout)
		}
		return nil, fmt.Errorf("gateway %s: %s", gateway, reason)
	}

	var lines []string
	for _, l := range strings.Split(out.String(), "\n") {
		l = strings.TrimRight(l, "\r")
		if l != "" {
			lines = append(lines, l)
		}
	}
	return lines, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func resolveRepoFilePath(envKey, relPath string) string {
	if val := strings.TrimSpace(os.Getenv(envKey)); val != "" {
		if _, err := os.Stat(val); err == nil {
			return val
		}
	}
	candidates := []string{
		relPath,
		filepath.Join("..", relPath),
		filepath.Join(".", relPath),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return relPath
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// cutPrefix is strings.CutPrefix for Go < 1.20 compat.
func cutPrefix(s, prefix string) (string, bool) {
	if strings.HasPrefix(s, prefix) {
		return s[len(prefix):], true
	}
	return "", false
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
