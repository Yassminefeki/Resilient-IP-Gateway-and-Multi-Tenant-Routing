package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// ── Error envelope ─────────────────────────────────────────────────────────────

type apiErr struct {
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
	Code   int    `json:"code"`
}

func errJSON(w http.ResponseWriter, status int, msg string, detail ...string) {
	e := apiErr{Error: msg, Code: status}
	if len(detail) > 0 {
		e.Detail = detail[0]
	}
	writeJSON(w, status, e)
}

// ── DB store ───────────────────────────────────────────────────────────────────

type gatewayStore struct {
	db *sql.DB
}

func newGatewayStore() (*gatewayStore, error) {
	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	store, err := newGatewayStoreWithDB(db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func newGatewayStoreWithDB(db *sql.DB) (*gatewayStore, error) {
	if err := db.Ping(); err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(30 * time.Second)
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	return &gatewayStore{db: db}, nil
}

func (s *gatewayStore) close() { _ = s.db.Close() }

// ── JSON / CORS helpers ───────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	w.WriteHeader(status)
	if payload != nil {
		_ = json.NewEncoder(w).Encode(payload)
	}
}

func logRequest(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next(w, r)
		log.Printf("gw-api %s %s %s %.1fms", r.Method, r.URL.Path, r.RemoteAddr, float64(time.Since(start).Microseconds())/1000)
	}
}

// ── Allowed value sets ─────────────────────────────────────────────────────────

var allowedGateways = map[string]bool{"gw1": true, "gw2": true}
var allowedSources = map[string]bool{"haproxy": true, "keepalived": true}
var allowedEventTypes = map[string]bool{
	"failover":         true,
	"rollback":         true,
	"keepalived_state": true,
	"sync":             true,
	"failover_test":    true,
	"health_check":     true,
}

// ── Router ─────────────────────────────────────────────────────────────────────

func gatewayHandler(store *gatewayStore) http.Handler {
	mux := http.NewServeMux()

	// ── Health ─────────────────────────────────────────────────────────────────
	mux.HandleFunc("/health", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		db, err := getDBConnection()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "DOWN", "db": "ERROR", "timestamp": time.Now().UTC().Format(time.RFC3339),
			})
			return
		}
		defer db.Close()
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "DOWN", "db": "ERROR", "timestamp": time.Now().UTC().Format(time.RFC3339),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":                       "UP",
			"source":                       "controlplane-gateway",
			"db":                           "OK",
			"timestamp":                    time.Now().UTC().Format(time.RFC3339),
			"reaper_last_tick_unix":        lastTickUnix.Load(),
			"reaper_last_tick_duration_ms": lastTickDurationMs.Load(),
			"oldest_overdue_seconds":       oldestOverdueSeconds.Load(),
		})
	}))

	// ── GET /api/gateways/status ───────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/status", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if isMockGateways() {
			writeJSON(w, http.StatusOK, getMockGatewayStatus())
			return
		}
		if r.URL.Query().Get("refresh") == "true" || r.URL.Query().Get("refresh") == "1" {
			gwCache.Invalidate()
		}
		pr := gwCache.Get(store)

		vip := envOr("VIP_ADDRESS", "10.20.20.246")
		gwOut := make(map[string]any, len(pr.Gateways))
		for name, p := range pr.Gateways {
			entry := map[string]any{
				"reachable":        p.Reachable,
				"haproxy":          p.HAProxy,
				"keepalived":       p.Keepalived,
				"vip_holder_local": p.VIPHolder,
				"probed_at":        p.ProbedAt,
				"error":            p.Error,
			}
			// Enrich with DPA info when credentials are available.
			if _, _, dpaErr := dpaCredentials(); dpaErr == nil {
				dpaInfo := ProbeDPAGateway(name)
				entry["dpa"] = map[string]any{
					"ready":   dpaInfo.Ready,
					"version": dpaInfo.Version,
					"error":   dpaInfo.Error,
				}
			}
			gwOut[name] = entry
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"gateways":          gwOut,
			"vip":               vip,
			"vip_holder":        pr.VIPHolder,
			"latest_generation": pr.LatestGenID,
			"fetched_at_ms":     pr.FetchedAtUnix,
			"deploy_method":     "dpa",
		})
	}))

	// ── GET /api/gateways/dpa ──────────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/dpa", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		results := make(map[string]any, len(gatewayHosts))
		for _, host := range gatewayHosts {
			results[host] = ProbeDPAGateway(host)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"dpa_port":      dpaPort(),
			"gateways":      results,
			"deploy_method": "dpa",
		})
	}))

	// ── GET /api/gateways/logs ─────────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/logs", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		q := r.URL.Query()
		gateway := q.Get("gateway")
		source := q.Get("source")
		if source == "" {
			source = "haproxy"
		}
		since := q.Get("since")
		if since != "" && !gatewayLogSinceRE.MatchString(since) {
			errJSON(w, http.StatusBadRequest, "invalid since value", "allowed chars: 0-9 A-Z a-z . : + - and space")
			return
		}

		if gateway == "" {
			errJSON(w, http.StatusBadRequest, "gateway param required", "valid values: gw1, gw2")
			return
		}
		if !allowedGateways[gateway] {
			errJSON(w, http.StatusBadRequest, "invalid gateway", "valid values: gw1, gw2")
			return
		}
		if !allowedSources[source] {
			errJSON(w, http.StatusBadRequest, "invalid source", "valid values: haproxy, keepalived")
			return
		}
		limit := 50
		if ls := q.Get("limit"); ls != "" {
			if l, err := strconv.Atoi(ls); err == nil {
				if l < 1 {
					limit = 1
				} else if l > 500 {
					limit = 500
				} else {
					limit = l
				}
			}
		}

		if isMockGateways() {
			lines := generateMockGatewayLogs(gateway, source, limit)
			writeJSON(w, http.StatusOK, map[string]any{
				"gateway": gateway,
				"source":  source,
				"since":   since,
				"limit":   limit,
				"count":   len(lines),
				"entries": lines,
			})
			return
		}

		lines, err := FetchGatewayLogs(gateway, source, since, limit)
		if err != nil {
			errStr := err.Error()
			code := http.StatusBadGateway
			if strings.Contains(errStr, "timed out") {
				code = http.StatusGatewayTimeout
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":         "log fetch failed",
				"detail":        errStr,
				"code":          code,
				"applied_limit": limit,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"gateway": gateway,
			"source":  source,
			"since":   since,
			"limit":   limit,
			"count":   len(lines),
			"entries": lines,
		})
	}))

	// ── GET /api/gateways/events   POST /api/gateways/events ──────────────────
	mux.HandleFunc("/api/gateways/events", logRequest(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodOptions:
			writeJSON(w, http.StatusNoContent, nil)
		case http.MethodGet:
			gwEventsGet(w, r, store)
		case http.MethodPost:
			gwEventsPost(w, r, store)
		default:
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	}))

	// ── GET /api/gateways/generations ─────────────────────────────────────────
	mux.HandleFunc("/api/gateways/generations", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		gwGenerationsGet(w, r, store)
	}))

	// ── POST /api/gateways/failover ────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/failover", logRequest(func(w http.ResponseWriter, r *http.Request) {
		handleGatewayFailover(store, w, r)
	}))

	// ── POST /api/gateways/sync ────────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/sync", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if err := tryGatewayOp("sync-manual"); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "duration_ms": int64(0)})
			return
		}
		defer releaseGatewayOp("sync-manual")
		var body struct {
			DryRun bool `json:"dry_run"`
		}
		if err := decodeStrictJSON(w, r, &body); err != nil {
			errJSON(w, http.StatusBadRequest, "invalid JSON", err.Error())
			return
		}
		success, msg, duration := syncHAProxyDualGatewaysTimed(body.DryRun, "manual")
		if !success {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "sync failed", "reason": msg, "duration_ms": duration})
			return
		}
		gwCache.Invalidate()
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": msg, "duration_ms": duration})
	}))

	// ── POST /api/gateways/rollback ────────────────────────────────────────────
	mux.HandleFunc("/api/gateways/rollback", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if err := tryGatewayOp("rollback-manual"); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "duration_ms": int64(0)})
			return
		}
		defer releaseGatewayOp("rollback-manual")
		var body struct {
			TargetGeneration string `json:"target_generation"`
		}
		if err := decodeStrictJSON(w, r, &body); err != nil {
			errJSON(w, http.StatusBadRequest, "invalid JSON", err.Error())
			return
		}
		generation, duration, err := rollbackConfigWithOptions(body.TargetGeneration, "manual", "operator request")
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "rollback failed", "reason": err.Error(), "duration_ms": duration})
			return
		}
		gwCache.Invalidate()
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "generation": generation, "duration_ms": duration})
	}))

	// ── GET /api/sandboxes ─────────────────────────────────────────────────────
	mux.HandleFunc("/api/sandboxes", logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		gwSandboxesGet(w, r)
	}))

	// ── GET /api/leases + /ipam/leases ────────────────────────────────────────
	leasesHandler := logRequest(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		gwLeasesGet(w, r)
	})
	mux.HandleFunc("/api/leases", leasesHandler)
	mux.HandleFunc("/ipam/leases", leasesHandler)

	// Legacy control-plane API routes stay on the canonical router so they
	// retain the same authentication, rate limiting, and request logging.
	mux.HandleFunc("/ipam/leases/allocate", logRequest(handleAllocate))
	mux.HandleFunc("/api/leases/allocate", logRequest(handleAllocate))
	mux.HandleFunc("/ipam/leases/release", logRequest(handleRelease))
	mux.HandleFunc("/api/leases/release", logRequest(handleRelease))
	mux.HandleFunc("/ipam/leases/reclaim", logRequest(handleReclaim))
	mux.HandleFunc("/api/leases/reclaim", logRequest(handleReclaim))
	mux.HandleFunc("/api/sandboxes/provision", logRequest(handleProvision))
	mux.HandleFunc("/api/sandboxes/extend", logRequest(handleExtendSandbox))
	mux.HandleFunc("/api/sandboxes/custom-domain", logRequest(handleCustomDomain))
	mux.HandleFunc("/api/sandboxes/", logRequest(handleSandboxTeardown))
	mux.HandleFunc("/api/reconcile", logRequest(handleReconcile))
	mux.HandleFunc("/api/reconcile/apply", logRequest(handleReconcileApply))
	mux.HandleFunc("/api/events", logRequest(handleEvents))
	mux.HandleFunc("/api/config", logRequest(handleConfigAPI))
	setupUIHandler(mux)

	// ── Catch-all ──────────────────────────────────────────────────────────────
	mux.HandleFunc("/", logRequest(func(w http.ResponseWriter, r *http.Request) {
		errJSON(w, http.StatusNotFound, "not found", r.URL.Path)
	}))

	return securityHandlerOrUnavailable(mux)
}

// ── /api/gateways/events GET ──────────────────────────────────────────────────

func gwEventsGet(w http.ResponseWriter, r *http.Request, _ *gatewayStore) {
	q := r.URL.Query()

	limit := 50
	if ls := q.Get("limit"); ls != "" {
		if l, err := strconv.Atoi(ls); err == nil {
			switch {
			case l < 1:
				limit = 1
			case l > 500:
				limit = 500
			default:
				limit = l
			}
		}
	}

	typFilter := q.Get("type")
	sinceFilter := q.Get("since") // epoch ms

	db, err := getDBConnection()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error", err.Error())
		return
	}
	defer db.Close()

	query := `SELECT id, ts_ms, COALESCE(sandbox_id,''), type, COALESCE(detail,''), COALESCE(duration_ms,0)
	          FROM events WHERE 1=1`
	args := []any{}

	if typFilter != "" {
		query += " AND type = ?"
		args = append(args, typFilter)
	}
	if sinceFilter != "" {
		if ms, err := strconv.ParseInt(sinceFilter, 10, 64); err == nil {
			query += " AND ts_ms >= ?"
			args = append(args, ms)
		}
	}
	query += " ORDER BY ts_ms DESC, id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := db.Query(query, args...)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "query error", err.Error())
		return
	}
	defer rows.Close()

	var events []map[string]any
	for rows.Next() {
		var id int
		var tsMs, durMs int64
		var sandboxID, typ, detail string
		if err := rows.Scan(&id, &tsMs, &sandboxID, &typ, &detail, &durMs); err == nil {
			events = append(events, map[string]any{
				"id":          id,
				"ts_ms":       tsMs,
				"ts_iso":      time.UnixMilli(tsMs).UTC().Format(time.RFC3339),
				"sandbox_id":  sandboxID,
				"type":        typ,
				"detail":      detail,
				"duration_ms": durMs,
			})
		}
	}
	if events == nil {
		events = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "count": len(events), "limit": limit})
}

// ── /api/gateways/events POST ─────────────────────────────────────────────────

type eventsPostBody struct {
	Type       string `json:"type"`
	State      string `json:"state"`
	Host       string `json:"hostname"`
	TsMs       int64  `json:"ts_ms"`
	DurationMs int64  `json:"duration_ms"`
	Detail     string `json:"detail"`
	SandboxID  string `json:"sandbox_id"`
}

func validateGatewayEventBody(body *eventsPostBody) error {
	if body.Type == "" {
		return errors.New("type is required")
	}
	if !allowedEventTypes[body.Type] {
		types := make([]string, 0, len(allowedEventTypes))
		for t := range allowedEventTypes {
			types = append(types, t)
		}
		return fmt.Errorf("invalid type: allowed %s", strings.Join(types, ", "))
	}
	if body.Host != "" && !allowedGateways[strings.ToLower(body.Host)] {
		return errors.New("hostname must be empty or gw1/gw2")
	}
	if body.State != "" {
		switch strings.ToUpper(body.State) {
		case "MASTER", "BACKUP", "FAULT":
		default:
			return errors.New("state must be empty or MASTER/BACKUP/FAULT")
		}
		body.State = strings.ToUpper(body.State)
	}
	if body.SandboxID != "" && !dnsLabelRE.MatchString(body.SandboxID) {
		return errors.New("sandbox_id must be a lowercase DNS label")
	}
	if len(body.Detail) > 512 {
		return errors.New("detail exceeds 512 characters")
	}
	if body.TsMs != 0 {
		now := time.Now().UTC().UnixMilli()
		if body.TsMs < now-86400000 || body.TsMs > now+86400000 {
			return errors.New("ts_ms is outside the allowed ±1 day window")
		}
	}
	return nil
}

func gwEventsPost(w http.ResponseWriter, r *http.Request, _ *gatewayStore) {
	var body eventsPostBody
	if err := decodeStrictJSON(w, r, &body); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid JSON body", err.Error())
		return
	}
	if err := validateGatewayEventBody(&body); err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.TsMs == 0 {
		body.TsMs = time.Now().UTC().UnixMilli()
	}
	body.Host = strings.ToLower(body.Host)
	detail := body.Detail
	if detail == "" && (body.State != "" || body.Host != "") {
		detail = fmt.Sprintf("state=%s host=%s", body.State, body.Host)
	}

	db, err := getDBConnection()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error", err.Error())
		return
	}
	defer db.Close()

	recordEvent(db, body.SandboxID, body.Type, detail, body.DurationMs)

	writeJSON(w, http.StatusCreated, map[string]any{
		"accepted":   true,
		"type":       body.Type,
		"ts_ms":      body.TsMs,
		"detail":     detail,
		"sandbox_id": body.SandboxID,
	})
}

// ── /api/gateways/generations GET ─────────────────────────────────────────────

func gwGenerationsGet(w http.ResponseWriter, r *http.Request, _ *gatewayStore) {
	q := r.URL.Query()
	limit := 20
	if ls := q.Get("limit"); ls != "" {
		if l, err := strconv.Atoi(ls); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	db, err := getDBConnection()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error", err.Error())
		return
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT id, generation_id, status, created_at, config_snapshot, COALESCE(gw1_backup,''), COALESCE(gw2_backup,'')
		FROM config_generations
		ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "query error", err.Error())
		return
	}
	defer rows.Close()

	var gens []map[string]any
	for rows.Next() {
		var id int
		var genID, status, createdAt, snapshot, gw1Backup, gw2Backup string
		if err := rows.Scan(&id, &genID, &status, &createdAt, &snapshot, &gw1Backup, &gw2Backup); err == nil {
			// Count backend stanzas as a proxy for "number of active routes"
			backendCount := strings.Count(snapshot, "\nbackend ")
			gens = append(gens, map[string]any{
				"id":            id,
				"generation_id": genID,
				"status":        status,
				"created_at":    createdAt,
				"backend_count": backendCount,
				"gw1_backup":    gw1Backup,
				"gw2_backup":    gw2Backup,
			})
		}
	}
	if gens == nil {
		gens = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"generations": gens, "count": len(gens)})
}

// ── /api/sandboxes GET ────────────────────────────────────────────────────────

func gwSandboxesGet(w http.ResponseWriter, _ *http.Request) {
	db, err := getDBConnection()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error", err.Error())
		return
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

	query := `
		SELECT id, sandbox_id, hostname, subnet_name,
		       COALESCE(private_ip,'') AS private_ip,
		       status, created_at, updated_at, expires_at
		FROM sandboxes ORDER BY created_at`
	if hasCustomDomain {
		query = `
		SELECT id, sandbox_id, hostname, subnet_name,
		       COALESCE(private_ip,'') AS private_ip,
		       status, created_at, updated_at, expires_at,
		       COALESCE(custom_domain, '') AS custom_domain
		FROM sandboxes ORDER BY created_at`
	}

	rows, err := db.Query(query)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "query error", err.Error())
		return
	}
	defer rows.Close()

	var sbs []map[string]any
	for rows.Next() {
		var id int
		var sandboxID, hostname, subnet, ip, status, createdAt, updatedAt string
		var customDomain string
		var expiresAt sql.NullInt64
		var scanErr error
		if hasCustomDomain {
			scanErr = rows.Scan(&id, &sandboxID, &hostname, &subnet, &ip, &status, &createdAt, &updatedAt, &expiresAt, &customDomain)
		} else {
			scanErr = rows.Scan(&id, &sandboxID, &hostname, &subnet, &ip, &status, &createdAt, &updatedAt, &expiresAt)
		}
		if scanErr == nil {
			m := map[string]any{
				"id":            id,
				"sandbox_id":    sandboxID,
				"hostname":      hostname,
				"subnet_name":   subnet,
				"private_ip":    ip,
				"status":        status,
				"created_at":    createdAt,
				"updated_at":    updatedAt,
				"custom_domain": customDomain,
			}
			if expiresAt.Valid {
				now := time.Now().UTC().Unix()
				rem := expiresAt.Int64 - now
				if rem < 0 {
					rem = 0
				}
				m["expires_at"] = expiresAt.Int64
				m["ttl_remaining_seconds"] = rem
			} else {
				m["expires_at"] = nil
				m["ttl_remaining_seconds"] = nil
			}
			sbs = append(sbs, m)
		}
	}
	if sbs == nil {
		sbs = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sandboxes": sbs, "count": len(sbs)})
}

// ── /api/leases GET ───────────────────────────────────────────────────────────

func gwLeasesGet(w http.ResponseWriter, _ *http.Request) {
	db, err := getDBConnection()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error", err.Error())
		return
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT id, ip_address, subnet_name, entity_name, entity_type, status,
		       COALESCE(quarantined_at,'')    AS quarantined_at,
		       COALESCE(quarantine_until,'')  AS quarantine_until,
		       COALESCE(assigned_at,'')       AS assigned_at
		FROM ip_allocations ORDER BY subnet_name, ip_address`)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "query error", err.Error())
		return
	}
	defer rows.Close()

	var leases []map[string]any
	for rows.Next() {
		var id int
		var ip, subnet, entity, eType, status, qAt, qUntil, aAt string
		if err := rows.Scan(&id, &ip, &subnet, &entity, &eType, &status, &qAt, &qUntil, &aAt); err == nil {
			leases = append(leases, map[string]any{
				"id":               id,
				"ip_address":       ip,
				"subnet_name":      subnet,
				"entity_name":      entity,
				"entity_type":      eType,
				"status":           status,
				"quarantined_at":   qAt,
				"quarantine_until": qUntil,
				"assigned_at":      aAt,
			})
		}
	}
	if leases == nil {
		leases = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"leases": leases, "count": len(leases)})
}

// ── HTTP server entry point ────────────────────────────────────────────────────

func runServer(ctx context.Context, port int) (runErr error) {
	loadDotEnv()
	if _, err := loadAPISecurityConfig(); err != nil {
		return fmt.Errorf("API security configuration: %w", err)
	}
	if err := initDB(); err != nil {
		return fmt.Errorf("initialize database: %w", err)
	}

	serverCtx, cancelServer := context.WithCancel(ctx)
	defer cancelServer()
	if err := configureProvisioner(serverCtx); err != nil {
		return fmt.Errorf("configure provisioner: %w", err)
	}
	log.Printf("active provisioner: %T", provisioner)

	db, err := getDBConnection()
	if err != nil {
		return fmt.Errorf("open server database: %w", err)
	}
	store, err := newGatewayStoreWithDB(db)
	if err != nil {
		_ = db.Close()
		return fmt.Errorf("initialize gateway store: %w", err)
	}
	reaperDone, err := startReaper(serverCtx, db)
	if err != nil {
		store.close()
		return fmt.Errorf("start reaper: %w", err)
	}
	defer func() {
		cancelServer()
		select {
		case <-reaperDone:
		case <-time.After(10 * time.Second):
			if runErr == nil {
				runErr = errors.New("reaper did not stop within 10 seconds")
			}
		}
		store.close()
	}()

	writeTimeout := provisionTimeout + 30*time.Second
	if writeTimeout <= provisionTimeout {
		return errors.New("PROVISION_TIMEOUT_SECONDS is too large to configure the HTTP write timeout")
	}
	listenAddress := net.JoinHostPort(strings.Trim(os.Getenv("LISTEN_ADDR"), "[]"), strconv.Itoa(port))
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           gatewayHandler(store),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       120 * time.Second,
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", listenAddress, err)
	}
	log.Printf("control-plane gateway API listening on %s", listenAddress)

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()
	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			if !errors.Is(err, context.DeadlineExceeded) {
				return fmt.Errorf("shut down HTTP server: %w", err)
			}
		}
		if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			if !errors.Is(err, net.ErrClosed) {
				return fmt.Errorf("HTTP server: %w", err)
			}
		}
		return nil
	}
}

func startGatewayServer(port int) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runServer(ctx, port); err != nil {
		log.Printf("control-plane server stopped: %v", err)
		os.Exit(1)
	}
}

func runGatewayAPIServer() {
	port := 8081
	if envPort := os.Getenv("PORT"); envPort != "" {
		if parsedPort, err := strconv.Atoi(envPort); err == nil {
			port = parsedPort
		}
	}
	startGatewayServer(port)
}
