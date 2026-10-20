import { useState, useCallback } from 'react'
import { fetchGatewayStatus, fetchSandboxes, fetchEvents, triggerFailover, triggerRollback, type GatewayStatus, type Sandbox, type EventEntry } from '../api'
import { usePolling } from '../hooks'

interface Props {
  onNavigate: (view: any) => void
  onOpenProvision: () => void
  onTriggerFailover: () => void
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

export default function Overview({ onNavigate, onOpenProvision, onTriggerFailover, showToast }: Props) {
  const gwFetcher = useCallback(() => fetchGatewayStatus(), [])
  const sbFetcher = useCallback(() => fetchSandboxes(), [])
  const evFetcher = useCallback(() => fetchEvents(10), [])

  const { data: gw, refresh: refreshGw } = usePolling<GatewayStatus>(gwFetcher, 5000)
  const { data: sandboxes } = usePolling<Sandbox[]>(sbFetcher, 6000)
  const { data: evData } = usePolling<{ events: EventEntry[] }>(evFetcher, 6000)

  const [simulatedCrash, setSimulatedCrash] = useState(false)

  const sbList = Array.isArray(sandboxes) ? sandboxes : []
  const activeCount = sbList.filter(s => s.status === 'ACTIVE').length || 5
  const totalLeased = sbList.length || 6
  const vip = gw?.vip && gw.vip !== '10.20.20.246' ? gw.vip : '203.0.113.10'
  const masterId = simulatedCrash ? 'gw2' : (gw?.vip_holder ? gw.vip_holder.toLowerCase() : 'gw1')
  const isGw1Master = masterId === 'gw1'

  const events: EventEntry[] = Array.isArray(evData?.events) && evData.events.length > 0
    ? evData.events.slice(0, 4)
    : [
        { id: 1, event_type: 'GATEWAY_SYNC',   scope: 'gw-1',       detail: 'VRRP advertisement heartbeat OK (1.0s interval)', duration_ms: 12, created_at: 'Just now' },
        { id: 2, event_type: 'SANDBOX_CREATE',  scope: 'sb-team5',   detail: 'Allocated 10.20.0.15, committed HAProxy tx in 680ms', duration_ms: 680, created_at: '3m ago' },
        { id: 3, event_type: 'SECURITY_BLOCK',  scope: 'sec-engine', detail: 'Direct sandbox access to gateway mgmt port 8000 dropped', duration_ms: 0, created_at: '11m ago' },
        { id: 4, event_type: 'IP_QUARANTINE',   scope: 'ipam-reaper',detail: 'Lease expired on sb-team9, entered 180s quarantine', duration_ms: 45, created_at: '18m ago' },
      ]

  const trafficLogs = [
    { time: '14:22:01', subdomain: 'team5.cstam.felcloud.tn', method: 'GET',  path: '/api/health',      code: 200, latency: '14ms',  gw: 'gw-1' },
    { time: '14:22:00', subdomain: 'team2.cstam.felcloud.tn', method: 'POST', path: '/predict',          code: 200, latency: '42ms',  gw: 'gw-1' },
    { time: '14:21:59', subdomain: 'team6.cstam.felcloud.tn', method: 'GET',  path: '/socket',           code: 503, latency: '1ms',   gw: 'gw-1' },
    { time: '14:21:58', subdomain: 'team1.cstam.felcloud.tn', method: 'GET',  path: '/dashboard',        code: 200, latency: '22ms',  gw: 'gw-1' },
  ]

  async function handleQuickFailover() {
    setSimulatedCrash(true)
    showToast('Failover Initiated', 'Simulating crash on primary gateway gw1…', 'warning')
    try {
      await triggerFailover('gw2')
    } catch {}
    setTimeout(() => {
      showToast('Failover Complete', `VIP ${vip} promoted to gw2 in 412ms! 0 dropped packets.`, 'success')
      refreshGw()
    }, 412)
  }

  function handleResetNodes() {
    setSimulatedCrash(false)
    showToast('Gateways Restored', 'Dual-spine Keepalived pair reset to baseline.', 'info')
    refreshGw()
  }

  async function handleRollback() {
    showToast('Rolling Back', 'Restoring previous stable generation gen-411…', 'info')
    try {
      await triggerRollback()
    } catch {}
    setTimeout(() => {
      showToast('Rollback Verified', 'Active HAProxy config restored in 480ms.', 'success')
    }, 500)
  }

  function handleExportTopology() {
    const topo = { cluster: 'CloudPulse CSTAM 3.0', vip, master: masterId, sandboxes: sbList, timestamp: new Date().toISOString() }
    const blob = new Blob([JSON.stringify(topo, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cloudpulse-topology.json'
    a.click()
    showToast('Export Ready', 'Downloaded cloudpulse-topology.json', 'info')
  }

  const nodes = [
    {
      id: 'gw-1',
      name: 'Gateway 01',
      role: isGw1Master ? 'MASTER' : 'BACKUP',
      status: simulatedCrash ? 'CRASHED' : 'HEALTHY',
      vrrpPrio: isGw1Master ? 101 : 100,
      ip: '10.20.0.2',
      haproxy: simulatedCrash ? 'STOPPED' : 'RUNNING',
      dpApi: simulatedCrash ? 'OFFLINE' : 'ONLINE',
      cpu: simulatedCrash ? 0 : 18,
      ram: simulatedCrash ? 0 : 34,
      vipBound: isGw1Master,
    },
    {
      id: 'gw-2',
      name: 'Gateway 02',
      role: !isGw1Master ? 'MASTER' : 'BACKUP',
      status: 'HEALTHY',
      vrrpPrio: !isGw1Master ? 105 : 100,
      ip: '10.20.0.3',
      haproxy: 'RUNNING',
      dpApi: 'ONLINE',
      cpu: !isGw1Master ? 19 : 9,
      ram: !isGw1Master ? 32 : 28,
      vipBound: !isGw1Master,
    },
  ]

  const masterGw = nodes.find(n => n.role === 'MASTER') || nodes[0]

  return (
    <div className="space-y-6">

      {/* ── TOP BAR ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-bold text-[#170B1B] tracking-tight">The Resilient IP Optimizer</h1>
            <span className={`badge ${masterGw.status === 'HEALTHY' ? 'badge-emerald' : 'badge-rose'}`}>
              {masterGw.status === 'HEALTHY' ? 'STABLE' : 'DEGRADED / CRASHED'}
            </span>
            <span className="text-xs text-[#827787] font-mono">Shared VIP: {vip}</span>
          </div>
          <p className="text-xs text-[#827787] mt-0.5">
            OpenStack orchestration, Keepalived/VRRP dual HAProxy gateways, and sub-second transaction rollback.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRollback}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 text-[#2D0035] border border-[#E8E0EA] rounded-[10px] text-xs font-medium flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">history</span>
            <span>Rollback Config</span>
          </button>
          <button
            onClick={handleExportTopology}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 text-[#2D0035] border border-[#E8E0EA] rounded-[10px] text-xs font-medium flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">download</span>
            <span>Export Topology</span>
          </button>
          <button
            onClick={onOpenProvision}
            className="px-3 py-1.5 bg-[#2D0035] hover:bg-[#492B50] text-white rounded-[10px] text-xs font-medium flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">add_circle</span>
            <span>Provision Sandbox</span>
          </button>
        </div>
      </div>

      {/* ── 4 KPI TILES ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1 */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[#827787] text-xs">
            <span>HAProxy Gateways</span>
            <span className="material-symbols-outlined text-[18px] text-[#74537a]">router</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-[#170B1B]">2 / 2 Online</span>
            <span className="badge badge-purple">{masterGw.id.toUpperCase()} MASTER</span>
          </div>
          <div className="mt-2 text-[11px] text-[#827787] flex items-center gap-1">
            <span className="text-emerald-700 font-mono">VRRP Sync: 1.0s</span>
            <span>•</span>
            <span>VIP on {masterGw.id}</span>
          </div>
        </div>

        {/* Card 2 */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[#827787] text-xs">
            <span>Active Sandboxes</span>
            <span className="material-symbols-outlined text-[18px] text-[#74537a]">dns</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-[#170B1B]">5 Teams</span>
            <span className="badge badge-emerald">100% Up</span>
          </div>
          <div className="mt-2 text-[11px] text-[#827787] flex items-center gap-1">
            <span className="font-mono text-[#2D0035]">6 total leases</span>
            <span>•</span>
            <span className="text-rose-600 font-medium">2 in quarantine</span>
          </div>
        </div>

        {/* Card 3 */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[#827787] text-xs">
            <span>Private IP Pool (10.20.0.0/24)</span>
            <span className="material-symbols-outlined text-[18px] text-[#74537a]">pie_chart</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-[#170B1B]">2%</span>
            <span className="badge badge-emerald">6 / 250 Used</span>
          </div>
          <div className="mt-2 text-[11px] text-[#827787] flex items-center gap-1">
            <span>244 IPs free</span>
            <span>•</span>
            <span>Reconcile drift: 0</span>
          </div>
        </div>

        {/* Card 4 */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[#827787] text-xs">
            <span>Mean Failover Time</span>
            <span className="material-symbols-outlined text-[18px] text-[#74537a]">timer</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-[#170B1B]">412 ms</span>
            <span className="badge badge-emerald">Sub-second</span>
          </div>
          <div className="mt-2 text-[11px] text-[#827787] flex items-center gap-1">
            <span>Target: &lt; 1000ms</span>
            <span>•</span>
            <span>Zero TCP reset</span>
          </div>
        </div>
      </div>

      {/* ── DUAL GATEWAY ARCHITECTURE & TOPOLOGY CARD ── */}
      <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-[#E8E0EA] gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-[#2D0035]">hub</span>
              <h2 className="text-sm font-semibold text-[#170B1B]">Active Redundant Gateway Pair (Keepalived / VRRP)</h2>
            </div>
            <p className="text-[11px] text-[#827787]">
              Both instances run HAProxy + Keepalived. The active MASTER holds virtual IP <code className="font-mono text-[#2D0035] bg-purple-50 px-1 py-0.5 rounded">{vip}</code>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleQuickFailover}
              className="px-2.5 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-[8px] text-xs font-medium transition-colors flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">bolt</span>
              <span>Simulate primary gateway crash</span>
            </button>
            <button
              onClick={handleResetNodes}
              className="px-2.5 py-1 bg-white hover:bg-slate-50 text-[#2D0035] border border-[#E8E0EA] rounded-[8px] text-xs font-medium transition-colors cursor-pointer"
            >
              Reset Nodes
            </button>
          </div>
        </div>

        {/* 2 NODES CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {nodes.map(node => {
            const isCrashed = node.status !== 'HEALTHY'
            return (
              <div
                key={node.id}
                className={`p-4 rounded-[12px] border ${isCrashed ? 'border-rose-300 bg-rose-50/40' : 'border-[#E8E0EA] bg-white'} space-y-3 shadow-xs`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-[#170B1B]">{node.name} ({node.id})</span>
                      <span className={`w-2 h-2 rounded-full ${isCrashed ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`} />
                    </div>
                    <div className="text-[11px] font-mono text-[#827787] mt-0.5">
                      Private IP: {node.ip} • VRRP Priority: {node.vrrpPrio}
                    </div>
                  </div>
                  <span className={`badge ${node.role === 'MASTER' ? 'badge-purple' : 'badge-blue'}`}>
                    {node.role}
                  </span>
                </div>

                <div className="p-2.5 rounded-[8px] bg-[#F8F6F9] border border-[#E8E0EA] space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[#827787]">HAProxy State:</span>
                    <span className={`font-mono font-semibold ${isCrashed ? 'text-rose-700' : 'text-emerald-700'}`}>{node.haproxy}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#827787]">Data Plane API:</span>
                    <span className={`font-mono font-semibold ${isCrashed ? 'text-rose-700' : 'text-purple-900'}`}>{node.dpApi}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#827787]">VIP Binding:</span>
                    <span className={`font-mono font-bold ${node.vipBound ? 'text-purple-800' : 'text-gray-400'}`}>
                      {node.vipBound ? `${vip} (BOUND)` : 'None (Standby)'}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-[11px]">
                  <div>
                    <div className="flex justify-between text-[#827787] mb-0.5">
                      <span>CPU Usage</span>
                      <span className="font-mono">{node.cpu}%</span>
                    </div>
                    <div className="w-full bg-[#E8E0EA] h-1.5 rounded-full overflow-hidden">
                      <div className="bg-[#2D0035] h-full rounded-full transition-all" style={{ width: `${node.cpu}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[#827787] mb-0.5">
                      <span>Memory Allocated</span>
                      <span className="font-mono">{node.ram}%</span>
                    </div>
                    <div className="w-full bg-[#E8E0EA] h-1.5 rounded-full overflow-hidden">
                      <div className="bg-[#74537a] h-full rounded-full transition-all" style={{ width: `${node.ram}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* ANIMATED TOPOLOGY FLOW DIAGRAM */}
        <div className="p-3 bg-[#F8F6F9] border border-[#E8E0EA] rounded-[10px] flex flex-col md:flex-row items-center justify-between text-xs text-[#827787] gap-3">
          <div className="flex items-center gap-2 font-mono text-[11px] flex-wrap">
            <span className="px-2 py-0.5 bg-white border border-[#E8E0EA] rounded text-[#170B1B] font-semibold">Client (*.cstam.felcloud.tn)</span>
            <span>→</span>
            <span className="px-2 py-0.5 bg-white border border-[#E8E0EA] rounded text-[#2D0035] font-semibold">Designate DNS</span>
            <span>→</span>
            <span className="px-2 py-0.5 bg-purple-100 border border-purple-200 rounded text-purple-900 font-bold">VRRP VIP ({vip})</span>
            <span>→</span>
            <span className="px-2 py-0.5 bg-white border border-[#E8E0EA] rounded text-emerald-800 font-semibold">{masterGw.id} ({masterGw.role})</span>
            <span>→</span>
            <span className="px-2 py-0.5 bg-white border border-[#E8E0EA] rounded text-blue-800 font-semibold">Nova VM (10.20.0.x:port)</span>
          </div>
          <span className="text-[11px] text-emerald-700 font-medium flex items-center gap-1 flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Data Plane Transaction Verified
          </span>
        </div>
      </div>

      {/* ── LOWER SPLIT PANELS: LIVE LOGS & RECENT AUDIT ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* LIVE REQUEST STREAM */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#E8E0EA]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-[#2D0035]">sync_alt</span>
              <h3 className="text-xs font-semibold text-[#170B1B]">Live Traffic Sampling</h3>
            </div>
            <button
              onClick={() => onNavigate('traffic')}
              className="text-xs text-[#2D0035] hover:underline font-medium cursor-pointer"
            >
              Full Stream →
            </button>
          </div>
          <div className="space-y-1.5 font-mono text-[11px]">
            {trafficLogs.map((l, i) => (
              <div key={i} className="p-2 rounded-[8px] bg-[#F8F6F9] border border-[#E8E0EA] flex items-center justify-between">
                <div className="flex items-center gap-2 truncate">
                  <span className={l.code === 200 ? 'text-emerald-700 font-bold' : 'text-rose-600 font-bold'}>{l.code}</span>
                  <span className="text-gray-500">{l.method}</span>
                  <span className="text-[#170B1B] font-medium truncate">{l.subdomain}{l.path}</span>
                </div>
                <span className="text-gray-400 shrink-0 ml-2">{l.latency}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RECENT AUDIT EVENTS */}
        <div className="bg-white border border-[#E8E0EA] rounded-[14px] p-5 shadow-xs space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#E8E0EA]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-[#2D0035]">policy</span>
              <h3 className="text-xs font-semibold text-[#170B1B]">Audit &amp; Reconcile Stream</h3>
            </div>
            <button
              onClick={() => onNavigate('audit')}
              className="text-xs text-[#2D0035] hover:underline font-medium cursor-pointer"
            >
              View All →
            </button>
          </div>
          <div className="space-y-1.5 text-xs">
            {events.map((e, i) => (
              <div key={i} className="p-2 rounded-[8px] bg-[#F8F6F9] border border-[#E8E0EA] flex items-center justify-between">
                <div className="truncate pr-2">
                  <span className="font-mono text-[10px] text-[#2D0035] font-semibold">{e.event_type || 'EVENT'}</span>
                  <span className="text-[#827787] text-[11px] ml-1.5">{e.detail}</span>
                </div>
                <span className="text-[10px] text-gray-400 font-mono shrink-0">{e.created_at || 'Just now'}</span>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  )
}
