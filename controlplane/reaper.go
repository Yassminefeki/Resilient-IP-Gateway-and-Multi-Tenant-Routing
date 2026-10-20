package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

type tickResult struct {
	ReapedCount  int
	ResumedCount int
	FailedCount  int
	PrunedEvents int
	Error        error
}

type sandboxRef struct {
	id         string
	hostname   string
	subnetName string
	privateIP  string
	status     string
	expiresAt  *int64
}

func ensureTeardownColumns(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(sandboxes)`)
	if err != nil {
		return err
	}
	cols := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var def any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &def, &pk); err != nil {
			rows.Close()
			return err
		}
		cols[name] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	columns := map[string]string{
		"managed_by":                    "TEXT NOT NULL DEFAULT 'external'",
		"teardown_step":                 "TEXT NOT NULL DEFAULT ''",
		"teardown_attempts":             "INTEGER NOT NULL DEFAULT 0",
		"teardown_step_attempts":        "INTEGER NOT NULL DEFAULT 0",
		"teardown_started_at":           "INTEGER",
		"teardown_route_removed_at":     "INTEGER",
		"teardown_resources_deleted_at": "INTEGER",
		"teardown_verified_gone_at":     "INTEGER",
		"teardown_released_at":          "INTEGER",
		"teardown_last_error":           "TEXT",
	}
	for name, decl := range columns {
		if !cols[name] {
			if _, err := db.Exec(`ALTER TABLE sandboxes ADD COLUMN ` + name + ` ` + decl); err != nil {
				return err
			}
		}
	}
	return nil
}

func isValidTransition(from, to string) bool {
	switch from {
	case "PROVISIONING":
		return to == "ACTIVE" || to == "FAILED"
	case "ACTIVE":
		return to == "EXPIRING" || to == "TEARING_DOWN"
	case "EXPIRING":
		return to == "TEARING_DOWN"
	case "TEARING_DOWN":
		return to == "RELEASED" || to == "FAILED" || to == "TEARDOWN_FAILED"
	case "TEARDOWN_FAILED":
		return to == "TEARING_DOWN"
	case "FAILED":
		return to == "TEARING_DOWN"
	case "REQUESTED", "FAILED_HEALTH_CHECK", "ROLLBACK":
		return to == "TEARING_DOWN"
	default:
		return false
	}
}

func transitionSandbox(q DBQueryer, id, to string) error {
	if db, ok := q.(*sql.DB); ok {
		// Wrap in an immediate transaction for true atomicity under concurrency.
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("transitionSandbox: begin tx for '%s': %w", id, err)
		}
		defer tx.Rollback()
		if err := transitionSandbox(tx, id, to); err != nil {
			return err
		}
		return tx.Commit()
	}

	var currentStatus string
	err := q.QueryRow("SELECT status FROM sandboxes WHERE sandbox_id = ?", id).Scan(&currentStatus)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("%w: sandbox '%s'", ErrSandboxNotFound, id)
		}
		return fmt.Errorf("failed to query sandbox '%s': %w", id, err)
	}

	if !isValidTransition(currentStatus, to) {
		return fmt.Errorf("%w for sandbox '%s': '%s' -> '%s'", ErrIllegalTransition, id, currentStatus, to)
	}

	res, err := q.Exec("UPDATE sandboxes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE sandbox_id = ? AND status = ?", to, id, currentStatus)
	if err != nil {
		return fmt.Errorf("failed to update status for sandbox '%s': %w", id, err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check affected rows for sandbox '%s': %w", id, err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: sandbox '%s' (expected status '%s')", ErrTransitionConflict, id, currentStatus)
	}

	return nil
}

func reaperTick(db *sql.DB, now int64) tickResult {
	reaperTickMutex.Lock()
	defer reaperTickMutex.Unlock()
	return reaperTickInner(db, now)
}

func reaperTickInner(db *sql.DB, now int64) tickResult {
	tickStart := time.Now()
	res := tickResult{}

	// a. Reclaim expired quarantines
	reclaimExpiredQuarantinesTx(db)
	recoverStaleProvisioning(db, now, &res)

	// Update oldestOverdueSeconds gauge
	var minExp sql.NullInt64
	_ = db.QueryRow("SELECT MIN(expires_at) FROM sandboxes WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?", now).Scan(&minExp)
	if minExp.Valid && minExp.Int64 <= now {
		diff := now - minExp.Int64
		if diff < 0 {
			diff = 0
		}
		oldestOverdueSeconds.Store(diff)
	} else {
		oldestOverdueSeconds.Store(0)
	}

	// b. Select up to REAPER_BATCH_SIZE sandboxes
	rows, err := db.Query(`
		SELECT sandbox_id, hostname, subnet_name, COALESCE(private_ip, ''), status, expires_at
		FROM sandboxes
		WHERE ((status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?)
		   OR status IN ('EXPIRING', 'TEARING_DOWN'))
		AND (COALESCE(managed_by,'external')='control-plane' OR NOT EXISTS (
			SELECT 1 FROM events refused WHERE refused.sandbox_id=sandboxes.sandbox_id AND refused.type='TEARDOWN_REFUSED'
		))
		ORDER BY CASE WHEN expires_at IS NOT NULL THEN expires_at ELSE 0 END ASC, id ASC
		LIMIT ?;
	`, now, reaperBatchSize)
	if err != nil {
		res.Error = err
		return res
	}
	defer rows.Close()

	var candidates []sandboxRef
	for rows.Next() {
		var s sandboxRef
		var exp sql.NullInt64
		if err := rows.Scan(&s.id, &s.hostname, &s.subnetName, &s.privateIP, &s.status, &exp); err != nil {
			continue
		}
		if exp.Valid {
			v := exp.Int64
			s.expiresAt = &v
		}
		candidates = append(candidates, s)
	}
	rows.Close()

	// c. Process candidates through the same durable teardown path as the API.
	var wg sync.WaitGroup
	var resultMu sync.Mutex
	workerCount := teardownConcurrency
	if workerCount < 1 {
		workerCount = 1
	}
	sem := make(chan struct{}, workerCount)
	for _, candidate := range candidates {
		s := candidate
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), teardownTimeout)
			defer cancel()
			tdResult, tdErr := teardownSandbox(ctx, s.id)
			resultMu.Lock()
			defer resultMu.Unlock()
			if tdErr != nil {
				if errors.Is(tdErr, errTeardownInProgress) {
					return
				}
				log.Printf("reaper: teardown failed for '%s': %v", s.id, tdErr)
				var stepErr *teardownStepError
				if errors.As(tdErr, &stepErr) {
					var state string
					if err := db.QueryRow(`SELECT status FROM sandboxes WHERE sandbox_id=?`, s.id).Scan(&state); err == nil && state == "TEARDOWN_FAILED" {
						res.FailedCount++
					}
				}
				return
			}
			if tdResult.AlreadyReleased {
				return
			}
			recordEvent(db, s.id, "expired_teardown_done", "teardown completed", 0)
			teardownsDone.Add(1)
			if s.status == "ACTIVE" {
				res.ReapedCount++
			} else {
				res.ResumedCount++
			}
		}()
	}
	wg.Wait()

	// d. Prune events older than EVENTS_RETENTION_SECONDS (ts_ms) in chunks of at most 500 rows per tick
	cutoffMs := (now - int64(eventsRetentionSeconds)) * 1000
	delRes, delErr := db.Exec(`
		DELETE FROM events
		WHERE id IN (
			SELECT id FROM events WHERE ts_ms < ? AND type<>'TEARDOWN_REFUSED' ORDER BY id ASC LIMIT 500
		);
	`, cutoffMs)
	if delErr == nil {
		if n, err := delRes.RowsAffected(); err == nil && n > 0 {
			res.PrunedEvents = int(n)
			eventsPruned.Add(n)
		}
	}

	lastTickUnix.Store(now)
	lastTickDurationMs.Store(time.Since(tickStart).Milliseconds())

	return res
}

func recoverStaleProvisioning(db *sql.DB, now int64, result *tickResult) {
	if provisioner == nil {
		return
	}
	timeoutSeconds := int64((provisionTimeout + 60*time.Second).Seconds())
	cutoff := now - timeoutSeconds
	rows, err := db.Query(`SELECT sandbox_id,COALESCE(private_ip,'')
		FROM sandboxes WHERE status='PROVISIONING' AND CAST(strftime('%s',updated_at) AS INTEGER)<=? LIMIT ?`,
		cutoff, reaperBatchSize)
	if err != nil {
		log.Printf("reaper: list stale provisioning sandboxes: %v", err)
		return
	}
	type staleProvision struct{ team, ip string }
	var stale []staleProvision
	for rows.Next() {
		var item staleProvision
		if err := rows.Scan(&item.team, &item.ip); err != nil {
			rows.Close()
			log.Printf("reaper: read stale provisioning sandbox: %v", err)
			return
		}
		stale = append(stale, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		log.Printf("reaper: iterate stale provisioning sandboxes: %v", err)
		return
	}
	rows.Close()
	for _, item := range stale {
		ctx, cancel := context.WithTimeout(context.Background(), teardownTimeout)
		resources, findErr := provisioner.FindSandboxResources(ctx, item.team)
		cancel()
		if findErr != nil && !errors.Is(findErr, ErrOpenStackNotFound) {
			log.Printf("reaper: find resources for stale provisioning sandbox %q: %v", item.team, findErr)
			continue
		}
		if resources != nil {
			ctx, cancel = context.WithTimeout(context.Background(), teardownTimeout)
			deleteErr := provisioner.DeleteSandbox(ctx, resources.ServerID, resources.PortID)
			cancel()
			if deleteErr != nil {
				log.Printf("reaper: delete resources for stale provisioning sandbox %q: %v", item.team, deleteErr)
				continue
			}
		}
		tx, err := db.Begin()
		if err != nil {
			log.Printf("reaper: begin recovery for stale provisioning sandbox %q: %v", item.team, err)
			continue
		}
		update, err := tx.Exec(`UPDATE sandboxes SET status='FAILED',updated_at=CURRENT_TIMESTAMP
			WHERE sandbox_id=? AND status='PROVISIONING'`, item.team)
		if err == nil {
			var changed int64
			changed, err = update.RowsAffected()
			if err == nil && changed == 0 {
				err = errProvisionClaimed
			}
		}
		if err == nil && item.ip != "" {
			until := time.Unix(now, 0).UTC().Add(time.Duration(defaultQuarantineSeconds) * time.Second).Format("2006-01-02 15:04:05")
			at := time.Unix(now, 0).UTC().Format("2006-01-02 15:04:05")
			_, err = tx.Exec(`UPDATE ip_allocations SET status='QUARANTINED',quarantined_at=?,quarantine_until=?
				WHERE entity_name=? AND ip_address=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED'`, at, until, item.team, item.ip)
		}
		if err == nil {
			recordEvent(tx, item.team, "PROVISION_RECOVERED", "stale PROVISIONING resources cleaned up", 0)
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			log.Printf("reaper: recover stale provisioning sandbox %q: %v", item.team, err)
			continue
		}
		result.FailedCount++
	}
}

func startReaper(ctx context.Context, dbs ...*sql.DB) (<-chan struct{}, error) {
	var db *sql.DB
	var err error
	if len(dbs) > 0 && dbs[0] != nil {
		db = dbs[0]
	} else {
		db, err = getDBConnection()
		if err != nil {
			return nil, err
		}
	}
	done := make(chan struct{})
	interval := time.Duration(reaperIntervalSeconds) * time.Second
	log.Printf("Starting background reaper loop (interval: %v, batch: %d, max_attempts: %d)", interval, reaperBatchSize, teardownMaxAttempts)
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("reaper: recovered from panic: %v", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("reaper tick recovered from panic: %v", r)
						}
					}()
					reaperTick(db, nowUnix())
				}()
			}
		}
	}()
	return done, nil
}
