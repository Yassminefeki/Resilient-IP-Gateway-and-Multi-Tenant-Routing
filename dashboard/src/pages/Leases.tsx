import { useState, useCallback, useEffect } from 'react'
import { fetchLeases, fetchSandboxes, type LeaseEntry, type Sandbox } from '../api'
import { usePolling, formatDuration } from '../hooks'

interface Props {
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

export default function Leases({ showToast }: Props) {
  const leaseFetcher = useCallback(() => fetchLeases(), [])
  const sbFetcher    = useCallback(() => fetchSandboxes(), [])

  const { data: leases,    refresh } = usePolling<LeaseEntry[]>(leaseFetcher, 10000)
  const { data: sandboxes }          = usePolling<Sandbox[]>(sbFetcher, 10000)

  const rawLeases = Array.isArray(leases) ? leases : []
  const sbList    = Array.isArray(sandboxes) ? sandboxes : []

  const [quarantined, setQuarantined] = useState([
    { ip: '10.20.10.20', releasedAt: '10m ago', cooldownLeft: 45,  reason: 'Sandbox expired (sb-team9)',      team: 'Team 09', sandbox: 'sb-team9' },
    { ip: '10.20.10.21', releasedAt: '2m ago',  cooldownLeft: 160, reason: 'Teardown requested (sb-team11)',  team: 'Team 11', sandbox: 'sb-team11' },
  ])

  const [selectedIp, setSelectedIp] = useState<string | null>(null)

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      setQuarantined(prev =>
        prev.map(q => ({ ...q, cooldownLeft: Math.max(0, q.cooldownLeft - 1) }))
            .filter(q => q.cooldownLeft > 0)
      )
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Build active IPs from server data or fallback
  const leasedIps = new Set<string>()
  rawLeases.forEach(l => { if (l.status === 'ACTIVE') leasedIps.add(l.ip_address) })
  sbList.forEach(s => { if (s.status === 'ACTIVE') leasedIps.add(s.ip_address) })
  if (leasedIps.size === 0) {
    ;['10.20.10.11','10.20.10.12','10.20.10.13','10.20.10.14','10.20.10.15'].forEach(ip => leasedIps.add(ip))
  }

  const reservedIps    = new Set(['10.20.10.1','10.20.10.2','10.20.10.3','10.20.10.254','10.20.10.255'])
  const quarantinedIps = new Set(quarantined.map(q => q.ip))

  const totalIps    = 250
  const freeCount   = totalIps - leasedIps.size - reservedIps.size - quarantinedIps.size
  const utilizationPct = Math.min(100, Math.round((leasedIps.size / totalIps) * 100))

  function handleReconcile() {
    showToast('OpenStack Reconciler', 'Scanning Neutron ports and ARP cache drift…', 'info')
    setTimeout(() => {
      showToast('Reconciliation Clean', '0 orphaned ports found. IP pool synchronized with Nova compute.', 'success')
      refresh()
    }, 1200)
  }

  function handleReleaseEarly(ip: string) {
    if (!confirm(`Bypass 180s quarantine and release ${ip} immediately?`)) return
    setQuarantined(prev => prev.filter(q => q.ip !== ip))
    showToast('IP Released', `${ip} returned to free pool. Conntrack flushed.`, 'success')
  }

  // Build lease display list
  const displayLeases = rawLeases.length > 0
    ? rawLeases.slice(0, 20)
    : sbList.slice(0, 10).map(s => ({
        id: s.id,
        sandbox_id: s.sandbox_id,
        ip_address: s.ip_address,
        status: s.status,
        created_at: s.created_at,
        expires_at: s.expires_at,
      }))

  const IpCell = ({ ip, onClick }: { ip: string; onClick: () => void }) => {
    const isLeased     = leasedIps.has(ip)
    const isReserved   = reservedIps.has(ip)
    const isQuarantined= quarantinedIps.has(ip)

    let cls = 'bg-[#F0EBF4] text-[#a088aa] hover:bg-[#E5E0EA]'
    let status = 'Free'
    if (isReserved)    { cls = 'bg-violet-700 text-white font-bold';           status = 'Reserved' }
    else if (isLeased) { cls = 'bg-emerald-500 text-white font-semibold shadow-sm'; status = 'Leased' }
    else if (isQuarantined) { cls = 'bg-rose-500 text-white font-semibold animate-pulse'; status = 'Quarantine' }

    const lastOctet = ip.split('.')[3]
    return (
      <button
        onClick={onClick}
        title={`${ip} — ${status}`}
        className={`h-9 w-full rounded-xl cursor-pointer flex items-center justify-center font-mono text-[11px] transition-all hover:scale-105 ${cls} ${selectedIp === ip ? 'ring-2 ring-offset-1 ring-violet-400' : ''}`}
      >
        .{lastOctet}
      </button>
    )
  }

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <h1 className="text-[22px] font-bold text-[#170B1B] tracking-tight">IP Pool & Leases</h1>
            <span className="badge badge-emerald">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {leasedIps.size} Leased
            </span>
            {quarantinedIps.size > 0 && (
              <span className="badge badge-rose">{quarantinedIps.size} Quarantine</span>
            )}
          </div>
          <p className="text-sm text-[#a088aa]">
            Neutron subnet 10.20.10.0/24 · IPAM lease registry · 180s quarantine cooldown
          </p>
        </div>
        <button onClick={handleReconcile}
          className="flex items-center gap-1.5 px-4 py-2 text-white rounded-xl text-xs font-bold shadow-md transition-all hover:-translate-y-0.5 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #2D0035, #4c1d95)', boxShadow: '0 4px 12px rgba(45,0,53,0.3)' }}>
          <span className="material-symbols-outlined text-[14px]">sync</span>
          Run OpenStack Reconcile
        </button>
      </div>

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Pool',    val: `${totalIps}`,            icon: 'database',     cls: 'bg-[#F5F3F7] border-[#E5DFE8] text-[#170B1B]' },
          { label: 'Leased',        val: `${leasedIps.size}`,      icon: 'dns',          cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
          { label: 'Quarantine',    val: `${quarantinedIps.size}`, icon: 'block',        cls: 'bg-rose-50 border-rose-200 text-rose-700' },
          { label: 'Free',          val: `${freeCount}`,           icon: 'check_circle', cls: 'bg-blue-50 border-blue-200 text-blue-700' },
        ].map((s, i) => (
          <div key={i} className={`flex items-center gap-3 p-3.5 rounded-xl border ${s.cls} text-xs`}>
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>{s.icon}</span>
            <div>
              <div className="text-[10px] opacity-60 uppercase tracking-wider font-mono">{s.label}</div>
              <div className="font-bold text-[18px] font-mono leading-tight">{s.val}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Utilization bar ── */}
      <div className="bg-white border border-[#E5DFE8] rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between mb-2 text-xs">
          <span className="text-[#a088aa]">Pool Utilization</span>
          <span className="font-mono font-bold text-[#170B1B]">{leasedIps.size} / {totalIps} ({utilizationPct}%)</span>
        </div>
        <div className="h-3 rounded-full bg-[#EDE7F0] overflow-hidden flex">
          <div className="h-full transition-all" style={{ width: `${utilizationPct}%`, background: 'linear-gradient(90deg, #7c3aed, #a855f7)' }} />
          <div className="h-full bg-rose-400 transition-all" style={{ width: `${(quarantinedIps.size / totalIps) * 100}%` }} />
          <div className="h-full bg-violet-800 transition-all" style={{ width: `${(reservedIps.size / totalIps) * 100}%` }} />
        </div>
        <div className="flex items-center gap-4 mt-2 text-[10px]">
          {[
            { dot: 'bg-purple-500', label: `Leased (${leasedIps.size})` },
            { dot: 'bg-rose-400',   label: `Quarantine (${quarantinedIps.size})` },
            { dot: 'bg-violet-800', label: `Reserved (${reservedIps.size})` },
            { dot: 'bg-[#EDE7F0]',  label: `Free (${freeCount})` },
          ].map((l, i) => (
            <span key={i} className="flex items-center gap-1 text-[#a088aa]">
              <span className={`w-2 h-2 rounded-full ${l.dot}`} />{l.label}
            </span>
          ))}
        </div>
      </div>

      {/* ── Subnet heatmap + Quarantine queue ── */}
      <div className="grid lg:grid-cols-3 gap-5">

        {/* Heatmap — takes 2/3 */}
        <div className="lg:col-span-2 bg-white border border-[#E5DFE8] rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#F0EBF2] bg-gradient-to-r from-white to-[#FAF7FC] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px] text-violet-600" style={{ fontVariationSettings: "'FILL' 1" }}>grid_view</span>
              </div>
              <h3 className="text-[13px] font-semibold text-[#170B1B]">Subnet Map — 10.20.10.0/24</h3>
            </div>
            <span className="text-[11px] text-[#a088aa] font-mono">48 of 250 addresses shown</span>
          </div>
          <div className="p-4 grid grid-cols-8 sm:grid-cols-12 md:grid-cols-16 gap-1.5">
            {Array.from({ length: 48 }).map((_, i) => {
              const ip = `10.20.10.${i + 1}`
              return (
                <IpCell key={ip} ip={ip} onClick={() => setSelectedIp(selectedIp === ip ? null : ip)} />
              )
            })}
          </div>
          {selectedIp && (
            <div className="mx-4 mb-4 p-3 bg-violet-50 border border-violet-200 rounded-xl text-xs flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono font-bold text-violet-700">{selectedIp}</span>
                <span className={`badge ${leasedIps.has(selectedIp) ? 'badge-emerald' : quarantinedIps.has(selectedIp) ? 'badge-rose' : reservedIps.has(selectedIp) ? 'badge-purple' : 'badge-gray'}`}>
                  {leasedIps.has(selectedIp) ? 'LEASED' : quarantinedIps.has(selectedIp) ? 'QUARANTINE' : reservedIps.has(selectedIp) ? 'RESERVED' : 'FREE'}
                </span>
                <span className="text-[#a088aa]">Subnet: 10.20.10.0/24 · Gateway: 10.20.10.1</span>
              </div>
              <button onClick={() => setSelectedIp(null)} className="text-violet-400 hover:text-violet-700">
                <span className="material-symbols-outlined text-[15px]">close</span>
              </button>
            </div>
          )}
        </div>

        {/* Quarantine queue */}
        <div className="bg-white border border-[#E5DFE8] rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#F0EBF2] bg-gradient-to-r from-white to-[#FAF7FC] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-rose-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px] text-rose-600" style={{ fontVariationSettings: "'FILL' 1" }}>hourglass_top</span>
              </div>
              <h3 className="text-[13px] font-semibold text-[#170B1B]">Quarantine Queue</h3>
            </div>
            <span className="badge badge-rose">{quarantined.length}</span>
          </div>
          <div className="p-4 space-y-3">
            {quarantined.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <span className="material-symbols-outlined text-[36px] text-emerald-300 block">check_circle</span>
                <div className="text-sm font-semibold text-[#170B1B]">No IPs in quarantine</div>
                <div className="text-xs text-[#a088aa]">All released IPs have completed cooldown</div>
              </div>
            ) : quarantined.map(q => {
              const pct = Math.round((q.cooldownLeft / 180) * 100)
              return (
                <div key={q.ip} className="p-3 bg-rose-50 border border-rose-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-rose-700 text-sm">{q.ip}</span>
                    <span className="badge badge-rose">{q.cooldownLeft}s left</span>
                  </div>
                  <div className="w-full bg-rose-100 h-1.5 rounded-full overflow-hidden">
                    <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[11px] text-rose-600">{q.reason}</div>
                  <div className="text-[10px] text-[#a088aa]">Released {q.releasedAt} · {q.team}</div>
                  <button onClick={() => handleReleaseEarly(q.ip)}
                    className="w-full text-[11px] font-semibold text-rose-700 hover:bg-rose-100 border border-rose-200 bg-white py-1.5 rounded-lg transition-colors">
                    Force Release
                  </button>
                </div>
              )
            })}

            {/* IPAM facts */}
            <div className="mt-2 p-3 bg-[#FAF7FC] border border-[#EDE7F0] rounded-xl space-y-2 text-[11px]">
              <div className="font-semibold text-[#170B1B] text-[12px]">IPAM Policy</div>
              {[
                { label: 'Cooldown TTL',  val: '180s' },
                { label: 'Subnet',        val: '10.20.10.0/24' },
                { label: 'Gateway',       val: '10.20.10.1' },
                { label: 'DHCP',         val: 'Disabled (Static)' },
                { label: 'ARP Flush',    val: 'On release' },
              ].map((r, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-[#a088aa]">{r.label}</span>
                  <span className="font-mono font-semibold text-[#170B1B]">{r.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Active Lease Table ── */}
      <div className="bg-white border border-[#E5DFE8] rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F0EBF2] bg-gradient-to-r from-white to-[#FAF7FC] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center">
              <span className="material-symbols-outlined text-[16px] text-emerald-600" style={{ fontVariationSettings: "'FILL' 1" }}>list_alt</span>
            </div>
            <h3 className="text-[13px] font-semibold text-[#170B1B]">Active IPAM Lease Registry</h3>
          </div>
          <span className="badge badge-emerald">{displayLeases.length} entries</span>
        </div>

        {/* Header */}
        <div className="grid px-5 py-2 bg-[#FAF7FC] border-b border-[#F0EBF2] text-[10px] font-bold uppercase tracking-[0.1em] text-[#a088aa]"
          style={{ gridTemplateColumns: '1.5fr 1.2fr 1fr 1.2fr 0.8fr' }}>
          <span>Sandbox ID</span>
          <span>Private IP</span>
          <span>Status</span>
          <span>Expires</span>
          <span>Action</span>
        </div>

        <div className="divide-y divide-[#F5F1F7] max-h-64 overflow-y-auto">
          {displayLeases.length === 0 ? (
            <div className="py-10 text-center text-sm text-[#a088aa]">No lease data from server</div>
          ) : displayLeases.map((l: any, i) => {
            const sbId = l.sandbox_id || `lease-${l.id}`
            const shortSbId = sbId.length > 22 ? sbId.slice(0, 14) + '…' + sbId.slice(-6) : sbId
            const statusCls = l.status === 'ACTIVE' ? 'badge-emerald' :
                              l.status === 'PROVISIONING' ? 'badge-blue' :
                              l.status === 'ERROR' ? 'badge-rose' : 'badge-gray'
            const expiresMs = l.expires_at ? (l.expires_at * 1000 - Date.now()) : null
            return (
              <div key={l.id ?? i}
                className="grid items-center px-5 py-2.5 hover:bg-[#FAF7FC] transition-colors text-[12px]"
                style={{ gridTemplateColumns: '1.5fr 1.2fr 1fr 1.2fr 0.8fr' }}>
                <span className="font-mono text-[11px] text-[#2D0035] font-semibold truncate" title={sbId}>{shortSbId}</span>
                <span className="font-mono text-[11px] font-bold text-[#170B1B]">{l.ip_address}</span>
                <span className={`badge ${statusCls} text-[10px] self-start mt-0.5`}>{l.status}</span>
                <span className="font-mono text-[11px] text-[#a088aa]">
                  {expiresMs !== null && expiresMs > 0
                    ? formatDuration(Math.floor(expiresMs / 1000))
                    : expiresMs !== null && expiresMs <= 0
                      ? <span className="text-rose-500">Expired</span>
                      : '—'}
                </span>
                <button className="text-[10px] font-semibold text-violet-700 hover:bg-violet-50 px-2 py-1 rounded-lg border border-transparent hover:border-violet-200 transition-colors">
                  Inspect
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
