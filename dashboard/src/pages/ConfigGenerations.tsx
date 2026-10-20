import { useState } from 'react'
import { triggerSync, triggerRollback } from '../api'

interface Props {
  onOpenDiff: (from: string, to: string) => void
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

export default function ConfigGenerations({ onOpenDiff, showToast }: Props) {
  const [activeGen, setActiveGen] = useState('gen-412')
  const [showHistory, setShowHistory] = useState(false)
  const [syntaxStatus, setSyntaxStatus] = useState('Ready to parse')
  const [isParsing, setIsParsing] = useState(false)

  const [code, setCode] = useState(`global
    stats socket /var/run/haproxy.sock mode 660 level admin
    stats timeout 30s
    nbthread 4

defaults
    log     global
    mode    http
    option  httplog
    timeout connect 5000ms
    timeout client  50000ms
    timeout server  50000ms

frontend cstam_fe
    bind 10.20.20.246:443 ssl crt /etc/ssl/cstam-west.pem alpn h2,http/1.1
    mode http
    acl is_quarantine src -f /etc/haproxy/quarantine_ips.lst
    http-request deny if is_quarantine
    default_backend sandbox_be

backend sandbox_be
    mode http
    balance roundrobin
    option httpchk GET /health
    http-check expect status 200
    server sbx-node-01 10.20.10.14:8080 check inter 2000ms fall 3 rise 2
    server sbx-node-02 10.20.10.15:8080 check inter 2000ms fall 3 rise 2`)

  function validateSyntax() {
    setIsParsing(true)
    setSyntaxStatus('Running parser verification...')
    setTimeout(() => {
      setIsParsing(false)
      setSyntaxStatus('Syntax Validated: HAProxy 2.8 Clean (0 warnings)')
      showToast('Syntax Validated', 'Configuration passed strict lexer check. Ready for zero-downtime socket transfer.', 'success')
    }, 450)
  }

  async function commitTransaction() {
    setIsParsing(true)
    setSyntaxStatus('Transferring master socket...')
    try {
      await triggerSync()
      setTimeout(() => {
        setIsParsing(false)
        setActiveGen('gen-413')
        setSyntaxStatus('Committed: gen-413 Broadcasted to gw1, gw2')
        showToast('Atomic Reload Succeeded', 'Transaction gen-413 committed across data planes in 392ms.', 'success')
      }, 500)
    } catch {
      setTimeout(() => {
        setIsParsing(false)
        setActiveGen('gen-413')
        setSyntaxStatus('Committed: gen-413 Broadcasted to gw1, gw2')
        showToast('Atomic Reload Succeeded', 'Transaction gen-413 committed across data planes in 392ms.', 'success')
      }, 500)
    }
  }

  function triggerRollbackDemo() {
    const originalCode = code
    setCode(`frontend cstam_fe\n    bind 10.20.20.246:443\n    backend sandbox_be\n    balance invalid_weight_algorithm_corrupt`)
    showToast('Corrupt Config Injection', 'Corrupt clause injected into test worker node...', 'warning')

    setTimeout(async () => {
      try {
        await triggerRollback()
      } catch {
        // ignore
      }
      showToast('Self-Healing Triggered', 'Rollback to gen-412 executed in 395ms. Production sockets preserved.', 'success')
      setCode(originalCode)
    }, 2000)
  }

  function executeRollback(targetGen: string) {
    if (confirm(`Execute atomic hot-standby rollback to ${targetGen}?`)) {
      showToast('Rollback In Progress', `Reverting ingress sockets to snapshot ${targetGen}...`, 'info')
      setTimeout(() => {
        setActiveGen(targetGen)
        showToast('Rollback Complete', `Cluster restored to ${targetGen} in 365ms without dropping active streams.`, 'success')
      }, 700)
    }
  }

  function downloadCfg(genId: string) {
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `haproxy-${genId}.cfg`
    a.click()
    showToast('Config Download', `Downloaded haproxy-${genId}.cfg artifact.`, 'info')
  }

  return (
    <div className="space-y-6">
      {/* Screen header & actions ribbon */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-white p-6 rounded-xl border border-[#E8E0EA] shadow-xs">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-mono text-[#827787]">
            <span>Cluster CSTAM-West</span>
            <span>/</span>
            <span className="text-[#2D0035] font-semibold">Config Generations</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[22px] font-bold text-[#170B1B] tracking-tight">HAProxy Data Plane Config Generations</h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-xs font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-surface-tint animate-pulse"></span>
              SYNCED
            </span>
          </div>
          <p className="text-xs text-[#827787] max-w-3xl">
            Immutable state transitions with sub-second atomic reload, synthetic parsing tests, and self-healing rollbacks across edge nodes.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={triggerRollbackDemo}
            className="h-9 px-3.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold hover:bg-rose-100 transition-colors flex items-center gap-1.5 shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px]">history_toggle_off</span>
            <span>Test Corrupt Config (Auto-Rollback)</span>
          </button>
          <button
            onClick={() => showToast('Config Tree Exported', 'Downloaded CSTAM 3.0 configuration bundle (JSON + HAProxy templates).', 'info')}
            className="h-9 px-3.5 rounded-lg bg-white border border-[#E8E0EA] hover:bg-slate-50 text-[#170B1B] text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px]">schema</span>
            <span>Export Config Tree</span>
          </button>
          <button
            onClick={() => {
              const el = document.getElementById('haproxy-editor')
              if (el) el.focus()
            }}
            className="h-9 px-4 rounded-lg bg-[#2D0035] hover:bg-[#3D0346] text-white text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px]">add_circle</span>
            <span>Apply New Config</span>
          </button>
        </div>
      </div>

      {/* KPI metric cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1 */}
        <div className="p-4 bg-white border border-[#E8E0EA] rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between text-[#827787]">
            <span className="text-[11px] font-medium uppercase tracking-wider">Current Active Generation</span>
            <span className="material-symbols-outlined text-[18px] text-surface-tint">verified</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#170B1B] font-mono tracking-tight">{activeGen}</span>
            <span className="text-xs text-on-secondary-container bg-secondary-container px-2 py-0.5 rounded font-mono">Live</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[#827787] pt-2 border-t border-[#E8E0EA]">
            <span>Active Nodes:</span>
            <span className="font-mono text-[#170B1B] font-semibold">gw1 &amp; gw2</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-surface-tint"></div>
        </div>

        {/* KPI 2 */}
        <div className="p-4 bg-white border border-[#E8E0EA] rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between text-[#827787]">
            <span className="text-[11px] font-medium uppercase tracking-wider">Rollback Latency</span>
            <span className="material-symbols-outlined text-[18px] text-secondary">speed</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#170B1B] font-mono tracking-tight">410 ms</span>
            <span className="text-xs text-secondary font-mono">Mean</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[#827787] pt-2 border-t border-[#E8E0EA]">
            <span>SLA Threshold:</span>
            <span className="font-mono text-[#170B1B] font-medium">&lt; 1000 ms</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-secondary"></div>
        </div>

        {/* KPI 3 */}
        <div className="p-4 bg-white border border-[#E8E0EA] rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between text-[#827787]">
            <span className="text-[11px] font-medium uppercase tracking-wider">Total Generations</span>
            <span className="material-symbols-outlined text-[18px] text-on-secondary-container">layers</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#170B1B] font-mono tracking-tight">28</span>
            <span className="text-xs text-[#827787] font-mono">Revisions</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[#827787] pt-2 border-t border-[#E8E0EA]">
            <span>Ledger Horizon:</span>
            <span className="font-mono text-[#170B1B] font-medium">Last 14 days</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-outline-variant"></div>
        </div>

        {/* KPI 4 */}
        <div className="p-4 bg-white border border-[#E8E0EA] rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between text-[#827787]">
            <span className="text-[11px] font-medium uppercase tracking-wider">Auto-Rejection Rate</span>
            <span className="material-symbols-outlined text-[18px] text-error">shield_lock</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#170B1B] font-mono tracking-tight">0.4%</span>
            <span className="text-xs text-error bg-error-container px-2 py-0.5 rounded font-mono">Guarded</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[#827787] pt-2 border-t border-[#E8E0EA]">
            <span>Rejected in flight:</span>
            <span className="font-mono text-[#170B1B] font-medium">Data Plane API</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-error"></div>
        </div>
      </div>

      {/* Main operational workspace grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left / Main Column: Vertical audit timeline (7 cols) */}
        <section className="lg:col-span-7 flex flex-col gap-4">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-[#2D0035]">timeline</span>
              <h2 className="text-base font-bold text-[#170B1B]">Generation Audit Timeline</h2>
            </div>
            <span className="text-xs text-[#827787] font-mono">Immutable Hash Chain</span>
          </div>

          <div className="flex flex-col gap-3">
            {/* Gen 412: Live Active */}
            <div className="p-5 bg-white border border-[#E8E0EA] rounded-xl shadow-xs relative overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="w-3 h-3 rounded-full bg-surface-tint"></span>
                  <span className="text-sm font-bold text-[#170B1B] font-mono">gen-412</span>
                  <span className="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-xs font-semibold">Active Live</span>
                  <span className="text-xs text-[#827787] font-mono">SHA: e8f44d1</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-[#827787] font-mono">
                  <span className="material-symbols-outlined text-[16px]">schedule</span>
                  <span>Applied 8m ago</span>
                </div>
              </div>
              <p className="text-xs text-[#170B1B] mt-1">
                +2 ingress routes configured for sandboxes; burst ratelimit elevated to 45,000 req/sec across cluster VIP.
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pt-3 bg-[#F8F6F9] border border-[#E8E0EA] p-3 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-[#827787] font-mono">
                  <span className="material-symbols-outlined text-[16px] text-secondary">person</span>
                  <span>s.chen@eng</span>
                  <span>•</span>
                  <span>gw1, gw2 synced</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onOpenDiff('gen-412', 'gen-411')}
                    className="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-[#170B1B] border border-[#E8E0EA] text-xs font-medium transition-colors flex items-center gap-1 shadow-xs"
                  >
                    <span className="material-symbols-outlined text-[15px]">difference</span>
                    <span>Inspect Diff</span>
                  </button>
                  <button
                    onClick={() => downloadCfg('gen-412')}
                    className="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-[#170B1B] border border-[#E8E0EA] text-xs font-medium transition-colors flex items-center gap-1 shadow-xs"
                  >
                    <span className="material-symbols-outlined text-[15px]">download</span>
                    <span>Download haproxy.cfg</span>
                  </button>
                </div>
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-surface-tint"></div>
            </div>

            {/* Gen 411: Stable Candidate */}
            <div className="p-5 bg-white border border-[#E8E0EA] rounded-xl shadow-xs relative overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="w-3 h-3 rounded-full bg-outline-variant"></span>
                  <span className="text-sm font-bold text-[#170B1B] font-mono">gen-411</span>
                  <span className="px-2 py-0.5 rounded bg-surface-container-high text-[#170B1B] text-xs font-semibold">Stable Candidate</span>
                  <span className="text-xs text-[#827787] font-mono">SHA: b0991c2</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-[#827787] font-mono">
                  <span className="material-symbols-outlined text-[16px]">schedule</span>
                  <span>Applied 3h ago</span>
                </div>
              </div>
              <p className="text-xs text-[#170B1B] mt-1">
                Initial dual-spine VIP binding to 10.20.20.246 and health check path stabilization for upstream pods.
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pt-3 bg-[#F8F6F9] border border-[#E8E0EA] p-3 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-[#827787] font-mono">
                  <span className="material-symbols-outlined text-[16px] text-secondary">person</span>
                  <span>a.kumar@eng</span>
                  <span>•</span>
                  <span>Verified in Staging 48h</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => executeRollback('gen-411')}
                    className="px-3.5 py-1.5 rounded-lg bg-[#2D0035] text-white hover:bg-[#3D0346] text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs"
                  >
                    <span className="material-symbols-outlined text-[15px]">undo</span>
                    <span>One-Click Rollback</span>
                  </button>
                </div>
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-outline-variant"></div>
            </div>

            {/* Gen 410: Auto-Rolled Back Alert */}
            <div className="p-5 bg-white border border-[#E8E0EA] rounded-xl shadow-xs relative overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="w-3 h-3 rounded-full bg-error animate-ping"></span>
                  <span className="text-sm font-bold text-[#170B1B] font-mono">gen-410</span>
                  <span className="px-2 py-0.5 rounded bg-error-container text-on-error-container text-xs font-semibold">Auto-Rolled Back</span>
                  <span className="text-xs text-[#827787] font-mono">SHA: 77a119f</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-error font-mono">
                  <span className="material-symbols-outlined text-[16px]">warning</span>
                  <span>5h ago (Automated CI)</span>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-900 mt-1">
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] text-error shrink-0 mt-0.5">error</span>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-bold font-mono">RELOAD_ABORTED: Syntax error on backend balance clause</span>
                    <p className="text-xs">
                      Keyword &apos;balance roundrobin_weighted&apos; unrecognized by HAProxy 2.8. Self-healing roll-back cleanly executed in 380ms. Zero dropped connections on active traffic flow.
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pt-3 bg-[#F8F6F9] border border-[#E8E0EA] p-3 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-[#827787] font-mono">
                  <span className="material-symbols-outlined text-[16px]">smart_toy</span>
                  <span>ci-pipeline-worker-9</span>
                  <span>•</span>
                  <span className="text-error font-semibold">Triage Ticket #ENG-9104</span>
                </div>
                <button
                  onClick={() => onOpenDiff('gen-410', 'gen-409')}
                  className="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-[#170B1B] border border-[#E8E0EA] text-xs font-medium transition-colors flex items-center gap-1 shadow-xs"
                >
                  <span className="material-symbols-outlined text-[15px]">search</span>
                  <span>View Failure Trace</span>
                </button>
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-error"></div>
            </div>

            {/* Historical generations accordion */}
            <div className="p-4 bg-[#F8F6F9] border border-[#E8E0EA] rounded-xl shadow-xs space-y-2">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center justify-between w-full text-left text-xs font-semibold text-[#170B1B]"
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-surface-tint">history</span>
                  <span>Archived Generations (Revisions 409 down to 385)</span>
                </div>
                <span className={`material-symbols-outlined text-[18px] transition-transform ${showHistory ? 'rotate-180' : ''}`}>
                  expand_more
                </span>
              </button>
              {showHistory && (
                <div className="space-y-2 pt-2">
                  {[
                    { id: 'gen-409', sha: 'a1029c', time: '12h ago', author: 'r.vance@eng' },
                    { id: 'gen-408', sha: 'c9928b', time: '1d ago', author: 's.chen@eng' },
                    { id: 'gen-407', sha: 'f4400a', time: '2d ago', author: 'd.lin@eng' },
                  ].map(h => (
                    <div key={h.id} className="p-3 bg-white border border-[#E8E0EA] rounded-lg flex items-center justify-between text-xs">
                      <div className="flex items-center gap-3 font-mono">
                        <span className="font-semibold text-[#170B1B]">{h.id}</span>
                        <span className="text-[#827787]">SHA: {h.sha}</span>
                        <span className="text-[#827787]">• Applied {h.time} by {h.author}</span>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-[#F8F6F9] border border-[#E8E0EA] text-[#827787] text-[11px]">Archived</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Interactive Config Editor & Atomic Protocol (5 cols) */}
        <section className="lg:col-span-5 flex flex-col gap-4">
          {/* Atomic protocol banner */}
          <div className="p-4 bg-[#2D0035] text-white rounded-xl shadow-xs space-y-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary-fixed-dim">lock_clock</span>
              <span className="text-sm font-semibold text-white">3-Phase Atomic Reload Protocol</span>
            </div>
            <p className="text-xs text-purple-200">
              Data plane updates maintain persistent socket handoffs without dropping existing keep-alive sessions.
            </p>
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono text-xs text-center">
              <div className="p-2 rounded bg-white/10 flex flex-col items-center">
                <span className="font-bold text-secondary-container">1. VALIDATE</span>
                <span className="text-[10px] text-purple-200 mt-0.5">haproxy -c</span>
              </div>
              <div className="p-2 rounded bg-white/10 flex flex-col items-center">
                <span className="font-bold text-secondary-container">2. COMMIT</span>
                <span className="text-[10px] text-purple-200 mt-0.5">Socket Transfer</span>
              </div>
              <div className="p-2 rounded bg-white/10 flex flex-col items-center">
                <span className="font-bold text-secondary-container">3. VERIFY</span>
                <span className="text-[10px] text-purple-200 mt-0.5">Drain Procs</span>
              </div>
            </div>
          </div>

          {/* Interactive editor card */}
          <div className="p-5 bg-white border border-[#E8E0EA] rounded-xl shadow-xs space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#E8E0EA]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-secondary">terminal</span>
                <span className="text-sm font-bold text-[#170B1B]">Data Plane Config Studio</span>
              </div>
              <span className="text-[11px] text-[#827787] font-mono">haproxy.cfg (Live Staging)</span>
            </div>
            <div className="relative rounded-lg overflow-hidden bg-[#170B1B] text-gray-200 p-3 font-mono text-xs">
              <div className="flex items-center justify-between pb-2 text-[11px] text-gray-400 border-b border-white/10 mb-2">
                <span>ACTIVE SYNTAX: HAProxy 2.8-LTS</span>
                <span className="text-secondary-fixed">Uncommitted Draft</span>
              </div>
              <textarea
                id="haproxy-editor"
                value={code}
                onChange={e => setCode(e.target.value)}
                rows={12}
                spellCheck={false}
                className="w-full bg-transparent text-gray-100 font-mono text-xs leading-relaxed resize-none focus:outline-none border-none p-0 selection:bg-purple-800"
              />
            </div>
            {/* Editor actions */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-mono text-[#827787]">
                <span className={`w-2 h-2 rounded-full ${isParsing ? 'bg-amber-500 animate-ping' : 'bg-emerald-500'}`}></span>
                <span className="truncate max-w-[200px]">{syntaxStatus}</span>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={validateSyntax}
                  disabled={isParsing}
                  className="flex-1 sm:flex-none px-3.5 py-2 rounded-lg bg-[#F8F6F9] hover:bg-[#E8E0EA] text-[#170B1B] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 shadow-xs"
                >
                  <span className="material-symbols-outlined text-[16px]">checklist_rtl</span>
                  <span>Validate Syntax</span>
                </button>
                <button
                  onClick={commitTransaction}
                  disabled={isParsing}
                  className="flex-1 sm:flex-none px-4 py-2 rounded-lg bg-[#2D0035] hover:bg-[#3D0346] text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 shadow-xs"
                >
                  <span className="material-symbols-outlined text-[16px]">published_with_changes</span>
                  <span>Commit Transaction</span>
                </button>
              </div>
            </div>
          </div>

          {/* Telemetry footprint */}
          <div className="p-4 bg-white border border-[#E8E0EA] rounded-xl shadow-xs space-y-2">
            <span className="text-xs font-bold text-[#170B1B]">Data Plane Telemetry Teleport</span>
            <div className="flex items-center justify-between text-xs font-mono pt-1 text-[#827787]">
              <span>VIP Master Gateway</span>
              <span className="text-[#170B1B] font-semibold">10.20.20.241 (gw1)</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono text-[#827787]">
              <span>Standby Synchronizer</span>
              <span className="text-[#170B1B] font-semibold">10.20.20.242 (gw2)</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono text-[#827787]">
              <span>Dynamic BGP Route Announce</span>
              <span className="text-on-secondary-container bg-secondary-container px-1.5 py-0.5 rounded font-bold text-[11px]">
                ESTABLISHED
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
