import { useState, useCallback, useEffect, useRef } from 'react'
import { fetchLogs, type LogsResponse } from '../api'

export default function TrafficLogs() {
  const [gateway, setGateway] = useState('gw1')
  const [source, setSource] = useState('haproxy')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [logs, setLogs] = useState<LogsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const doFetch = useCallback(async () => {
    try {
      const data = await fetchLogs(gateway, source, 100)
      setLogs(data)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Failed to fetch logs')
    }
  }, [gateway, source])

  useEffect(() => {
    doFetch()
    if (!autoRefresh) return
    const id = setInterval(doFetch, 3000)
    return () => clearInterval(id)
  }, [doFetch, autoRefresh])

  useEffect(() => {
    if (autoRefresh && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoRefresh])

  function getLineColor(line: string): string {
    if (/ 5\d{2} /.test(line)) return 'var(--color-danger)'
    if (/ 4\d{2} /.test(line)) return 'var(--color-warning)'
    if (/ [23]\d{2} /.test(line)) return 'var(--color-success)'
    return 'var(--color-text-secondary)'
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl border" style={{ background: 'var(--color-bg-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--color-bg-input)' }}>
          {['gw1', 'gw2'].map(gw => (
            <button
              key={gw}
              onClick={() => setGateway(gw)}
              className={`px-4 py-2 rounded-md text-xs font-semibold transition-all ${
                gateway === gw ? 'text-white' : 'text-[var(--color-text-muted)] hover:text-white'
              }`}
              style={gateway === gw ? { background: 'var(--color-accent)' } : {}}
            >
              {gw.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--color-bg-input)' }}>
          {['haproxy', 'keepalived'].map(s => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`px-4 py-2 rounded-md text-xs font-semibold transition-all ${
                source === s ? 'text-white' : 'text-[var(--color-text-muted)] hover:text-white'
              }`}
              style={source === s ? { background: 'var(--color-accent)' } : {}}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
          />
          Auto-refresh (3s)
        </label>

        <button
          onClick={doFetch}
          className="px-4 py-2 rounded-lg text-xs font-medium text-[var(--color-text-secondary)] border transition-all hover:bg-white/5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg text-sm text-red-400 bg-red-400/10">{error}</div>
      )}

      {/* Log viewer */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--color-bg-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{gateway.toUpperCase()} — {source}</h3>
            {autoRefresh && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-success)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">{logs?.count ?? 0} lines</span>
        </div>
        <div className="overflow-y-auto max-h-[calc(100vh-320px)] p-4 font-mono text-xs leading-relaxed" style={{ background: '#0c0f1a' }}>
          {(logs?.entries ?? []).map((line, i) => (
            <div key={i} className="py-0.5 hover:bg-white/[0.03] px-2 rounded transition-colors" style={{ color: getLineColor(line) }}>
              <span className="text-[var(--color-text-muted)] mr-3 select-none inline-block w-8 text-right">{i + 1}</span>
              {line}
            </div>
          ))}
          {(!logs?.entries || logs.entries.length === 0) && (
            <p className="text-[var(--color-text-muted)] text-center py-8">No log entries</p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}
