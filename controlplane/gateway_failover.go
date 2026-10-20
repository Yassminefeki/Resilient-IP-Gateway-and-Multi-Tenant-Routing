package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultFailoverThreshold = 3000 * time.Millisecond

var (
	failoverHookMu        sync.RWMutex
	failoverPollInterval  = 50 * time.Millisecond
	failoverStatusReader  = liveFailoverStatus
	failoverCommandRunner = runServiceCommand
	failoverVIPProbe      = probeFailoverVIP
)

func currentFailoverStatusReader() func(*gatewayStore) ProbeResult {
	failoverHookMu.RLock()
	defer failoverHookMu.RUnlock()
	return failoverStatusReader
}

func currentFailoverCommandRunner() func(string, string, string) error {
	failoverHookMu.RLock()
	defer failoverHookMu.RUnlock()
	return failoverCommandRunner
}

func currentFailoverVIPProbe() func(context.Context, *url.URL, string) failoverVIPResponse {
	failoverHookMu.RLock()
	defer failoverHookMu.RUnlock()
	return failoverVIPProbe
}

func currentFailoverPollInterval() time.Duration {
	failoverHookMu.RLock()
	defer failoverHookMu.RUnlock()
	return failoverPollInterval
}

func normalizeFailoverMode(mode string) (string, error) {
	switch strings.TrimSpace(mode) {
	case "", "keepalived":
		return "keepalived", nil
	case "haproxy-only":
		return "haproxy-only", nil
	default:
		return "", errors.New("invalid failover mode: must be keepalived or haproxy-only")
	}
}

func allowedFailoverService(mode string) string {
	if strings.TrimSpace(mode) == "haproxy-only" {
		return "haproxy"
	}
	return "keepalived"
}

type failoverResponse struct {
	Success              bool   `json:"success"`
	Before               string `json:"before"`
	After                string `json:"after"`
	DowntimeMS           int64  `json:"downtime_ms"`
	FailoverMS           int64  `json:"failover_ms,omitempty"`
	FailedRequests       int    `json:"failed_requests,omitempty"`
	TotalRequests        int    `json:"total_requests,omitempty"`
	ServingGatewayBefore string `json:"serving_gateway_before,omitempty"`
	ServingGatewayAfter  string `json:"serving_gateway_after,omitempty"`
	VerifiedBy           string `json:"verified_by,omitempty"`
	Mode                 string `json:"mode,omitempty"`
	FailbackDowntimeMS   int64  `json:"failback_downtime_ms,omitempty"`
	Reason               string `json:"reason,omitempty"`
}

type failoverVIPResponse struct {
	Gateway string
	Status  int
	Err     error
}

func liveFailoverStatus(store *gatewayStore) ProbeResult {
	gwCache.Invalidate()
	return gwCache.Get(store)
}

func failoverThreshold() (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv("FAILOVER_THRESHOLD_MS"))
	if value == "" {
		return defaultFailoverThreshold, nil
	}
	ms, err := strconv.Atoi(value)
	if err != nil || ms < 1 || ms > 60000 {
		return 0, errors.New("FAILOVER_THRESHOLD_MS must be an integer from 1 to 60000")
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func failoverProbeTarget() (*url.URL, string, error) {
	target := strings.TrimSpace(os.Getenv("FAILOVER_PROBE_URL"))
	if target == "" {
		vip := envOr("VIP_ADDRESS", "10.20.20.246")
		target = "http://" + vip + "/"
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, "", errors.New("FAILOVER_PROBE_URL must be an http(s) URL without user credentials")
	}
	return u, strings.TrimSpace(os.Getenv("FAILOVER_PROBE_HOST")), nil
}

func probeFailoverVIP(ctx context.Context, target *url.URL, host string) failoverVIPResponse {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return failoverVIPResponse{Err: err}
	}
	if host != "" {
		request.Host = host
	}
	client := &http.Client{Timeout: 300 * time.Millisecond}
	response, err := client.Do(request)
	if err != nil {
		return failoverVIPResponse{Err: err}
	}
	defer response.Body.Close()
	return failoverVIPResponse{Gateway: strings.TrimSpace(response.Header.Get("X-Gateway-ID")), Status: response.StatusCode}
}

func runServiceCommand(gateway, service, action string) error {
	if !allowedGateways[gateway] || (action != "stop" && action != "start") {
		return errors.New("invalid gateway or service action")
	}
	if service != "keepalived" && service != "haproxy" {
		return errors.New("invalid service")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	inventory := resolveRepoFilePath("ANSIBLE_INVENTORY", "ansible/inventory/hosts.yml")
	vault := resolveRepoFilePath("ANSIBLE_VAULT_PASS", "ansible/.vault_pass")
	bastion := envOr("BASTION_IP", "197.5.133.77")
	cmd := exec.CommandContext(ctx, "ansible",
		"-i", inventory, gateway,
		"-m", "command", "-a", "systemctl "+action+" "+service, "-b",
		"--vault-password-file", vault,
		"-e", fmt.Sprintf("ansible_ssh_common_args='-o ProxyJump=ansible@%s -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -o IPQoS=none'", bastion),
	)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("Ansible %s %s on %s: %w (%s)", action, service, gateway, ctx.Err(), strings.TrimSpace(output.String()))
		}
		return fmt.Errorf("Ansible %s %s on %s: %w (%s)", action, service, gateway, err, strings.TrimSpace(output.String()))
	}
	return nil
}

func runKeepalivedCommand(gateway, action string) error {
	return runServiceCommand(gateway, "keepalived", action)
}

func failoverPollDelay() time.Duration {
	if value := strings.TrimSpace(os.Getenv("FAILOVER_POLL_MS")); value != "" {
		if ms, err := strconv.Atoi(value); err == nil && ms > 0 && ms <= 5000 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return currentFailoverPollInterval()
}

type failoverSample struct {
	TS      time.Time
	Gateway string
	Status  int
	OK      bool
}

func performGatewayFailover(store *gatewayStore, mode ...string) (result failoverResponse, statusCode int) {
	selectedMode := ""
	if len(mode) > 0 {
		selectedMode = mode[0]
	}
	result = failoverResponse{Before: "unknown", After: "unknown", Mode: "keepalived", VerifiedBy: "responding-gateway-header"}
	statusCode = http.StatusBadGateway
	stoppedGateway := ""
	serviceName := "keepalived"
	if normalized, err := normalizeFailoverMode(selectedMode); err == nil {
		serviceName = allowedFailoverService(normalized)
		result.Mode = normalized
	} else {
		result.Reason = err.Error()
		return result, http.StatusBadRequest
	}
	startedAt := time.Now()
	stopIssuedAt := startedAt
	var outageStarted time.Time
	var lastOKBeforeStop time.Time
	var failoverAt time.Time
	var failedRequests, totalRequests int
	var downtimeMS int64
	var sawFailureSinceStop bool
	var sampleCh = make(chan failoverSample, 32)
	probeTarget, probeHost, targetErr := failoverProbeTarget()
	if targetErr != nil {
		result.Reason = targetErr.Error()
		return result, http.StatusBadRequest
	}
	defer func() {
		if stoppedGateway != "" {
			if restartErr := currentFailoverCommandRunner()(stoppedGateway, serviceName, "start"); restartErr != nil {
				result.Success = false
				result.Reason = strings.TrimSpace(strings.Join([]string{result.Reason, "failed to restart " + serviceName + ": " + restartErr.Error()}, "; "))
				if statusCode != http.StatusGatewayTimeout {
					statusCode = http.StatusBadGateway
				}
			} else {
				gwCache.Invalidate()
			}
		}
		result.ServingGatewayBefore = result.Before
		result.ServingGatewayAfter = result.After
		if result.VerifiedBy == "" {
			result.VerifiedBy = "responding-gateway-header"
		}
		if store != nil && store.db != nil {
			payload, _ := json.Marshal(result)
			detail := fmt.Sprintf("from=%s to=%s result=%s", result.Before, result.After, map[bool]string{true: "success", false: "failed"}[result.Success])
			if result.Reason != "" {
				detail += " reason=" + result.Reason
			}
			detail += " " + string(payload)
			recordEvent(store.db, "", "failover", detail, result.DowntimeMS)
		}
	}()
	threshold, err := failoverThreshold()
	if err != nil {
		result.Reason = err.Error()
		return result, http.StatusBadRequest
	}
	state := currentFailoverStatusReader()(store)
	result.Before = state.VIPHolder
	result.After = state.VIPHolder
	if !allowedGateways[result.Before] || !state.Gateways[result.Before].Reachable || !state.Gateways[result.Before].VIPHolder {
		result.Reason = "live gateway status did not identify a reachable VIP holder"
		return result, http.StatusGatewayTimeout
	}
	result.ServingGatewayBefore = result.Before
	result.ServingGatewayAfter = result.After

	stoppedGateway = result.Before
	servicePoll := make(chan struct{})
	var servicePollOnce sync.Once
	stopServicePoll := func() {
		servicePollOnce.Do(func() { close(servicePoll) })
	}
	go func() {
		poll := failoverPollDelay()
		for {
			select {
			case <-servicePoll:
				return
			default:
			}
			probeCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			probe := currentFailoverVIPProbe()(probeCtx, probeTarget, probeHost)
			cancel()
			sample := failoverSample{TS: time.Now(), Gateway: probe.Gateway, Status: probe.Status, OK: probe.Err == nil && probe.Status >= 200 && probe.Status < 400 && allowedGateways[probe.Gateway]}
			select {
			case sampleCh <- sample:
			default:
			}
			select {
			case <-time.After(poll):
			case <-servicePoll:
				return
			}
		}
	}()

	stopIssuedAt = time.Now()
	if err := currentFailoverCommandRunner()(stoppedGateway, serviceName, "stop"); err != nil {
		result.Reason = "could not stop " + serviceName + ": " + err.Error()
		return result, http.StatusBadGateway
	}
	deadline := time.Now().Add(threshold)
	for time.Now().Before(deadline) {
		select {
		case sample := <-sampleCh:
			totalRequests++
			if !sample.OK {
				failedRequests++
				if sample.TS.After(stopIssuedAt) || sample.TS.Equal(stopIssuedAt) {
					sawFailureSinceStop = true
				}
				if outageStarted.IsZero() {
					outageStarted = sample.TS
				}
				continue
			}
			if !lastOKBeforeStop.IsZero() && sample.TS.After(stopIssuedAt) && sawFailureSinceStop {
				gap := sample.TS.Sub(lastOKBeforeStop).Milliseconds()
				if gap > downtimeMS {
					downtimeMS = gap
				}
			}
			if lastOKBeforeStop.IsZero() || sample.TS.Before(stopIssuedAt) {
				lastOKBeforeStop = sample.TS
			}
			if sample.Gateway != result.Before && sample.Status >= 200 && sample.Status < 400 {
				if failoverAt.IsZero() {
					failoverAt = sample.TS
				}
				result.After = sample.Gateway
				result.Success = true
				result.Reason = ""
				result.FailoverMS = failoverAt.Sub(stopIssuedAt).Milliseconds()
				if result.FailoverMS < 0 {
					result.FailoverMS = 0
				}
				result.DowntimeMS = downtimeMS
				result.FailedRequests = failedRequests
				result.TotalRequests = totalRequests
				result.ServingGatewayAfter = result.After
				result.VerifiedBy = "responding-gateway-header"
				statusCode = http.StatusOK
				stopServicePoll()
				return result, statusCode
			}
			if outageStarted.IsZero() {
				outageStarted = sample.TS
			}
		default:
			if time.Now().After(deadline) {
				goto timeout
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

timeout:
	stopServicePoll()
	result.DowntimeMS = downtimeMS
	if result.DowntimeMS == 0 && !outageStarted.IsZero() {
		result.DowntimeMS = time.Since(outageStarted).Milliseconds()
	}
	result.FailedRequests = failedRequests
	result.TotalRequests = totalRequests
	result.Reason = fmt.Sprintf("VIP did not move to a different gateway within %dms", threshold.Milliseconds())
	return result, http.StatusGatewayTimeout
}

func handleGatewayFailover(store *gatewayStore, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		Confirm       bool   `json:"confirm"`
		Mode          string `json:"mode"`
		TargetGateway string `json:"target_gateway"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Confirm {
		errJSON(w, http.StatusBadRequest, "confirm:true required")
		return
	}
	mode, err := normalizeFailoverMode(body.Mode)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := tryGatewayOp("failover-manual"); err != nil {
		errJSON(w, http.StatusConflict, err.Error())
		return
	}
	defer releaseGatewayOp("failover-manual")

	if isMockGateways() {
		handleMockFailover(w, body.TargetGateway, mode)
		return
	}

	result, status := performGatewayFailover(store, mode)
	writeJSON(w, status, result)
}
