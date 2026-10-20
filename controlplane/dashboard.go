package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	mockGatewaysMu sync.RWMutex
	mockVIPHolder  = "gw1"
)

// isMockGateways returns true if mock gateways mode is active.
// Strictly honoured ONLY when PROVISIONER=mock.
func isMockGateways() bool {
	return os.Getenv("PROVISIONER") == "mock" && os.Getenv("MOCK_GATEWAYS") == "true"
}

func getMockVIPHolder() string {
	mockGatewaysMu.RLock()
	defer mockGatewaysMu.RUnlock()
	if mockVIPHolder == "" {
		return "gw1"
	}
	return mockVIPHolder
}

func flipMockVIPHolder(target string) (string, string) {
	mockGatewaysMu.Lock()
	defer mockGatewaysMu.Unlock()
	oldHolder := mockVIPHolder
	if oldHolder == "" {
		oldHolder = "gw1"
	}
	newHolder := "gw2"
	if target == "gw1" || target == "gw2" {
		newHolder = target
	} else if oldHolder == "gw2" {
		newHolder = "gw1"
	}
	mockVIPHolder = newHolder
	return oldHolder, newHolder
}

// resetMockVIPHolder is used in tests to restore deterministic state.
func resetMockVIPHolder(holder string) {
	mockGatewaysMu.Lock()
	defer mockGatewaysMu.Unlock()
	mockVIPHolder = holder
}

func handleConfigAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	provType := "openstack"
	if os.Getenv("PROVISIONER") == "mock" {
		provType = "mock"
	}
	domain := routingDomain
	if domain == "" {
		domain = "cstam.felcloud.tn"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"routing_domain": domain,
		"vip_address":    envOr("VIP_ADDRESS", "10.20.20.246"),
		"version":        "1.0.0",
		"provisioner":    provType,
	})
}

// setupUIHandler configures static dashboard serving and SPA fallback under /ui/.
func setupUIHandler(mux *http.ServeMux) {
	uiHandler := logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		dashboardDir := os.Getenv("DASHBOARD_DIR")
		if dashboardDir == "" {
			errJSON(w, http.StatusNotFound, "dashboard not found (DASHBOARD_DIR unset)", r.URL.Path)
			return
		}

		// Exact /ui redirect to /ui/
		if r.URL.Path == "/ui" {
			http.Redirect(w, r, "/ui/", http.StatusMovedPermanently)
			return
		}

		// Security headers
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		// Path traversal protection: raw or URL-decoded path containing ..
		if strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.RawPath, "..") {
			http.NotFound(w, r)
			return
		}

		relPath := strings.TrimPrefix(r.URL.Path, "/ui/")
		relPath = strings.TrimPrefix(relPath, "/")
		cleanRel := filepath.Clean(relPath)
		if strings.HasPrefix(cleanRel, "..") || cleanRel == ".." {
			http.NotFound(w, r)
			return
		}

		absBase, errBase := filepath.Abs(dashboardDir)
		targetFile := filepath.Join(absBase, cleanRel)
		absTarget, errTarget := filepath.Abs(targetFile)

		if errBase != nil || errTarget != nil || (!strings.HasPrefix(absTarget, absBase+string(filepath.Separator)) && absTarget != absBase) {
			http.NotFound(w, r)
			return
		}

		// If a concrete file exists, serve it
		if info, err := os.Stat(targetFile); err == nil && !info.IsDir() {
			http.ServeFile(w, r, targetFile)
			return
		}

		// SPA fallback: serve index.html for all client-side routed paths
		indexPath := filepath.Join(absBase, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			http.ServeFile(w, r, indexPath)
			return
		}

		http.NotFound(w, r)
	})

	mux.HandleFunc("/ui", uiHandler)
	mux.HandleFunc("/ui/", uiHandler)
}

func getMockGatewayStatus() map[string]any {
	holder := getMockVIPHolder()
	gw1State := "MASTER"
	gw2State := "BACKUP"
	gw1Holder := true
	gw2Holder := false
	if holder == "gw2" {
		gw1State = "BACKUP"
		gw2State = "MASTER"
		gw1Holder = false
		gw2Holder = true
	}
	nowStr := time.Now().UTC().Format(time.RFC3339)
	vip := envOr("VIP_ADDRESS", "10.20.20.246")

	return map[string]any{
		"gateways": map[string]any{
			"gw1": map[string]any{
				"reachable":        true,
				"haproxy":          "UP",
				"keepalived":       gw1State,
				"vip_holder_local": gw1Holder,
				"probed_at":        nowStr,
				"error":            "",
			},
			"gw2": map[string]any{
				"reachable":        true,
				"haproxy":          "UP",
				"keepalived":       gw2State,
				"vip_holder_local": gw2Holder,
				"probed_at":        nowStr,
				"error":            "",
			},
		},
		"vip":               vip,
		"vip_holder":        holder,
		"latest_generation": "gen-0042",
		"fetched_at_ms":     time.Now().UTC().UnixMilli(),
	}
}

func handleMockFailover(w http.ResponseWriter, targetGateway, mode string) {
	time.Sleep(800 * time.Millisecond)
	oldHolder, newHolder := flipMockVIPHolder(targetGateway)
	gwCache.Invalidate()

	db, err := getDBConnection()
	if err == nil {
		recordEvent(db, "cluster", "failover", fmt.Sprintf("mock failover: %s -> %s", oldHolder, newHolder), 800)
		_ = db.Close()
	}

	writeJSON(w, http.StatusOK, failoverResponse{
		Success:              true,
		Before:               oldHolder,
		After:                newHolder,
		DowntimeMS:           15,
		FailoverMS:           800,
		FailedRequests:       0,
		TotalRequests:        120,
		ServingGatewayBefore: oldHolder,
		ServingGatewayAfter:  newHolder,
		VerifiedBy:           "mock_check",
		Mode:                 mode,
	})
}

func generateMockGatewayLogs(gateway, source string, limit int) []string {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	now := time.Now().UTC()
	var lines []string

	if source == "keepalived" {
		entries := []string{
			fmt.Sprintf("%s %s Keepalived_vrrp[1042]: (VI_EDGE) VRRP group status initialized", now.Add(-60*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_vrrp[1042]: (VI_EDGE) Received advertisement from peer priority=100", now.Add(-50*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_vrrp[1042]: (VI_EDGE) VRRP instance operational state normal", now.Add(-40*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_healthcheck[1041]: Activating healthchecker for HAProxy frontend on 127.0.0.1:80", now.Add(-30*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_vrrp[1042]: (VI_EDGE) IP address 10.20.20.246 advertised with gratuitous ARP", now.Add(-20*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_healthcheck[1041]: Healthcheck passed: HTTP 200 OK from haproxy health socket", now.Add(-10*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s Keepalived_vrrp[1042]: (VI_EDGE) Sending regular 1s VRRP heartbeat packet", now.Format(time.RFC3339), gateway),
		}
		lines = append(lines, entries...)
	} else {
		// haproxy access logs with normal 200/302 and sample 5xx lines
		entries := []string{
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43210 [14/Oct/2026:14:40:01.100] http_front team-alpha_backend/team-alpha_srv 0/0/1/2/3 200 1042 - - ---- 14/14/1/1/0 0/0 \"GET / HTTP/1.1\"", now.Add(-45*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43212 [14/Oct/2026:14:40:05.210] http_front team-alpha_backend/team-alpha_srv 0/0/1/1/2 200 512 - - ---- 12/12/1/1/0 0/0 \"GET /assets/app.js HTTP/1.1\"", now.Add(-40*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43215 [14/Oct/2026:14:40:12.330] http_front team-beta_backend/team-beta_srv 0/0/1/1/2 302 420 - - ---- 10/10/1/1/0 0/0 \"GET /login HTTP/1.1\"", now.Add(-35*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43220 [14/Oct/2026:14:40:18.512] http_front team-gamma_backend/team-gamma_srv 0/0/500/-1/500 502 312 - - sH-- 6/6/0/0/0 0/0 \"GET /api/v1/sandbox HTTP/1.1\"", now.Add(-30*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43224 [14/Oct/2026:14:40:22.650] http_front team-alpha_backend/team-alpha_srv 0/0/2/3/5 200 8192 - - ---- 9/9/1/1/0 0/0 \"GET /api/status HTTP/1.1\"", now.Add(-25*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43230 [14/Oct/2026:14:40:29.890] http_front team-delta_backend/team-delta_srv 0/0/1000/-1/1000 504 280 - - sT-- 4/4/0/0/0 0/0 \"POST /compute/heavy HTTP/1.1\"", now.Add(-20*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43235 [14/Oct/2026:14:40:35.120] http_front team-beta_backend/team-beta_srv 0/0/1/2/3 200 2400 - - ---- 8/8/1/1/0 0/0 \"GET /dashboard HTTP/1.1\"", now.Add(-15*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43240 [14/Oct/2026:14:40:42.410] http_front team-alpha_backend/team-alpha_srv 0/0/1/1/2 200 1200 - - ---- 7/7/1/1/0 0/0 \"GET /health HTTP/1.1\"", now.Add(-10*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43245 [14/Oct/2026:14:40:48.880] http_front team-gamma_backend/team-gamma_srv 0/0/250/-1/250 503 210 - - SC-- 3/3/0/0/0 0/0 \"GET /live HTTP/1.1\"", now.Add(-5*time.Second).Format(time.RFC3339), gateway),
			fmt.Sprintf("%s %s haproxy[2048]: 197.5.133.77:43250 [14/Oct/2026:14:40:55.990] http_front team-beta_backend/team-beta_srv 0/0/1/1/2 200 1450 - - ---- 5/5/1/1/0 0/0 \"GET /metrics HTTP/1.1\"", now.Format(time.RFC3339), gateway),
		}
		lines = append(lines, entries...)
	}

	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines
}
