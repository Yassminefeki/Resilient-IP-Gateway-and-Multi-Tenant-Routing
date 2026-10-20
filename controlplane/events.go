package main

import (
	"log"
	"net/http"
	"strconv"
	"time"
)

func recordEventForSandbox(sandboxID, typ, detail string, durationMs int64) {
	db, err := getDBConnection()
	if err != nil {
		log.Printf("WARNING: recordEvent(%s, %s): %v", typ, sandboxID, err)
		return
	}
	defer db.Close()
	recordEvent(db, sandboxID, typ, detail, durationMs)
}

func recordEvent(q DBQueryer, sandboxID, typ, detail string, durationMs int64) {
	tsMs := time.Now().UTC().UnixMilli()
	var sID, det interface{}
	if sandboxID != "" {
		sID = sandboxID
	}
	if detail != "" {
		det = detail
	}
	_, err := q.Exec(`
		INSERT INTO events (ts_ms, sandbox_id, type, detail, duration_ms)
		VALUES (?, ?, ?, ?, ?)
	`, tsMs, sID, typ, det, durationMs)
	if err != nil {
		log.Printf("WARNING: recordEvent(%s, %s): %v", typ, sandboxID, err)
	}
}

func handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	limit := 50
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			if l < 1 {
				limit = 1
			} else if l > 500 {
				limit = 500
			} else {
				limit = l
			}
		}
	}

	db, err := getDBConnection()
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT id, ts_ms, COALESCE(sandbox_id, ''), type, COALESCE(detail, ''), COALESCE(duration_ms, 0)
		FROM events
		ORDER BY ts_ms DESC, id DESC
		LIMIT ?
	`, limit)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	var eventsList []map[string]interface{}
	for rows.Next() {
		var id int
		var tsMs, durMs int64
		var sID, typ, det string
		if err := rows.Scan(&id, &tsMs, &sID, &typ, &det, &durMs); err == nil {
			eventsList = append(eventsList, map[string]interface{}{
				"id":          id,
				"ts_ms":       tsMs,
				"sandbox_id":  sID,
				"type":        typ,
				"detail":      det,
				"duration_ms": durMs,
			})
		}
	}

	if eventsList == nil {
		eventsList = []map[string]interface{}{}
	}

	sendJSON(w, http.StatusOK, eventsList)
}
