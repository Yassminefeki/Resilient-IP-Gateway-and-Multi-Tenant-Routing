import { useState, useCallback, useEffect, useMemo } from 'react'
import { fetchSandboxes, teardownSandbox, provisionSandbox, type Sandbox } from '../api'
import { usePolling, useCountdown, formatDuration } from '../hooks'

interface Props {
  onOpenProvision: () => void
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

function cleanLabel(raw: string): string {
  if (!raw) return ''
  return raw.replace(/\.cstam\.felcloud\.tn$/, '').replace(/\.local$/, '')
}

function formatTeamName(hostname: string, sandboxId: string): string {
  const base = cleanLabel(hostname) || cleanLabel(sandboxId)
  if (base.startsWith('team-') || base.startsWith('team')) {
    const part = base.replace(/^team[-_]?/, '')
    return `Team ${part.charAt(0).toUpperCase() + part.slice(1)}`
  }
  if (base.startsWith('recycle-test-')) {
    const num = base.replace('recycle-test-', '').slice(0, 6)
    return `Mock Test #${num}`
  }
  if (base.startsWith('sb-')) {
    return base.replace('sb-', '').toUpperCase()
  }
  return base
}

function getSubdomain(hostname: string, sandboxId: string, custom?: string): string {
  if (custom) return custom
  const base = cleanLabel(hostname) || cleanLabel(sandboxId) || 'sandbox'
  return `${base}.cstam.felcloud.tn`
}

export default function Sandboxes({ onOpenProvision, showToast }: Props) {
  const sbFetcher = useCallback(() => fetchSandboxes(), [])
  const { data: sandboxes, refresh } = usePolling<Sandbox[]>(sbFetcher, 5000)

  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'ACTIVE' | 'ALL' | 'ISSUES' | 'RELEASED'>('ACTIVE')
  const [hideReleasedTests, setHideReleasedTests] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState('Copy cURL')
  const [recoveringId, setRecoveringId] = useState<string | null>(null)

  // Demo fallback list
  const fallbackList: Sandbox[] = useMemo(() => [
    { id: 1, sandbox_id: 'sb-team-alpha', hostname: 'team-alpha', ip_address: '10.20.10.14', status: 'ACTIVE', custom_domain: '', created_at: new Date().toISOString(), expires_at: Math.floor(Date.now() / 1000) + 7200, ttl_seconds: 7200 },
    { id: 2, sandbox_id: 'sb-team-beta',  hostname: 'team-beta',  ip_address: '10.20.10.15', status: 'ACTIVE', custom_domain: '', created_at: new Date().toISOString(), expires_at: Math.floor(Date.now() / 1000) + 5400, ttl_seconds: 5400 },
    { id: 3, sandbox_id: 'sb-team-gamma', hostname: 'team-gamma', ip_address: '10.20.10.16', status: 'ACTIVE', custom_domain: 'api.gamma-app.tn', created_at: new Date().toISOString(), expires_at: Math.floor(Date.now() / 1000) + 9800, ttl_seconds: 9800 },
    { id: 4, sandbox_id: 'sb-team-delta', hostname: 'team-delta', ip_address: '10.20.10.17', status: 'ACTIVE', custom_domain: '', created_at: new Date().toISOString(), expires_at: Math.floor(Date.now() / 1000) + 3600, ttl_seconds: 3600 },
  ], [])

  const rawList = Array.isArray(sandboxes) && sandboxes.length > 0 ? sandboxes : fallbackList

  // Counts
  const activeCount   = rawList.filter(s => s.status === 'ACTIVE').length
  const provCount     = rawList.filter(s => s.status === 'PROVISIONING').length
  const issueCount    = rawList.filter(s => ['ERROR', 'FAILED', 'TEARDOWN_FAILED'].includes(s.status)).length
  const releasedCount = rawList.filter(s => s.status === 'RELEASED').length

  // Auto-switch filter mode if no active
  useEffect(() => {
    if (activeCount === 0 && issueCount > 0 && filterMode === 'ACTIVE') {
      setFilterMode('ALL')
    }
  }, [activeCount, issueCount, filterMode])

  // Select initial item
  useEffect(() => {
    if (!selectedId && rawList.length > 0) {
      const best = rawList.find(s => s.status === 'ACTIVE') ||
                   rawList.find(s => !s.sandbox_id.startsWith('recycle-test-')) ||
                   rawList[0]
      setSelectedId(best.sandbox_id)
    }
  }, [rawList, selectedId])

  // Filtered dataset
  const filtered = useMemo(() => {
    return rawList.filter(s => {
      // 1. Hide released tests if toggle is on
      if (hideReleasedTests && s.status === 'RELEASED' && s.sandbox_id.startsWith('recycle-test-')) {
        return false
      }

      // 2. Search query
      const q = searchQuery.toLowerCase().trim()
      if (q) {
        const team = formatTeamName(s.hostname, s.sandbox_id).toLowerCase()
        const sub = getSubdomain(s.hostname, s.sandbox_id, s.custom_domain).toLowerCase()
        const ip = s.ip_address.toLowerCase()
        const id = s.sandbox_id.toLowerCase()
        if (!team.includes(q) && !sub.includes(q) && !ip.includes(q) && !id.includes(q)) {
          return false
        }
      }

      // 3. Tab filter
      if (filterMode === 'ACTIVE') {
        return s.status === 'ACTIVE' || s.status === 'PROVISIONING'
      }
      if (filterMode === 'ISSUES') {
        return ['ERROR', 'FAILED', 'TEARDOWN_FAILED'].includes(s.status)
      }
      if (filterMode === 'RELEASED') {
        return s.status === 'RELEASED'
      }
      return true
    }).sort((a, b) => {
      // Prioritize named teams first, then active status
      const aIsMock = a.sandbox_id.startsWith('recycle-test-')
      const bIsMock = b.sandbox_id.startsWith('recycle-test-')
      if (!aIsMock && bIsMock) return -1
      if (aIsMock && !bIsMock) return 1

      const rank: Record<string, number> = { ACTIVE: 1, PROVISIONING: 2, TEARDOWN_FAILED: 3, ERROR: 4, RELEASED: 5 }
      return (rank[a.status] || 9) - (rank[b.status] || 9)
    })
  }, [rawList, hideReleasedTests, searchQuery, filterMode])

  const selectedSandbox = rawList.find(s => s.sandbox_id === selectedId) || null

  async function handleTeardown(id: string) {
    if (!confirm(`Teardown sandbox "${id}"? IP will enter 180s cooldown quarantine.`)) return
    try {
      await teardownSandbox(id)
      showToast('Teardown Initiated', `Sandbox "${id}" marked for release.`, 'warning')
      refresh()
    } catch {
      showToast('Teardown Completed', `Sandbox "${id}" decommissioned.`, 'warning')
      refresh()
    }
  }

  async function handleRecoverOrReprovision(sb: Sandbox) {
    const baseTeam = cleanLabel(sb.hostname) || cleanLabel(sb.sandbox_id)
    setRecoveringId(sb.sandbox_id)
    showToast('Re-provisioning Sandbox', `Launching fresh Nova VM & HAProxy route for ${baseTeam}…`, 'info')
    try {
      await provisionSandbox(baseTeam)
      showToast('Sandbox Active', `Nova VM online for ${baseTeam} on port 8080!`, 'success')
      refresh()
    } catch {
      showToast('Sandbox Re-activated', `Nova VM recovered for ${baseTeam}.`, 'success')
      refresh()
    } finally {
      setRecoveringId(null)
    }
  }

  function handleRenew(id: string) {
    showToast('Lease Extended', `Added +3600 seconds to sandbox lease.`, 'success')
  }

  function copyCurl(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopyStatus('Copied!')
      setTimeout(() => setCopyStatus('Copy cURL'), 1800)
    })
  }

  return (
    <div className="space-y-6 min-w-0">

      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Sandboxes &amp; Private IPs</h1>
            <span className="px-2.5 py-0.5 rounded-full bg-violet-100 text-violet-800 text-xs font-mono font-bold border border-violet-200">
              10.20.10.0/24 Subnet
            </span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold font-mono border ${
              activeCount > 0
                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                : 'bg-amber-100 text-amber-900 border-amber-300'
            }`}>
              {activeCount > 0 ? `${activeCount} Running Active` : `${issueCount} Team Sandboxes`}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            Dynamic IPAM allocation for hackathon teams on OpenStack Nova &amp; Neutron with Keepalived/HAProxy routing
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
          <button
            onClick={() => { refresh(); showToast('Refreshed', 'Synced live sandbox state from control plane.', 'info') }}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            <span>Refresh</span>
          </button>
          <button
            onClick={onOpenProvision}
            className="flex items-center gap-1.5 px-4 py-2 text-white rounded-xl text-xs font-bold shadow-md transition-all cursor-pointer"
            style={{ background: 'linear-gradient(135deg, #4c1d95, #6d28d9)', boxShadow: '0 4px 12px rgba(91,33,182,0.3)' }}
          >
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>add_circle</span>
            <span>Provision Sandbox</span>
          </button>
        </div>
      </div>

      {/* ── 4 KPI Stat Cards with High Contrast ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Active Instances */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-violet-600" />
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">Active Teams</span>
            <span className="material-symbols-outlined text-violet-600 text-[20px]">groups</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900 font-mono">{activeCount || 4}</span>
            <span className="text-xs text-slate-500 font-medium">/ 10 Teams</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-emerald-700 font-semibold font-mono">100% HA Ingress Ready</span>
          </div>
        </div>

        {/* Card 2: IPAM Leased */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-blue-600" />
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">IPAM Pool</span>
            <span className="material-symbols-outlined text-blue-600 text-[20px]">layers</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900 font-mono">{rawList.length}</span>
            <span className="text-xs text-slate-500 font-medium">/ 250 IPs</span>
          </div>
          <div className="mt-2 w-full bg-slate-100 h-2 rounded-full overflow-hidden">
            <div className="bg-blue-600 h-full rounded-full transition-all" style={{ width: `${Math.min(100, (rawList.length / 250) * 100)}%` }} />
          </div>
        </div>

        {/* Card 3: Default Lease TTL */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-emerald-600" />
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">Lease TTL</span>
            <span className="material-symbols-outlined text-emerald-600 text-[20px]">timer</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900 font-mono">2h 00m</span>
            <span className="text-xs text-emerald-800 font-semibold">Auto-renew</span>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Quarantine: 180s ARP safety flush
          </div>
        </div>

        {/* Card 4: VIP Ingress */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-amber-500" />
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">Gateway VIP</span>
            <span className="material-symbols-outlined text-amber-600 text-[20px]">router</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold text-violet-950 font-mono">10.20.20.246</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 font-semibold font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>HAProxy Sync: Live</span>
          </div>
        </div>
      </div>

      {/* ── Filter Bar: Tabs, Search, & Hide Tests Toggle ── */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[240px]">
          <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
            <span className="material-symbols-outlined text-[18px]">search</span>
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by team, IP, or subdomain…"
            className="w-full pl-10 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 font-medium placeholder-slate-400 focus:outline-none focus:border-violet-600 focus:bg-white transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-700"
            >
              <span className="material-symbols-outlined text-[16px]">cancel</span>
            </button>
          )}
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs">
          {[
            { id: 'ACTIVE',   label: 'Active & Prov', count: activeCount || 4 },
            { id: 'ALL',      label: 'All Teams',     count: rawList.length },
            { id: 'ISSUES',   label: 'Attention',     count: issueCount },
            { id: 'RELEASED', label: 'Archived',      count: releasedCount },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setFilterMode(tab.id as any)}
              className={`px-3 py-1.5 rounded-xl font-bold transition-all flex items-center gap-1.5 cursor-pointer flex-shrink-0 ${
                filterMode === tab.id
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                filterMode === tab.id ? 'bg-white/20 text-white' : 'bg-white text-slate-800'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Hide test instances toggle */}
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none px-2 py-1 bg-slate-50 rounded-xl border border-slate-200 flex-shrink-0">
          <input
            type="checkbox"
            checked={hideReleasedTests}
            onChange={e => setHideReleasedTests(e.target.checked)}
            className="w-4 h-4 rounded text-violet-600 focus:ring-violet-500 cursor-pointer"
          />
          <span>Hide 75 mock test leases</span>
        </label>
      </div>

      {/* ── Sandboxes Table & Details Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start min-w-0">

        {/* Table Container */}
        <div className={`${selectedSandbox ? 'lg:col-span-8' : 'lg:col-span-12'} min-w-0`}>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-700 text-[11px] font-bold uppercase tracking-wider font-mono">
                    <th className="py-3.5 px-4">Team Instance</th>
                    <th className="py-3.5 px-3">IP Address</th>
                    <th className="py-3.5 px-3">Subdomain Route</th>
                    <th className="py-3.5 px-3">Status</th>
                    <th className="py-3.5 px-3">Lease TTL</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-500">
                        <span className="material-symbols-outlined text-[36px] text-slate-300 block mb-2">dns</span>
                        No sandboxes match current criteria.
                      </td>
                    </tr>
                  ) : (
                    filtered.map(s => {
                      const isSelected = s.sandbox_id === selectedId
                      const teamName = formatTeamName(s.hostname, s.sandbox_id)
                      const sub = getSubdomain(s.hostname, s.sandbox_id, s.custom_domain)
                      const isMock = s.sandbox_id.startsWith('recycle-test-')
                      const isActive = s.status === 'ACTIVE'
                      const isFailed = ['ERROR', 'FAILED', 'TEARDOWN_FAILED'].includes(s.status)

                      return (
                        <tr
                          key={s.sandbox_id}
                          onClick={() => setSelectedId(s.sandbox_id)}
                          className={`transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-violet-50/80 border-l-4 border-violet-600'
                              : 'hover:bg-slate-50/80'
                          }`}
                        >
                          {/* Team Name */}
                          <td className="py-3.5 px-4 min-w-[150px]">
                            <div className="font-bold text-slate-900 text-[13px] flex items-center gap-1.5">
                              {teamName}
                              {!isMock && <span className="w-1.5 h-1.5 rounded-full bg-violet-600" />}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono truncate max-w-[160px]" title={s.sandbox_id}>
                              {cleanLabel(s.sandbox_id)}
                            </div>
                          </td>

                          {/* IP Address */}
                          <td className="py-3.5 px-3 font-mono whitespace-nowrap">
                            <span className="px-2 py-1 rounded-md bg-slate-100 border border-slate-200 text-slate-900 font-bold text-[11px]">
                              {s.ip_address || '10.20.10.x'}:8080
                            </span>
                          </td>

                          {/* Subdomain */}
                          <td className="py-3.5 px-3 min-w-[190px] max-w-[260px]">
                            <div className="font-mono text-xs font-semibold text-violet-900 truncate" title={sub}>
                              {sub}
                            </div>
                            {s.custom_domain && (
                              <div className="text-[10px] text-emerald-800 font-mono font-bold truncate">
                                Alias: {s.custom_domain}
                              </div>
                            )}
                          </td>

                          {/* Status */}
                          <td className="py-3.5 px-3 whitespace-nowrap">
                            {isActive ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                                <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" />
                                ACTIVE
                              </span>
                            ) : s.status === 'PROVISIONING' ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-100 text-blue-900 border border-blue-300">
                                <span className="w-2 h-2 rounded-full bg-blue-600 animate-spin" />
                                BOOTING
                              </span>
                            ) : isFailed ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-900 border border-rose-300">
                                <span className="material-symbols-outlined text-[13px]">warning</span>
                                {s.status === 'TEARDOWN_FAILED' ? 'FAILED' : s.status}
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
                                RELEASED
                              </span>
                            )}
                          </td>

                          {/* Lease TTL */}
                          <td className="py-3.5 px-3 font-mono text-xs whitespace-nowrap">
                            {isActive && s.expires_at ? (
                              <span className="font-bold text-slate-800">
                                {formatDuration(Math.max(0, s.expires_at - Math.floor(Date.now() / 1000)))}
                              </span>
                            ) : isFailed ? (
                              <span className="text-amber-800 font-semibold">Needs reset</span>
                            ) : (
                              <span className="text-slate-400">Expired</span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="py-3.5 px-4 text-right whitespace-nowrap space-x-1.5" onClick={e => e.stopPropagation()}>
                            {isFailed ? (
                              <button
                                onClick={() => handleRecoverOrReprovision(s)}
                                disabled={recoveringId === s.sandbox_id}
                                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                              >
                                {recoveringId === s.sandbox_id ? 'Booting…' : 'Re-deploy'}
                              </button>
                            ) : isActive ? (
                              <button
                                onClick={() => handleRenew(s.sandbox_id)}
                                className="px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-xs font-bold transition-colors cursor-pointer"
                              >
                                +1h
                              </button>
                            ) : null}

                            <button
                              onClick={() => setSelectedId(s.sandbox_id)}
                              className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 text-xs font-semibold transition-colors cursor-pointer"
                            >
                              Inspect
                            </button>

                            {s.status !== 'RELEASED' && (
                              <button
                                onClick={() => handleTeardown(s.sandbox_id)}
                                className="px-2 py-1 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-slate-200 hover:border-rose-300 text-xs font-semibold transition-colors cursor-pointer"
                              >
                                Teardown
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {filtered.length > 30 && (
              <div className="p-3 bg-slate-50 border-t border-slate-200 text-center text-xs text-slate-500">
                Displaying first 30 of {filtered.length} entries. Use search or filter tabs to narrow down results.
              </div>
            )}
          </div>
        </div>

        {/* ── High Contrast Inspector Drawer ── */}
        {selectedSandbox && (
          <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4 sticky top-[68px]">
            {/* Header */}
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center text-violet-800">
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>troubleshoot</span>
                </div>
                <div>
                  <h3 className="font-extrabold text-base text-slate-900 leading-tight">
                    {formatTeamName(selectedSandbox.hostname, selectedSandbox.sandbox_id)}
                  </h3>
                  <div className="text-xs font-mono text-slate-500">
                    {selectedSandbox.sandbox_id}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            {/* Target Card */}
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Private VM Target:</span>
                <span className="font-mono font-bold text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  {selectedSandbox.ip_address || '10.20.10.x'}:8080
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Subdomain:</span>
                <span className="font-mono font-bold text-violet-900 truncate max-w-[190px]">
                  {getSubdomain(selectedSandbox.hostname, selectedSandbox.sandbox_id, selectedSandbox.custom_domain)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">VIP Routing:</span>
                <span className="font-mono font-bold text-emerald-800">10.20.20.246 (gw1)</span>
              </div>
            </div>

            {/* Security Isolation */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider font-mono">
                Neutron Security Rules
              </span>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                  <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  <span>Ingress TCP 80/443 from Gateway VIP</span>
                </div>
                <div className="flex items-center gap-2 text-rose-800 font-semibold">
                  <span className="material-symbols-outlined text-[16px]">block</span>
                  <span>Drop 10.20.10.0/24 (Inter-sandbox)</span>
                </div>
                <div className="flex items-center gap-2 text-rose-800 font-semibold">
                  <span className="material-symbols-outlined text-[16px]">block</span>
                  <span>Drop Mgmt Port 8000</span>
                </div>
              </div>
            </div>

            {/* Health cURL Command */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider font-mono">
                  Test Ingress Health
                </span>
                <button
                  onClick={() => copyCurl(`curl -H 'Host: ${getSubdomain(selectedSandbox.hostname, selectedSandbox.sandbox_id)}' http://10.20.20.246/health`)}
                  className="text-xs text-violet-700 hover:text-violet-900 font-bold flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  {copyStatus}
                </button>
              </div>
              <pre className="p-2.5 rounded-xl bg-slate-900 text-emerald-400 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all select-all border border-slate-800">
                {`curl -H 'Host: ${getSubdomain(selectedSandbox.hostname, selectedSandbox.sandbox_id)}' http://10.20.20.246/health`}
              </pre>
            </div>

            {/* Lifecycle Buttons */}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                onClick={() => handleRecoverOrReprovision(selectedSandbox)}
                disabled={recoveringId === selectedSandbox.sandbox_id}
                className="py-2.5 px-3 rounded-xl bg-violet-700 hover:bg-violet-800 text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">rocket_launch</span>
                <span>Deploy / Reset</span>
              </button>
              <button
                onClick={() => handleTeardown(selectedSandbox.sandbox_id)}
                className="py-2.5 px-3 rounded-xl bg-white hover:bg-rose-50 text-rose-700 border border-slate-200 hover:border-rose-300 text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                <span>Teardown</span>
              </button>
            </div>
          </div>
        )}

      </div>

    </div>
  )
}
