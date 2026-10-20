package main

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	gatewayOpMu      sync.Mutex
	errGatewayOpBusy = errors.New("gateway operation already running")
)

func gatewayOpTTLSeconds() int64 {
	v := strings.TrimSpace(os.Getenv("GATEWAY_OP_TTL_SECONDS"))
	if v == "" {
		return 300
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return 300
	}
	return n
}

func tryGatewayOp(name string) error {
	if !gatewayOpMu.TryLock() {
		return errGatewayOpBusy
	}

	db, err := getDBConnection()
	if err != nil {
		gatewayOpMu.Unlock()
		return err
	}
	defer db.Close()

	leaseTTL := gatewayOpTTLSeconds()
	now := time.Now().Unix()
	var holder sql.NullString
	var expiresAt sql.NullInt64
	if err := db.QueryRow(`SELECT holder, expires_at FROM gateway_lock WHERE id = 1`).Scan(&holder, &expiresAt); err != nil && !errors.Is(err, sql.ErrNoRows) {
		gatewayOpMu.Unlock()
		return err
	}
	if err == nil && holder.Valid && holder.String != "" && (!expiresAt.Valid || expiresAt.Int64 > now) {
		gatewayOpMu.Unlock()
		return errGatewayOpBusy
	}

	if _, err = db.Exec(`INSERT INTO gateway_lock (id, holder, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`, name, now+leaseTTL); err != nil {
		gatewayOpMu.Unlock()
		return err
	}
	return nil
}

func syncLocked(trigger string, dryRun bool) (bool, string, int64, error) {
	if err := tryGatewayOp("sync:" + trigger); err != nil {
		return false, "", 0, err
	}
	defer releaseGatewayOp("sync:" + trigger)
	ok, msg, duration := syncHAProxyDualGatewaysTimed(dryRun, trigger)
	return ok, msg, duration, nil
}

func rollbackLocked(targetGeneration, trigger, reason string) (string, int64, error) {
	if err := tryGatewayOp("rollback:" + trigger); err != nil {
		return "", 0, err
	}
	defer releaseGatewayOp("rollback:" + trigger)
	return rollbackConfigWithOptions(targetGeneration, trigger, reason)
}

func waitGatewayOp(name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if err := tryGatewayOp(name); err == nil {
			return nil
		}
		if time.Now().After(deadline) || time.Now().Equal(deadline) {
			return errGatewayOpBusy
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func releaseGatewayOp(name string) {
	db, err := getDBConnection()
	if err == nil {
		_, _ = db.Exec(`UPDATE gateway_lock SET holder = NULL, expires_at = NULL WHERE id = 1 AND holder = ?`, name)
		_ = db.Close()
	}
	gatewayOpMu.Unlock()
}

func tryGatewaySync(dryRun bool) (bool, string, int64) {
	return syncHAProxyDualGatewaysTimed(dryRun, "manual")
}

func tryGatewayRollback(targetGeneration, trigger, reason string) (string, int64, error) {
	return rollbackConfigWithOptions(targetGeneration, trigger, reason)
}

func gatewayLockError() error {
	return fmt.Errorf("gateway operation already running: %w", errGatewayOpBusy)
}
