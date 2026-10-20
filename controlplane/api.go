package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

func sendJSON(w http.ResponseWriter, code int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(data)
}

// setupAPIRoutes is kept as a compatibility shim for older entry points.
// The canonical server implementation is gatewayHandler() from server.go.
func setupAPIRoutes() http.Handler {
	store, err := newGatewayStore()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, fmt.Sprintf("database unavailable: %v", err), http.StatusServiceUnavailable)
		})
	}
	return gatewayHandler(store)
}

func handleAllocate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	var params struct {
		SandboxID  string `json:"sandbox_id"`
		Name       string `json:"name"`
		Hostname   string `json:"hostname"`
		IPAddress  string `json:"ip_address"`
		IP         string `json:"ip"`
		TTLSeconds *int64 `json:"ttl_seconds"`
		TTL        *int64 `json:"ttl"`
	}
	if err := decodeStrictJSON(w, r, &params); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}

	sandboxID := params.SandboxID
	if sandboxID == "" {
		sandboxID = params.Name
	}
	hostname := params.Hostname
	preferredIP := params.IPAddress
	if preferredIP == "" {
		preferredIP = params.IP
	}

	if sandboxID == "" || !dnsLabelRE.MatchString(sandboxID) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "sandbox_id/name must be a lowercase DNS label of 1-63 characters"})
		return
	}
	if preferredIP != "" && !validIPv4Address(preferredIP) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "ip_address must be a literal IPv4 address"})
		return
	}

	var ttlSec int64
	if params.TTLSeconds != nil {
		ttlSec = *params.TTLSeconds
	} else if params.TTL != nil {
		ttlSec = *params.TTL
	}

	res, err := allocateLeaseTTL(sandboxID, hostname, "sandbox", preferredIP, ttlSec)
	if err != nil {
		if strings.Contains(err.Error(), "exceeds maximum allowed") {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}

	sendJSON(w, http.StatusCreated, res)
}

type extendRequest struct {
	SandboxID     string `json:"sandbox_id"`
	ExtendSeconds int64  `json:"extend_seconds"`
}

func handleExtendSandbox(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	var req extendRequest
	if err := decodeStrictJSON(w, r, &req); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}

	if !dnsLabelRE.MatchString(req.SandboxID) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid sandbox_id format"})
		return
	}

	if req.ExtendSeconds < minExtendSeconds {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("extend_seconds must be at least %d", minExtendSeconds)})
		return
	}

	db, err := getDBConnection()
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Database error"})
		return
	}
	defer db.Close()

	newExp, err := extendSandbox(db, req.SandboxID, req.ExtendSeconds)
	if err != nil {
		if errors.Is(err, ErrSandboxNotFound) {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Sandbox '%s' not found", req.SandboxID)})
			return
		}
		if errors.Is(err, ErrWrongState) || errors.Is(err, ErrTransitionConflict) {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "Sandbox status is not ACTIVE or expires_at is null"})
			return
		}
		if errors.Is(err, ErrInvalidExtend) {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if errors.Is(err, ErrTTLCapExceeded) {
			sendJSON(w, 422, map[string]string{"error": "Requested extension exceeds maximum TTL cap"})
			return
		}
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to extend sandbox"})
		return
	}

	now := nowUnix()
	rem := newExp - now
	if rem < 0 {
		rem = 0
	}

	sendJSON(w, http.StatusOK, map[string]interface{}{
		"success":               true,
		"sandbox_id":            req.SandboxID,
		"expires_at":            newExp,
		"ttl_remaining_seconds": rem,
	})
}

func handleRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	var params struct {
		SandboxID         string `json:"sandbox_id"`
		Name              string `json:"name"`
		IPAddress         string `json:"ip_address"`
		IP                string `json:"ip"`
		CooldownSeconds   *int   `json:"cooldown_seconds"`
		QuarantineSeconds *int   `json:"quarantine_seconds"`
	}
	if err := decodeStrictJSON(w, r, &params); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}

	sandboxID := params.SandboxID
	if sandboxID == "" {
		sandboxID = params.Name
	}
	ipAddress := params.IPAddress
	if ipAddress == "" {
		ipAddress = params.IP
	}

	cooldown := 0
	if params.CooldownSeconds != nil {
		cooldown = *params.CooldownSeconds
	} else if params.QuarantineSeconds != nil {
		cooldown = *params.QuarantineSeconds
	}

	if sandboxID == "" && ipAddress == "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing sandbox_id or ip_address"})
		return
	}
	if sandboxID != "" && !dnsLabelRE.MatchString(sandboxID) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "sandbox_id must be a lowercase DNS label"})
		return
	}
	if ipAddress != "" && !validIPv4Address(ipAddress) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "ip_address must be a literal IPv4 address"})
		return
	}

	res, err := releaseLease(sandboxID, ipAddress, cooldown)
	if err != nil {
		code := http.StatusConflict
		if errors.Is(err, ErrSandboxNotFound) {
			code = http.StatusNotFound
		}
		sendJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, res)
}

func handleReclaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	var request struct{}
	if err := decodeStrictJSON(w, r, &request); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}
	count := reclaimExpiredQuarantines()
	sendJSON(w, http.StatusOK, map[string]int{"reclaimed_count": count})
}

func handleProvision(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		provisionError(w, http.StatusMethodNotAllowed, "", "method", errors.New("method not allowed"))
		return
	}
	var req CreateReq
	if err := decodeStrictJSON(w, r, &req); err != nil {
		provisionError(w, http.StatusBadRequest, "", "decode", errors.New("invalid request payload"))
		return
	}
	if req.Team == "" {
		req.Team = req.SandboxID
	}
	if req.Team == "" || !dnsLabelRE.MatchString(req.Team) {
		provisionError(w, http.StatusBadRequest, req.Team, "validate", errors.New("team must be a lowercase DNS label of 1-63 characters"))
		return
	}
	if provisioner == nil {
		provisionError(w, http.StatusBadGateway, req.Team, "config", errors.New("provisioner is not configured"))
		return
	}
	if provisionSemaphore != nil {
		select {
		case provisionSemaphore <- struct{}{}:
			defer func() { <-provisionSemaphore }()
		case <-r.Context().Done():
			provisionError(w, http.StatusGatewayTimeout, req.Team, "admission", r.Context().Err())
			return
		}
	}
	provisionSandbox(w, r, req)
}

func handleGatewaySync(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	if err := tryGatewayOp("sync-manual"); err != nil {
		sendJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "duration_ms": int64(0)})
		return
	}
	defer releaseGatewayOp("sync-manual")
	var params struct {
		DryRun bool `json:"dry_run"`
	}
	if err := decodeStrictJSON(w, r, &params); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}
	dryRun := params.DryRun
	success, msg, duration := syncHAProxyDualGatewaysTimed(dryRun, "manual")
	code := http.StatusOK
	if !success {
		code = http.StatusBadGateway
	}
	sendJSON(w, code, map[string]interface{}{"success": success, "message": msg, "duration_ms": duration})
}

func handleGatewayRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	if err := tryGatewayOp("rollback-manual"); err != nil {
		sendJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "duration_ms": int64(0)})
		return
	}
	defer releaseGatewayOp("rollback-manual")
	var body struct {
		TargetGeneration string `json:"target_generation"`
	}
	if err := decodeStrictJSON(w, r, &body); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}
	generation, duration, err := rollbackConfigWithOptions(body.TargetGeneration, "manual", "operator request")
	code := http.StatusOK
	if err != nil {
		code = http.StatusBadGateway
	}
	sendJSON(w, code, map[string]interface{}{"success": err == nil, "generation": generation, "duration_ms": duration, "error": errorText(err)})
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type customDomainRequest struct {
	SandboxID    string `json:"sandbox_id"`
	CustomDomain string `json:"custom_domain"`
}

var domainNameRE = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`)

func handleCustomDomain(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	var req customDomainRequest
	if err := decodeStrictJSON(w, r, &req); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
		return
	}
	if !dnsLabelRE.MatchString(req.SandboxID) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid sandbox_id format"})
		return
	}
	req.CustomDomain = strings.TrimSpace(strings.ToLower(req.CustomDomain))
	if req.CustomDomain != "" && !domainNameRE.MatchString(req.CustomDomain) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid custom_domain: must be a valid FQDN (e.g. app.team1.example.com)"})
		return
	}

	db, err := getDBConnection()
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Database error"})
		return
	}
	defer db.Close()

	var status string
	err = db.QueryRow("SELECT status FROM sandboxes WHERE sandbox_id = ?", req.SandboxID).Scan(&status)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Sandbox '%s' not found", req.SandboxID)})
			return
		}
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Query error"})
		return
	}

	_, err = db.Exec("UPDATE sandboxes SET custom_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE sandbox_id = ?", req.CustomDomain, req.SandboxID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to update custom domain"})
		return
	}

	eventType := "CUSTOM_DOMAIN_BOUND"
	detail := fmt.Sprintf("domain=%s", req.CustomDomain)
	if req.CustomDomain == "" {
		eventType = "CUSTOM_DOMAIN_REMOVED"
		detail = "cleared"
	}
	recordEventForSandbox(req.SandboxID, eventType, detail, 0)

	_, _ = syncHAProxyDualGateways(false)

	sendJSON(w, http.StatusOK, map[string]interface{}{
		"success":       true,
		"sandbox_id":    req.SandboxID,
		"custom_domain": req.CustomDomain,
	})
}

func runAPIServer(port int) {
	startGatewayServer(port)
}
