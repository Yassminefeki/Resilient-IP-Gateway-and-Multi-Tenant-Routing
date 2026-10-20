package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var teardownLocks sync.Map
var teardownTimeout = 120 * time.Second
var teardownConcurrency = 4

var errTeardownInProgress = errors.New("sandbox teardown is already in progress")
var errTeardownRefused = errors.New("sandbox is not managed by the control plane")

type teardownRefusedError struct {
	ManagedBy string
}

func (e *teardownRefusedError) Error() string {
	return fmt.Sprintf("%v (managed_by=%q)", errTeardownRefused, e.ManagedBy)
}

func (e *teardownRefusedError) Unwrap() error { return errTeardownRefused }

type teardownResult struct {
	SandboxID       string           `json:"sandbox_id"`
	State           string           `json:"state"`
	AlreadyReleased bool             `json:"-"`
	TimingsMS       map[string]int64 `json:"timings_ms"`
}

type teardownSnapshot struct {
	id, hostname, subnet, ip, status, serverID, portID, managedBy string
	started, routeRemoved, resourcesDeleted                       sql.NullInt64
	verifiedGone, released                                        sql.NullInt64
}

type teardownStepError struct {
	Step string
	Err  error
}

func parseTeardownConfig(lookupEnv func(string) string) (time.Duration, int, error) {
	timeout := 120 * time.Second
	if raw := strings.TrimSpace(lookupEnv("TEARDOWN_TIMEOUT_SECONDS")); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 1 || int64(seconds) > int64(^uint64(0)>>1)/int64(time.Second) {
			return 0, 0, errors.New("TEARDOWN_TIMEOUT_SECONDS must be a positive integer")
		}
		timeout = time.Duration(seconds) * time.Second
	}
	concurrency := 4
	if raw := strings.TrimSpace(lookupEnv("TEARDOWN_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 128 {
			return 0, 0, errors.New("TEARDOWN_CONCURRENCY must be an integer from 1 to 128")
		}
		concurrency = value
	}
	return timeout, concurrency, nil
}

func (e *teardownStepError) Error() string { return e.Err.Error() }
func (e *teardownStepError) Unwrap() error { return e.Err }

func loadTeardownSnapshot(db *sql.DB, id string) (teardownSnapshot, error) {
	var s teardownSnapshot
	err := db.QueryRow(`SELECT sandbox_id,hostname,subnet_name,COALESCE(private_ip,''),status,
		COALESCE(server_id,''),COALESCE(port_id,''),teardown_started_at,teardown_route_removed_at,
		teardown_resources_deleted_at,teardown_verified_gone_at,teardown_released_at,COALESCE(managed_by,'external')
		FROM sandboxes WHERE sandbox_id=?`, id).Scan(&s.id, &s.hostname, &s.subnet, &s.ip, &s.status,
		&s.serverID, &s.portID, &s.started, &s.routeRemoved, &s.resourcesDeleted, &s.verifiedGone, &s.released, &s.managedBy)
	if err == sql.ErrNoRows {
		return s, fmt.Errorf("%w: %s", ErrSandboxNotFound, id)
	}
	return s, err
}

func teardownSandbox(ctx context.Context, id string) (*teardownResult, error) {
	totalStart := time.Now()
	lockAny, _ := teardownLocks.LoadOrStore(id, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	if !lock.TryLock() {
		return nil, errTeardownInProgress
	}
	defer lock.Unlock()

	db, err := getDBConnection()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	s, err := loadTeardownSnapshot(db, id)
	if err != nil {
		return nil, err
	}
	if s.managedBy != "control-plane" {
		if err := recordTeardownRefused(db, id, s.managedBy); err != nil {
			return nil, err
		}
		return nil, &teardownRefusedError{ManagedBy: s.managedBy}
	}
	result := &teardownResult{SandboxID: id, State: s.status, TimingsMS: zeroTeardownTimings()}
	if s.status == "RELEASED" {
		result.AlreadyReleased = true
		return result, nil
	}
	if s.status == "TEARDOWN_FAILED" {
		if _, err := db.Exec(`UPDATE sandboxes SET status='TEARING_DOWN',teardown_step_attempts=0,teardown_last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=? AND status='TEARDOWN_FAILED'`, id); err != nil {
			return nil, err
		}
		s.status = "TEARING_DOWN"
	}
	if s.status != "TEARING_DOWN" {
		if !isValidTransition(s.status, "TEARING_DOWN") {
			return nil, fmt.Errorf("sandbox %q cannot be torn down from state %s", id, s.status)
		}
		start := time.Now()
		tx, err := db.Begin()
		if err != nil {
			return nil, err
		}
		err = transitionSandbox(tx, id, "TEARING_DOWN")
		if err == nil {
			var update sql.Result
			update, err = tx.Exec(`UPDATE sandboxes SET teardown_step='mark_tearing_down',
				teardown_started_at=COALESCE(teardown_started_at,?),updated_at=CURRENT_TIMESTAMP
				WHERE sandbox_id=? AND status='TEARING_DOWN'`, nowUnix(), id)
			if err == nil {
				var changed int64
				changed, err = update.RowsAffected()
				if err == nil && changed == 0 {
					err = errProvisionClaimed
				}
			}
		}
		if err == nil && !s.started.Valid {
			recordEvent(tx, id, "TEARDOWN_STARTED", "state=TEARING_DOWN", time.Since(start).Milliseconds())
		}
		if err != nil {
			tx.Rollback()
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		result.TimingsMS["mark_tearing_down"] = time.Since(start).Milliseconds()
		s.status = "TEARING_DOWN"
		s.started.Valid = true
	}
	if !s.started.Valid {
		start := time.Now()
		if _, err := db.Exec(`UPDATE sandboxes SET teardown_started_at=?,teardown_step='mark_tearing_down' WHERE sandbox_id=?`, nowUnix(), id); err != nil {
			return nil, err
		}
		recordEvent(db, id, "TEARDOWN_STARTED", "resumed=1", time.Since(start).Milliseconds())
	}

	if !s.routeRemoved.Valid {
		if err := beginTeardownStep(db, id, "remove_route"); err != nil {
			return nil, err
		}
		start := time.Now()
		if err := mockTeardownFailure("remove_route"); err != nil {
			return nil, failTeardownStep(db, id, "remove_route", err, time.Since(start).Milliseconds())
		}
		ok, message := runCoalescedProvisionSync(ctx)
		duration := time.Since(start).Milliseconds()
		if !ok {
			return nil, failTeardownStep(db, id, "remove_route", errors.New(message), duration)
		}
		if err := completeTeardownStep(db, id, "remove_route", "teardown_route_removed_at", "ROUTE_REMOVED", "route removed", duration); err != nil {
			return nil, err
		}
		result.TimingsMS["remove_route"] = duration
	}

	if !s.resourcesDeleted.Valid {
		if err := beginTeardownStep(db, id, "delete_resources"); err != nil {
			return nil, err
		}
		if s.serverID == "" && s.portID == "" {
			recordEvent(db, id, "RESOURCE_DELETE_SKIPPED", "server_id and port_id are empty; refusing name-based deletion", 0)
		} else {
			if provisioner == nil {
				return nil, failTeardownStep(db, id, "delete_resources", errors.New("provisioner is not configured"), 0)
			}
			if s.serverID != "" {
				start := time.Now()
				err := provisioner.DeleteSandbox(ctx, s.serverID, "")
				duration := time.Since(start).Milliseconds()
				if err != nil {
					return nil, failTeardownStep(db, id, "delete_server", err, duration)
				}
				recordEvent(db, id, "SERVER_DELETED", s.serverID, duration)
				result.TimingsMS["delete_server"] = duration
			}
			if s.portID != "" {
				start := time.Now()
				err := provisioner.DeleteSandbox(ctx, "", s.portID)
				duration := time.Since(start).Milliseconds()
				if err != nil {
					return nil, failTeardownStep(db, id, "delete_port", err, duration)
				}
				recordEvent(db, id, "PORT_DELETED", s.portID, duration)
				result.TimingsMS["delete_port"] = duration
			}
		}
		if err := completeTeardownStep(db, id, "delete_resources", "teardown_resources_deleted_at", "RESOURCES_DELETED", "resource deletion complete", 0); err != nil {
			return nil, err
		}
	}

	if !s.verifiedGone.Valid {
		if err := beginTeardownStep(db, id, "verify_gone"); err != nil {
			return nil, err
		}
		start := time.Now()
		if err := mockTeardownFailure("verify_gone"); err != nil {
			return nil, failTeardownStep(db, id, "verify_gone", err, time.Since(start).Milliseconds())
		}
		if err := verifySandboxResourcesGone(ctx, provisioner, s.serverID, s.portID); err != nil {
			duration := time.Since(start).Milliseconds()
			return nil, failTeardownStep(db, id, "verify_gone", err, duration)
		}
		duration := time.Since(start).Milliseconds()
		if err := completeTeardownStep(db, id, "verify_gone", "teardown_verified_gone_at", "VERIFIED_GONE", "server and port absent", duration); err != nil {
			return nil, err
		}
		result.TimingsMS["verify_gone"] = duration
	}

	if !s.released.Valid {
		if err := beginTeardownStep(db, id, "release_lease"); err != nil {
			return nil, err
		}
		start := time.Now()
		if err := mockTeardownFailure("release_lease"); err != nil {
			return nil, failTeardownStep(db, id, "release_lease", err, time.Since(start).Milliseconds())
		}
		if err := finishTeardownRelease(db, id, s.ip); err != nil {
			return nil, failTeardownStep(db, id, "release_lease", err, time.Since(start).Milliseconds())
		}
		result.TimingsMS["release_lease"] = time.Since(start).Milliseconds()
	}
	result.State = "RELEASED"
	result.TimingsMS["total"] = time.Since(totalStart).Milliseconds()
	return result, nil
}

func recordTeardownRefused(db *sql.DB, id, managedBy string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO events(ts_ms,sandbox_id,type,detail,duration_ms)
		SELECT ?,?,?,?,0 WHERE NOT EXISTS (
			SELECT 1 FROM events WHERE sandbox_id=? AND type='TEARDOWN_REFUSED'
		)`, time.Now().UTC().UnixMilli(), id, "TEARDOWN_REFUSED",
		fmt.Sprintf("reason=ownership_guard managed_by=%s", managedBy), id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func zeroTeardownTimings() map[string]int64 {
	return map[string]int64{"mark_tearing_down": 0, "remove_route": 0, "delete_server": 0, "delete_port": 0, "verify_gone": 0, "release_lease": 0, "total": 0}
}

func mockTeardownFailure(step string) error {
	if mock, ok := provisioner.(*MockProvisioner); ok {
		return mock.FailStep(step)
	}
	return nil
}

func beginTeardownStep(db *sql.DB, id, step string) error {
	_, err := db.Exec(`UPDATE sandboxes SET teardown_step=?,teardown_attempts=teardown_attempts+1,
		teardown_step_attempts=teardown_step_attempts+1,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=? AND status='TEARING_DOWN'`, step, id)
	return err
}

func completeTeardownStep(db *sql.DB, id, step, timestampColumn, event, detail string, duration int64) error {
	// timestampColumn is selected only from hard-coded call sites.
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE sandboxes SET teardown_step=?,`+timestampColumn+`=?,teardown_step_attempts=0,
		teardown_last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=? AND status='TEARING_DOWN'`, step, nowUnix(), id)
	if err == nil {
		recordEvent(tx, id, event, detail, duration)
	}
	if err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func failTeardownStep(db *sql.DB, id, step string, cause error, duration int64) error {
	if cause == nil {
		cause = errors.New("unknown teardown failure")
	}
	tx, err := db.Begin()
	if err != nil {
		return &teardownStepError{Step: step, Err: err}
	}
	var attempts int
	if err = tx.QueryRow(`SELECT teardown_step_attempts FROM sandboxes WHERE sandbox_id=?`, id).Scan(&attempts); err == nil {
		_, err = tx.Exec(`UPDATE sandboxes SET teardown_step=?,teardown_last_error=?,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=?`, step, cause.Error(), id)
	}
	if err != nil {
		tx.Rollback()
		return &teardownStepError{Step: step, Err: errors.Join(cause, err)}
	}
	if attempts >= teardownMaxAttempts {
		_, err = tx.Exec(`UPDATE sandboxes SET status='TEARDOWN_FAILED' WHERE sandbox_id=? AND status='TEARING_DOWN'`, id)
		if err == nil {
			recordEvent(tx, id, "TEARDOWN_FAILED", fmt.Sprintf("step=%s error=%s", step, cause.Error()), duration)
			teardownFailures.Add(1)
		}
	}
	if err != nil {
		tx.Rollback()
		return &teardownStepError{Step: step, Err: errors.Join(cause, err)}
	}
	if err := tx.Commit(); err != nil {
		return &teardownStepError{Step: step, Err: errors.Join(cause, err)}
	}
	return &teardownStepError{Step: step, Err: cause}
}

func verifySandboxResourcesGone(ctx context.Context, p Provisioner, serverID, portID string) error {
	if serverID == "" && portID == "" {
		return nil
	}
	if p == nil {
		return errors.New("provisioner is not configured")
	}
	if serverID != "" {
		status, err := p.GetServer(ctx, serverID)
		if err != nil && !errors.Is(err, ErrOpenStackNotFound) {
			return fmt.Errorf("verify Nova server: %w", err)
		}
		if err == nil && !strings.EqualFold(status, "DELETED") {
			return fmt.Errorf("Nova server %s still exists with status %s", serverID, status)
		}
	}
	if portID != "" {
		ports, err := p.ListSandboxPorts(ctx)
		if err != nil {
			return fmt.Errorf("list Neutron sandbox ports: %w", err)
		}
		for _, port := range ports {
			if port.ID == portID {
				return fmt.Errorf("Neutron port %s still exists", portID)
			}
		}
	}
	return nil
}

func finishTeardownRelease(db *sql.DB, id, ip string) error {
	start := time.Now()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Unix(nowUnix(), 0).UTC()
	quarantineAt := now.Format("2006-01-02 15:04:05")
	quarantineUntil := now.Add(time.Duration(defaultQuarantineSeconds) * time.Second).Format("2006-01-02 15:04:05")
	if _, err := tx.Exec(`UPDATE ip_allocations SET status='QUARANTINED',quarantined_at=?,quarantine_until=?
		WHERE entity_name=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED'`, quarantineAt, quarantineUntil, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE sandboxes SET status='RELEASED',private_ip=NULL,teardown_step='release_lease',
		teardown_released_at=?,teardown_step_attempts=0,teardown_last_error=NULL,updated_at=CURRENT_TIMESTAMP
		WHERE sandbox_id=? AND status='TEARING_DOWN'`, nowUnix(), id); err != nil {
		return err
	}
	recordEvent(tx, id, "RELEASED", fmt.Sprintf("ip=%s,cooldown=%d", ip, defaultQuarantineSeconds), time.Since(start).Milliseconds())
	return tx.Commit()
}

func handleSandboxTeardown(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sandboxes/")
	if strings.HasSuffix(id, "/teardown") {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var request struct{}
		if err := decodeStrictJSON(w, r, &request); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request payload"})
			return
		}
		id = strings.TrimSuffix(id, "/teardown")
	} else if r.Method != http.MethodDelete {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	if !dnsLabelRE.MatchString(id) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sandbox id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), teardownTimeout)
	defer cancel()
	result, err := teardownSandbox(ctx, id)
	if err != nil {
		if errors.Is(err, ErrSandboxNotFound) {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": err.Error(), "sandbox_id": id})
			return
		}
		if errors.Is(err, errTeardownRefused) {
			sendJSON(w, http.StatusForbidden, map[string]string{"error": err.Error(), "step": "guard", "sandbox_id": id})
			return
		}
		if errors.Is(err, errTeardownInProgress) {
			sendJSON(w, http.StatusAccepted, map[string]string{"sandbox_id": id, "state": "TEARING_DOWN"})
			return
		}
		var stepErr *teardownStepError
		step := "teardown"
		if errors.As(err, &stepErr) {
			step = stepErr.Step
		}
		sendJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error(), "step": step, "sandbox_id": id})
		return
	}
	sendJSON(w, http.StatusOK, result)
}
