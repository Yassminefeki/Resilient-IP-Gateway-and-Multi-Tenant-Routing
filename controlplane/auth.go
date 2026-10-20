package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxJSONBodySize = 1 << 20

type apiSecurityConfig struct {
	tokenHash       [sha256.Size]byte
	authDisabled    bool
	corsOrigin      string
	rateLimitPerMin int
}

func loadAPISecurityConfig() (apiSecurityConfig, error) {
	var config apiSecurityConfig
	config.authDisabled = os.Getenv("AUTH_DISABLED") == "true"
	token := os.Getenv("ADMIN_TOKEN")
	if token == "" {
		if legacy := os.Getenv("CONTROL_PLANE_TOKEN"); legacy != "" {
			log.Printf("DEPRECATION WARNING: CONTROL_PLANE_TOKEN is deprecated; using it as ADMIN_TOKEN")
			token = legacy
		}
	}
	if token != "" && len(token) < 24 {
		return config, errors.New("ADMIN_TOKEN must be at least 24 characters")
	}
	if strings.ContainsAny(token, " \t\r\n") {
		return config, errors.New("ADMIN_TOKEN must not contain whitespace")
	}
	if !config.authDisabled && token == "" {
		return config, errors.New("ADMIN_TOKEN must be set unless AUTH_DISABLED=true")
	}
	config.tokenHash = sha256.Sum256([]byte(token))

	config.rateLimitPerMin = 30
	if value := os.Getenv("RATE_LIMIT_PER_MIN"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 {
			return config, errors.New("RATE_LIMIT_PER_MIN must be a positive integer")
		}
		config.rateLimitPerMin = limit
	}

	config.corsOrigin = os.Getenv("CORS_ORIGIN")
	if config.corsOrigin != "" {
		origin, err := url.Parse(config.corsOrigin)
		if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") ||
			origin.Host == "" || origin.User != nil || origin.Path != "" ||
			origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" ||
			strings.ContainsAny(config.corsOrigin, "#, \t\r\n") {
			return config, errors.New("CORS_ORIGIN must be exactly one http or https origin")
		}
	}
	return config, nil
}

func logSecurityConfiguration(config apiSecurityConfig) {
	if config.authDisabled {
		log.Printf("!!! WARNING: API BEARER AUTHENTICATION IS DISABLED (AUTH_DISABLED=true) !!!")
	}
}

func setupAPISecurity(next http.Handler, config apiSecurityConfig) http.Handler {
	limiter := newIPRateLimiter(config.rateLimitPerMin)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions && r.Header.Get("Origin") != "" {
			handleCORSPreflight(w, r, config)
			return
		}

		if origin := r.Header.Get("Origin"); origin != "" && origin == config.corsOrigin {
			w.Header().Set("Access-Control-Allow-Origin", config.corsOrigin)
			w.Header().Add("Vary", "Origin")
		}

		if (r.Method == http.MethodGet || r.Method == http.MethodHead) && (r.URL.Path == "/health" || r.URL.Path == "/api/config" || r.URL.Path == "/ui" || strings.HasPrefix(r.URL.Path, "/ui/")) {
			next.ServeHTTP(w, r)
			return
		}

		if !config.authDisabled {
			if r.URL.Path == "/api/gateways/events" && r.Method == http.MethodPost && allowGatewayEventRequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			if !hasValidBearerToken(r, config.tokenHash) {
				w.Header().Set("WWW-Authenticate", `Bearer realm="controlplane"`)
				sendJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
				return
			}
		}

		if isMutatingRoute(r) {
			if !limiter.allow(clientIP(r), time.Now()) {
				w.Header().Set("Retry-After", "60")
				sendJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func allowGatewayEventRequest(r *http.Request) bool {
	if r.Method != http.MethodPost || r.URL.Path != "/api/gateways/events" {
		return false
	}
	if hasValidBearerToken(r, sha256.Sum256([]byte(os.Getenv("ADMIN_TOKEN")))) {
		return true
	}
	if hasValidEventsToken(r) {
		return true
	}
	if strings.EqualFold(os.Getenv("EVENTS_ALLOW_SUBNET"), "true") {
		_, network, err := net.ParseCIDR(envOr("GATEWAY_SUBNET", "10.20.10.0/24"))
		if err == nil {
			if ip := clientIP(r); ip != "unknown" {
				addr := net.ParseIP(ip)
				if addr != nil && network.Contains(addr) {
					return true
				}
			}
		}
	}
	return false
}

func hasValidEventsToken(r *http.Request) bool {
	provided := r.Header.Get("X-Events-Token")
	expected := os.Getenv("EVENTS_TOKEN")
	if provided == "" || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func handleCORSPreflight(w http.ResponseWriter, r *http.Request, config apiSecurityConfig) {
	origin := r.Header.Get("Origin")
	if config.corsOrigin == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if origin != config.corsOrigin {
		http.Error(w, "CORS origin not allowed", http.StatusForbidden)
		return
	}
	method := r.Header.Get("Access-Control-Request-Method")
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodDelete && method != http.MethodOptions {
		http.Error(w, "CORS method not allowed", http.StatusForbidden)
		return
	}
	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		header = strings.TrimSpace(header)
		if header != "" && !strings.EqualFold(header, "Authorization") && !strings.EqualFold(header, "Content-Type") {
			http.Error(w, "CORS header not allowed", http.StatusForbidden)
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", config.corsOrigin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

func hasValidBearerToken(r *http.Request, expectedHash [sha256.Size]byte) bool {
	header := r.Header.Get("Authorization")
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.ContainsAny(token, " \t\r\n") {
		return false
	}
	providedHash := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodySize)
	decoder := json.NewDecoder(r.Body)
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("request must contain one JSON object")
		}
		return err
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return errors.New("request must contain one JSON object")
	}
	strictDecoder := json.NewDecoder(bytes.NewReader(raw))
	strictDecoder.DisallowUnknownFields()
	if err := strictDecoder.Decode(dst); err != nil {
		return err
	}
	return nil
}

func validIPv4Address(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.To4() != nil && ip.String() == address
}

func isMutatingRoute(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return false
	}
	path := r.URL.Path
	switch {
	case path == "/ipam/leases/allocate", path == "/api/leases/allocate",
		path == "/ipam/leases/release", path == "/api/leases/release",
		path == "/ipam/leases/reclaim", path == "/api/leases/reclaim",
		path == "/api/sandboxes/provision", path == "/api/sandboxes/extend",
		path == "/api/reconcile/apply", path == "/api/gateways/sync",
		path == "/api/gateways/rollback", path == "/api/gateways/events",
		path == "/api/gateways/failover":
		return true
	case strings.HasPrefix(path, "/api/sandboxes/"):
		return r.Method == http.MethodDelete || (r.Method == http.MethodPost && strings.HasSuffix(path, "/teardown"))
	default:
		return false
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	return address.Unmap().String()
}

type rateWindow struct {
	start time.Time
	count int
}

type ipRateLimiter struct {
	mu      sync.Mutex
	limit   int
	windows map[string]rateWindow
	maxIPs  int
}

func newIPRateLimiter(limit int) *ipRateLimiter {
	return &ipRateLimiter{limit: limit, windows: make(map[string]rateWindow), maxIPs: 10_000}
}

func (limiter *ipRateLimiter) allow(ip string, now time.Time) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	windowStart := now.Truncate(time.Minute)
	for address, window := range limiter.windows {
		if window.start.Before(windowStart) {
			delete(limiter.windows, address)
		}
	}
	window, exists := limiter.windows[ip]
	if !exists {
		if len(limiter.windows) >= limiter.maxIPs {
			return false
		}
		window = rateWindow{start: windowStart}
	}
	if window.start.Before(windowStart) {
		window = rateWindow{start: windowStart}
	}
	if window.count >= limiter.limit {
		return false
	}
	window.count++
	limiter.windows[ip] = window
	return true
}

func securityHandlerOrUnavailable(next http.Handler) http.Handler {
	config, err := loadAPISecurityConfig()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, fmt.Sprintf("API security configuration error: %v", err), http.StatusServiceUnavailable)
		})
	}
	return setupAPISecurity(next, config)
}
