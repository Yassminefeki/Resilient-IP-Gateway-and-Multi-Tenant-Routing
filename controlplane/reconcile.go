package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type ReconcileItem struct {
	SandboxID string `json:"sandbox_id,omitempty"`
	IP        string `json:"ip,omitempty"`
	NeutronIP string `json:"neutron_ip,omitempty"`
	PortID    string `json:"port_id,omitempty"`
	PortName  string `json:"port_name,omitempty"`
	ServerID  string `json:"server_id,omitempty"`
}

type ReconcileReport struct {
	MissingNeutronPorts []ReconcileItem `json:"db_lease_without_neutron_port"`
	OrphanNeutronPorts  []ReconcileItem `json:"neutron_port_without_db_lease"`
	IPMismatches        []ReconcileItem `json:"ip_mismatch"`
	MissingServers      []ReconcileItem `json:"provisioned_server_missing"`
	OrphanNovaServers   []SandboxServer `json:"nova_server_without_db_lease"`
}

type ReconcileAction struct {
	Type      string `json:"type"`
	SandboxID string `json:"sandbox_id"`
}

type reconcileRequest struct {
	Actions []ReconcileAction `json:"actions"`
}

func sandboxNameFromPort(name string) (string, bool) {
	name = strings.TrimSpace(name)
	switch {
	case strings.HasPrefix(name, "sandbox-"):
		return strings.TrimPrefix(name, "sandbox-"), true
	case strings.HasSuffix(name, "-sandbox-port"):
		return strings.TrimSuffix(name, "-sandbox-port"), true
	case strings.HasSuffix(name, "-sandbox"):
		return strings.TrimSuffix(name, "-sandbox"), true
	default:
		return "", false
	}
}

func reconcileNeutron(ctx context.Context, db *sql.DB, p Provisioner) (ReconcileReport, error) {
	report := ReconcileReport{
		MissingNeutronPorts: []ReconcileItem{},
		OrphanNeutronPorts:  []ReconcileItem{},
		IPMismatches:        []ReconcileItem{},
		MissingServers:      []ReconcileItem{},
		OrphanNovaServers:   []SandboxServer{},
	}
	if p == nil {
		return report, errors.New("provisioner is not configured")
	}
	ports, err := p.ListSandboxPorts(ctx)
	if err != nil {
		return report, fmt.Errorf("list Neutron sandbox ports: %w", err)
	}
	dbLeases := map[string]string{}
	rows, err := db.Query(`SELECT entity_name,ip_address FROM ip_allocations WHERE status='ALLOCATED' AND entity_type='TEAM_SANDBOX'`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var name, ip string
		if err := rows.Scan(&name, &ip); err != nil {
			rows.Close()
			return report, err
		}
		dbLeases[name] = ip
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return report, err
	}
	rows.Close()

	portsByName := map[string]SandboxPort{}
	for _, port := range ports {
		name, ok := sandboxNameFromPort(port.Name)
		if !ok {
			continue
		}
		portsByName[name] = port
		neutronIP := firstFixedIP(port.FixedIPs)
		dbIP, exists := dbLeases[name]
		if !exists {
			report.OrphanNeutronPorts = append(report.OrphanNeutronPorts, ReconcileItem{SandboxID: name, NeutronIP: neutronIP, PortID: port.ID, PortName: port.Name})
			continue
		}
		if dbIP != neutronIP {
			report.IPMismatches = append(report.IPMismatches, ReconcileItem{SandboxID: name, IP: dbIP, NeutronIP: neutronIP, PortID: port.ID, PortName: port.Name})
		}
	}
	for name, ip := range dbLeases {
		if _, ok := portsByName[name]; !ok {
			report.MissingNeutronPorts = append(report.MissingNeutronPorts, ReconcileItem{SandboxID: name, IP: ip})
		}
	}

	rows, err = db.Query(`SELECT sandbox_id,server_id FROM sandboxes WHERE status NOT IN ('RELEASED','FAILED','TEARDOWN_FAILED') AND COALESCE(server_id,'')<>''`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var id, serverID string
		if err := rows.Scan(&id, &serverID); err != nil {
			return report, err
		}
		status, err := p.GetServer(ctx, serverID)
		if errors.Is(err, ErrOpenStackNotFound) || err == nil && strings.EqualFold(status, "DELETED") {
			report.MissingServers = append(report.MissingServers, ReconcileItem{SandboxID: id, ServerID: serverID})
		} else if err != nil {
			return report, fmt.Errorf("check Nova server %s: %w", serverID, err)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return report, err
	}
	rows.Close()
	servers, err := p.ListSandboxServers(ctx)
	if err != nil {
		return report, fmt.Errorf("list Nova sandbox servers: %w", err)
	}
	knownServerIDs := make(map[string]bool)
	rows, err = db.Query(`SELECT COALESCE(server_id,'') FROM sandboxes WHERE COALESCE(server_id,'')<>''`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return report, err
		}
		knownServerIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return report, err
	}
	rows.Close()
	for _, server := range servers {
		if !knownServerIDs[server.ID] {
			report.OrphanNovaServers = append(report.OrphanNovaServers, server)
		}
	}
	return report, nil
}

func firstFixedIP(ips []string) string {
	if len(ips) == 0 {
		return ""
	}
	return ips[0]
}

func reconcileReport(ctx context.Context) (ReconcileReport, error) {
	db, err := getDBConnection()
	if err != nil {
		return ReconcileReport{}, err
	}
	defer db.Close()
	return reconcileNeutron(ctx, db, provisioner)
}

func handleReconcile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	report, err := reconcileReport(ctx)
	if err != nil {
		sendJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, report)
}

func handleReconcileApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	var request reconcileRequest
	if err := decodeStrictJSON(w, r, &request); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request payload"})
		return
	}
	if len(request.Actions) == 0 {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "actions must not be empty"})
		return
	}
	db, err := getDBConnection()
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	report, err := reconcileNeutron(ctx, db, provisioner)
	if err != nil {
		sendJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	applied := make([]map[string]string, 0, len(request.Actions))
	for _, action := range request.Actions {
		if !dnsLabelRE.MatchString(action.SandboxID) {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "action sandbox_id must be a lowercase DNS label"})
			return
		}
		switch action.Type {
		case "update_ip":
			item, ok := findReconcileItem(report.IPMismatches, action.SandboxID)
			if !ok {
				sendJSON(w, http.StatusConflict, map[string]string{"error": "no current IP mismatch for sandbox", "sandbox_id": action.SandboxID})
				return
			}
			if err := applyReconcileIPUpdate(db, item); err != nil {
				sendJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "sandbox_id": action.SandboxID})
				return
			}
			applied = append(applied, map[string]string{"type": action.Type, "sandbox_id": action.SandboxID, "ip": item.NeutronIP})
		case "mark_failed", "mark_released":
			item, ok := findReconcileItem(report.MissingServers, action.SandboxID)
			if !ok {
				sendJSON(w, http.StatusConflict, map[string]string{"error": "no current missing provisioned server for sandbox", "sandbox_id": action.SandboxID})
				return
			}
			if err := applyMissingServerAction(db, action.SandboxID, action.Type); err != nil {
				sendJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "sandbox_id": action.SandboxID})
				return
			}
			applied = append(applied, map[string]string{"type": action.Type, "sandbox_id": item.SandboxID})
		default:
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported reconcile action type"})
			return
		}
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"applied": applied})
}

func findReconcileItem(items []ReconcileItem, id string) (ReconcileItem, bool) {
	for _, item := range items {
		if item.SandboxID == id {
			return item, true
		}
	}
	return ReconcileItem{}, false
}

func applyReconcileIPUpdate(db *sql.DB, item ReconcileItem) error {
	var cidr, gatewayIP string
	if err := db.QueryRow(`SELECT subnets.cidr,subnets.gateway_ip
		FROM sandboxes JOIN subnets ON subnets.name=sandboxes.subnet_name
		WHERE sandboxes.sandbox_id=?`, item.SandboxID).Scan(&cidr, &gatewayIP); err != nil {
		return fmt.Errorf("read sandbox subnet for reconciliation: %w", err)
	}
	if err := validateSandboxIP(cidr, gatewayIP, item.NeutronIP); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldIP, entityType string
	if err := tx.QueryRow(`SELECT ip_address,entity_type FROM ip_allocations WHERE entity_name=? AND status='ALLOCATED' AND entity_type='TEAM_SANDBOX'`, item.SandboxID).Scan(&oldIP, &entityType); err != nil {
		return err
	}
	var targetOwner, targetType string
	err = tx.QueryRow(`SELECT entity_name,entity_type FROM ip_allocations WHERE ip_address=?`, item.NeutronIP).Scan(&targetOwner, &targetType)
	targetExists := err == nil
	if targetExists && (targetOwner != item.SandboxID || targetType != "TEAM_SANDBOX") {
		return fmt.Errorf("Neutron IP %s is allocated to protected or different entity %s (%s)", item.NeutronIP, targetOwner, targetType)
	}
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if oldIP != item.NeutronIP {
		now := time.Now().UTC()
		quarantineAt := now.Format("2006-01-02 15:04:05")
		quarantineUntil := now.Add(time.Duration(defaultQuarantineSeconds) * time.Second).Format("2006-01-02 15:04:05")
		if _, err := tx.Exec(`UPDATE ip_allocations SET status='QUARANTINED',quarantined_at=?,quarantine_until=? WHERE ip_address=? AND entity_name=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED'`, quarantineAt, quarantineUntil, oldIP, item.SandboxID); err != nil {
			return err
		}
		if targetExists {
			if _, err := tx.Exec(`UPDATE ip_allocations SET status='ALLOCATED',quarantined_at=NULL,quarantine_until=NULL,assigned_at=CURRENT_TIMESTAMP WHERE ip_address=? AND entity_name=? AND entity_type='TEAM_SANDBOX'`, item.NeutronIP, item.SandboxID); err != nil {
				return err
			}
		} else if _, err := tx.Exec(`INSERT INTO ip_allocations(ip_address,subnet_name,entity_name,entity_type,status) VALUES(?, 'sandbox', ?, 'TEAM_SANDBOX', 'ALLOCATED')`, item.NeutronIP, item.SandboxID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE sandboxes SET private_ip=?,fixed_ip=?,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=?`, item.NeutronIP, item.NeutronIP, item.SandboxID); err != nil {
		return err
	}
	recordEvent(tx, item.SandboxID, "RECONCILE_IP_UPDATED", fmt.Sprintf("from=%s to=%s", oldIP, item.NeutronIP), 0)
	return tx.Commit()
}

func applyMissingServerAction(db *sql.DB, id, action string) error {
	target := "FAILED"
	if action == "mark_released" {
		target = "RELEASED"
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var ip string
	if err := tx.QueryRow(`SELECT COALESCE(private_ip,'') FROM sandboxes WHERE sandbox_id=? AND COALESCE(server_id,'')<>'' AND status IN ('ACTIVE','PROVISIONING')`, id).Scan(&ip); err != nil {
		return err
	}
	if target == "RELEASED" {
		now := time.Now().UTC()
		qAt := now.Format("2006-01-02 15:04:05")
		qUntil := now.Add(time.Duration(defaultQuarantineSeconds) * time.Second).Format("2006-01-02 15:04:05")
		if _, err := tx.Exec(`UPDATE ip_allocations SET status='QUARANTINED',quarantined_at=?,quarantine_until=? WHERE entity_name=? AND entity_type='TEAM_SANDBOX' AND status='ALLOCATED'`, qAt, qUntil, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE sandboxes SET status=?,private_ip=CASE WHEN ?='RELEASED' THEN NULL ELSE private_ip END,updated_at=CURRENT_TIMESTAMP WHERE sandbox_id=? AND COALESCE(server_id,'')<>'' AND status IN ('ACTIVE','PROVISIONING')`, target, target, id); err != nil {
		return err
	}
	recordEvent(tx, id, "RECONCILE_SERVER_MISSING", fmt.Sprintf("action=%s ip=%s", action, ip), 0)
	return tx.Commit()
}
