import { useState, useCallback } from 'react'
import { fetchEvents, type EventEntry } from '../api'
import { usePolling } from '../hooks'

interface Props {
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

interface AuditRow {
  id: string
  time: string
  timeAgo: string
  actor: string
  action: string
  target: string
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  category: string
  details: string
  accordion: {
    panel1Title: string
    panel1Lines: string[]
    panel2Title: string
    panel2Lines: string[]
    panel3Title: string
    panel3Desc: string
    actionBtnText?: string
    actionBtnType?: 'error' | 'default'
  }
}

export default function Events({ showToast }: Props) {
  const evFetcher = useCallback(() => fetchEvents(100), [])
  const { data: evData } = usePolling<{ events: EventEntry[] }>(evFetcher, 6000)

  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const [showSecurityDrawer, setShowSecurityDrawer] = useState(false)
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h')
  const [severityFilter, setSeverityFilter] = useState('ALL')
  const [categoryFilter, setCategoryFilter] = useState('ALL')
  const [actorFilter, setActorFilter] = useState('ALL')
  const [searchQuery, setSearchQuery] = useState('')

  const actors = ['ALL', 's.chen@eng', 'neutron-agent', 'openstack-reaper-bot', 'vrrp-monitor']

  const defaultRows: AuditRow[] = [
    {
      id: 'row-1',
      time: '14:28:02.194',
      timeAgo: 'today • 2m ago',
      actor: 'neutron-agent',
      action: 'SECURITY_BLOCK',
      target: 'sb-analytics → gw1:8000',
      severity: 'CRITICAL',
      category: 'SECURITY',
      details: 'Sandbox sb-analytics attempted access to gateway mgmt port 8000 (Blocked by Neutron SG rule cstam-sg-isolated-04).',
      accordion: {
        panel1Title: 'PACKET METRICS & HEADERS',
        panel1Lines: ['SRC: 10.20.10.14:48292 [tap-sb-anl]', 'DST: 10.20.10.1:8000 (MGMT_VLAN)', 'PROTOCOL: TCP SYN | FLAG: 0x002'],
        panel2Title: 'FIREWALL ENFORCEMENT',
        panel2Lines: ['RULE-ID: cstam-sg-isolated-04', 'DISPOSITION: REJECT_SILENT (DROP)', 'HOOK: ovs-neutron-firewall-v2'],
        panel3Title: 'ACTION RECOMMENDED',
        panel3Desc: 'Automated quarantine audit flag initiated. Host sandbox sb-analytics flagged for lateral recon probe.',
        actionBtnText: 'Quarantine Sandbox',
        actionBtnType: 'error',
      },
    },
    {
      id: 'row-2',
      time: '14:21:44.802',
      timeAgo: 'today • 8m ago',
      actor: 'openstack-reaper-bot',
      action: 'IPAM_QUARANTINE',
      target: '10.20.10.88',
      severity: 'WARNING',
      category: 'IPAM',
      details: 'IP 10.20.10.88 moved to quarantine cooldown (180s timer) after sandbox deletion.',
      accordion: {
        panel1Title: 'IPAM POOL LIFECYCLE',
        panel1Lines: ['ORIGIN: sb-ephemeral-test-841', 'COOLDOWN EXPIRES: 14:26:44 UTC', 'PURGE ARP CACHE: Verified Success'],
        panel2Title: 'ROUTER STATE',
        panel2Lines: ['SUBNET: pool-west-cstam-24', 'CLEANSE SCRIPT: ipam_sanitize.py#88', 'CONNTRACK FLUSH: 42 entries wiped'],
        panel3Title: 'OVERRIDE ACTION',
        panel3Desc: 'Force release IP back into available alloc pool immediately without waiting out the cooldown timer.',
        actionBtnText: 'Force Release Early',
        actionBtnType: 'default',
      },
    },
    {
      id: 'row-3',
      time: '13:59:10.012',
      timeAgo: 'today • 31m ago',
      actor: 'vrrp-monitor',
      action: 'GATEWAY_VRRP',
      target: 'gw1 (VIP 10.20.20.246)',
      severity: 'INFO',
      category: 'VRRP',
      details: 'Heartbeat sync verified on eth0.50; gw1 affirmed as MASTER (Priority 101 vs 100).',
      accordion: {
        panel1Title: 'KEEPALIVED HEARTBEAT TELEMETRY',
        panel1Lines: ['VIRTUAL ROUTER ID (VRID): 51', 'STATE: MASTER [gw1]', 'BACKUP NODE: gw2 (Standby Healthy)'],
        panel2Title: 'ADVERTISEMENT STATUS',
        panel2Lines: ['INTERVAL: 1000ms ± 4ms', 'PACKET LOSS: 0.000% (Last 10k frames)', 'VIP ARPING: Broadcasted Gratuitous ARP'],
        panel3Title: 'DRILL READINESS',
        panel3Desc: 'Failover simulated safely during morning readiness audit with zero dropped active TCP sessions.',
      },
    },
    {
      id: 'row-4',
      time: '12:44:22.510',
      timeAgo: 'today • 1h 45m ago',
      actor: 's.chen@eng',
      action: 'CONFIG_COMMIT',
      target: 'gen-412',
      severity: 'INFO',
      category: 'CONFIG',
      details: 'Generation gen-412 validated and successfully applied across 2 gateway nodes (Checksum: 8fa9c1).',
      accordion: {
        panel1Title: 'GENERATION SPECIFICATIONS',
        panel1Lines: ['GENERATION: gen-412', 'AUTHOR: s.chen@eng (Staff NetArch)', 'DIFF: +4 firewall rules, -1 route override'],
        panel2Title: 'DISTRIBUTED RECONCILIATION',
        panel2Lines: ['gw1: RECONCILED (0.8s)', 'gw2: RECONCILED (1.1s)', 'VALIDATION: Dry-run passed without warnings'],
        panel3Title: 'ROLLBACK SNAPSHOT',
        panel3Desc: 'Previous stable snapshot gen-411 stored in immutable etcd ledger with 24-hour instant revert lock.',
        actionBtnText: 'View Schema Diff',
        actionBtnType: 'default',
      },
    },
    {
      id: 'row-5',
      time: '11:15:08.771',
      timeAgo: 'today • 3h 14m ago',
      actor: 's.chen@eng',
      action: 'SANDBOX_CREATE',
      target: 'team4-vm-alpha',
      severity: 'INFO',
      category: 'SANDBOX',
      details: 'Provisioned team4-vm-alpha (tap-t4-01, IP 10.20.10.19) in 4.2s.',
      accordion: {
        panel1Title: 'ORCHESTRATION PIPELINE',
        panel1Lines: ['FLAVOR: cstam.standard.4c8g', 'TAP INTERFACE: tap-t4-01 (veth pair bound)', 'BOOT DURATION: 4,210 ms total'],
        panel2Title: 'SECURITY ASSIGNMENTS',
        panel2Lines: ['SECURITY GROUP: sg-team4-default', 'ISOLATION: Strict eBPF host shield', 'EGRESS POLICY: Default gateway NAT'],
        panel3Title: 'METADATA AUDIT',
        panel3Desc: 'Instance assigned to Project ID prj-sandbox-redteam with standard ephemerality flag.',
      },
    },
  ]

  // Filter rows
  const filteredRows = defaultRows.filter(r => {
    const q = searchQuery.toLowerCase()
    const matchesSearch = r.action.toLowerCase().includes(q) ||
      r.target.toLowerCase().includes(q) ||
      r.details.toLowerCase().includes(q) ||
      r.actor.toLowerCase().includes(q)

    let matchesSev = true
    if (severityFilter === 'CRITICAL') matchesSev = r.severity === 'CRITICAL'
    else if (severityFilter === 'WARNING') matchesSev = r.severity === 'WARNING'
    else if (severityFilter === 'INFO') matchesSev = r.severity === 'INFO'

    let matchesCat = true
    if (categoryFilter !== 'ALL') matchesCat = r.category === categoryFilter

    let matchesActor = true
    if (actorFilter !== 'ALL') matchesActor = r.actor === actorFilter

    return matchesSearch && matchesSev && matchesCat && matchesActor
  })

  function toggleRow(id: string) {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function handleExportCsv() {
    showToast('Exporting CSTAM Audit Stream', '1,428 records exporting in CSV format...', 'info')
  }

  function cycleActor() {
    const idx = actors.indexOf(actorFilter)
    const next = actors[(idx + 1) % actors.length]
    setActorFilter(next)
  }

  return (
    <div className="space-y-6">
      {/* Header section with live status & operational triggers */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-[#E8E0EA] shadow-xs">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#F8F6F9] border border-[#E8E0EA] text-xs font-mono text-secondary">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary"></span>
              CLUSTER AUDIT TRAIL
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#F8F6F9] border border-[#E8E0EA] text-xs font-mono text-[#827787]">
              STREAM-ID: <span className="text-secondary font-semibold">cstam-w-sec-092</span>
            </span>
          </div>
          <h1 className="text-[22px] font-bold text-[#170B1B] tracking-tight">Cluster Security &amp; Operations Audit Stream</h1>
          <p className="text-xs text-[#827787] max-w-3xl">
            Deterministic immutable log of hypervisor events, network namespace mutations, VRRP state-shifts, and eBPF/Neutron policy enforcement decisions across CSTAM-West.
          </p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F8F6F9] border border-[#E8E0EA] text-xs">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-secondary"></span>
            </span>
            <span className="font-semibold text-secondary">LOGGING LIVE</span>
            <span className="text-[#827787] font-mono text-[10px]">98.4 msg/s</span>
          </div>
          <button
            onClick={() => setShowSecurityDrawer(!showSecurityDrawer)}
            className="px-3.5 py-2 rounded-lg bg-[#F8F6F9] hover:bg-[#E8E0EA] border border-[#E8E0EA] text-[#170B1B] text-xs font-semibold flex items-center gap-2 transition-colors shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px] text-error">shield</span>
            <span>Security Summary</span>
            <span className="px-1.5 py-0.5 bg-error text-white rounded font-mono text-[10px] font-semibold">14 Blocked</span>
          </button>
          <button
            onClick={handleExportCsv}
            className="px-3.5 py-2 rounded-lg bg-[#F8F6F9] hover:bg-[#E8E0EA] border border-[#E8E0EA] text-[#170B1B] text-xs font-semibold flex items-center gap-2 transition-colors shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px]">file_download</span>
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* KPI metric cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: Total Events */}
        <div className="bg-white border border-[#E8E0EA] p-4 rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-[#827787] uppercase tracking-wider">TOTAL EVENTS (24H)</span>
            <span className="material-symbols-outlined text-[#827787] text-[18px]">receipt_long</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-[#170B1B] font-mono">1,428</span>
            <span className="text-xs text-secondary font-mono">+12.4% vs yday</span>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <div className="w-full bg-[#F8F6F9] h-1.5 rounded-full overflow-hidden">
              <div className="bg-secondary h-full" style={{ width: '78%' }}></div>
            </div>
            <span className="text-xs text-[#827787] font-mono">Normal</span>
          </div>
          <div className="absolute right-0 top-0 bottom-0 w-1 bg-secondary rounded-r"></div>
        </div>

        {/* Card 2: Security Denials */}
        <div className="bg-white border border-[#E8E0EA] p-4 rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-error uppercase tracking-wider">SECURITY DENIALS</span>
            <span className="material-symbols-outlined text-error text-[18px]">gpp_bad</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-error font-mono">14</span>
            <span className="text-xs text-error font-mono">blocked attempts</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-[#827787]">
            <span>Neutron SG + eBPF drop</span>
            <span className="font-mono text-error font-medium">100% Mitigated</span>
          </div>
          <div className="absolute right-0 top-0 bottom-0 w-1 bg-error rounded-r"></div>
        </div>

        {/* Card 3: Gateway VRRP Shifts */}
        <div className="bg-white border border-[#E8E0EA] p-4 rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-[#827787] uppercase tracking-wider">GATEWAY STATE SHIFTS</span>
            <span className="material-symbols-outlined text-secondary text-[18px]">swap_horiz</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-[#170B1B] font-mono">2</span>
            <span className="text-xs text-[#827787] font-mono">VRRP heartbeat shifts</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-[#827787]">
            <span>Current VIP owner</span>
            <span className="font-mono text-secondary font-medium">gw1 (MASTER)</span>
          </div>
          <div className="absolute right-0 top-0 bottom-0 w-1 bg-secondary-container rounded-r"></div>
        </div>

        {/* Card 4: IPAM Lifecycle */}
        <div className="bg-white border border-[#E8E0EA] p-4 rounded-xl shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-[#827787] uppercase tracking-wider">IPAM LIFECYCLE EVENTS</span>
            <span className="material-symbols-outlined text-[#827787] text-[18px]">lan</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-[#170B1B] font-mono">68</span>
            <span className="text-xs text-[#827787] font-mono">leases/quarantines</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-[#827787]">
            <span>Pool Subnet 10.20.10.0/24</span>
            <span className="font-mono text-secondary">2 in cooldown</span>
          </div>
          <div className="absolute right-0 top-0 bottom-0 w-1 bg-[#E8E0EA] rounded-r"></div>
        </div>
      </div>

      {/* Dense filter bar */}
      <div className="bg-white border border-[#E8E0EA] p-3 rounded-xl shadow-xs flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
        {/* Left filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Range pill */}
          <div className="inline-flex p-1 bg-[#F8F6F9] border border-[#E8E0EA] rounded-lg text-xs font-mono">
            {(['1h', '24h', '7d'] as const).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 py-1 rounded-md transition-colors ${range === r ? 'bg-white text-[#170B1B] shadow-xs font-semibold' : 'text-[#827787] hover:text-[#170B1B]'}`}
              >
                {r}
              </button>
            ))}
          </div>

          {/* Severity selector */}
          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="bg-[#F8F6F9] hover:bg-[#E8E0EA] border border-[#E8E0EA] text-[#170B1B] rounded-lg px-3 py-1.5 text-xs font-medium cursor-pointer focus:outline-none"
          >
            <option value="ALL">Severity: All Levels</option>
            <option value="CRITICAL">Critical &amp; Denials</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>

          {/* Category selector */}
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="bg-[#F8F6F9] hover:bg-[#E8E0EA] border border-[#E8E0EA] text-[#170B1B] rounded-lg px-3 py-1.5 text-xs font-medium cursor-pointer focus:outline-none"
          >
            <option value="ALL">Category: All Components</option>
            <option value="SECURITY">Security Block</option>
            <option value="IPAM">IPAM Lifecycle</option>
            <option value="VRRP">VRRP / Gateway HA</option>
            <option value="CONFIG">Config Generation</option>
            <option value="SANDBOX">Sandbox Lifecycle</option>
          </select>

          {/* Actor filter button */}
          <button
            onClick={cycleActor}
            className="px-3 py-1.5 rounded-lg bg-[#F8F6F9] hover:bg-[#E8E0EA] border border-[#E8E0EA] text-[#170B1B] text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px] text-[#827787]">person_search</span>
            <span>Actor: <strong className="font-mono text-secondary">{actorFilter === 'ALL' ? 'Any' : actorFilter}</strong></span>
          </button>
        </div>

        {/* Right search box */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 lg:w-72">
            <span className="material-symbols-outlined text-[18px] text-[#827787] absolute left-3 top-2 pointer-events-none">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search IPs, CIDRs, sandboxes..."
              className="w-full bg-[#F8F6F9] text-[#170B1B] placeholder-[#827787] text-xs pl-9 pr-3 py-1.5 rounded-lg border border-[#E8E0EA] focus:outline-none focus:border-[#2D0035] transition-all"
            />
          </div>
          <button
            onClick={() => {
              setSeverityFilter('ALL')
              setCategoryFilter('ALL')
              setActorFilter('ALL')
              setSearchQuery('')
            }}
            title="Reset Filters"
            className="p-1.5 text-[#827787] hover:text-[#170B1B] rounded-lg hover:bg-[#F8F6F9] border border-[#E8E0EA] transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">restart_alt</span>
          </button>
        </div>
      </div>

      {/* Main audit event stream table */}
      <div className="bg-white border border-[#E8E0EA] rounded-xl shadow-xs overflow-hidden flex flex-col">
        {/* Table header status bar */}
        <div className="px-5 py-3 bg-[#F8F6F9] border-b border-[#E8E0EA] flex items-center justify-between text-[#827787] text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[15px] text-secondary">history_toggle_off</span>
            <span>BUFFERED LOG ENTRIES: <strong className="text-[#170B1B]">{filteredRows.length} of 1,428 visible</strong></span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 font-mono text-[11px]">
              <span className="w-2 h-2 rounded-full bg-error"></span> 1 Security Denied
            </span>
            <span className="flex items-center gap-1 font-mono text-[11px]">
              <span className="w-2 h-2 rounded-full bg-amber-500"></span> 1 IPAM Cooldown
            </span>
            <span className="flex items-center gap-1 font-mono text-[11px]">
              <span className="w-2 h-2 rounded-full bg-secondary"></span> 3 Operative
            </span>
          </div>
        </div>

        {/* Table structure */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#F8F6F9] text-[#827787] text-[11px] uppercase tracking-wider font-mono border-b border-[#E8E0EA]">
                <th className="py-3 px-4">Timestamp (UTC)</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Action Type</th>
                <th className="py-3 px-4">Target Object</th>
                <th className="py-3 px-4">Severity</th>
                <th className="py-3 px-4">Details &amp; Verdict</th>
                <th className="py-3 px-4 text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8E0EA]">
              {filteredRows.map(row => {
                const isExpanded = !!expandedRows[row.id]
                return (
                  <tr key={row.id} className="contents">
                    <tr
                      onClick={() => toggleRow(row.id)}
                      className="hover:bg-[#F8F6F9] transition-colors cursor-pointer"
                    >
                      <td className="py-3.5 px-4 font-mono text-[#827787] whitespace-nowrap">
                        {row.time}
                        <span className="block text-[10px] text-gray-400">{row.timeAgo}</span>
                      </td>
                      <td className="py-3.5 px-4 font-mono whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-[#F8F6F9] border border-[#E8E0EA] text-secondary font-semibold">
                          {row.actor}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold ${
                          row.severity === 'CRITICAL' ? 'bg-error text-white' : row.severity === 'WARNING' ? 'bg-amber-100 text-amber-900 border border-amber-200' : 'bg-[#F8F6F9] border border-[#E8E0EA] text-[#170B1B]'
                        }`}>
                          {row.action}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono whitespace-nowrap text-[#170B1B] font-semibold">
                        {row.target}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`badge ${row.severity === 'CRITICAL' ? 'badge-rose' : row.severity === 'WARNING' ? 'badge-amber' : 'badge-blue'}`}>
                          {row.severity}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-[#4e444d] max-w-md truncate">
                        {row.details}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <button
                          onClick={e => { e.stopPropagation(); toggleRow(row.id); }}
                          className="p-1 rounded bg-[#F8F6F9] hover:bg-[#E8E0EA] text-[#170B1B] transition-colors"
                        >
                          <span className={`material-symbols-outlined text-[18px] transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                            expand_more
                          </span>
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-[#F8F6F9]/60">
                        <td colSpan={7} className="p-4 border-l-4 border-secondary">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
                            <div className="p-3 bg-white border border-[#E8E0EA] rounded-lg shadow-xs space-y-1">
                              <span className="text-[#827787] text-[10px] uppercase font-bold">{row.accordion.panel1Title}</span>
                              {row.accordion.panel1Lines.map((l, idx) => (
                                <div key={idx} className="text-[#170B1B]">{l}</div>
                              ))}
                            </div>
                            <div className="p-3 bg-white border border-[#E8E0EA] rounded-lg shadow-xs space-y-1">
                              <span className="text-[#827787] text-[10px] uppercase font-bold">{row.accordion.panel2Title}</span>
                              {row.accordion.panel2Lines.map((l, idx) => (
                                <div key={idx} className="text-[#170B1B]">{l}</div>
                              ))}
                            </div>
                            <div className="p-3 bg-white border border-[#E8E0EA] rounded-lg shadow-xs flex flex-col justify-between gap-2">
                              <div>
                                <span className="text-[#827787] text-[10px] uppercase font-bold">{row.accordion.panel3Title}</span>
                                <p className="font-sans text-xs text-[#4e444d] mt-1">{row.accordion.panel3Desc}</p>
                              </div>
                              {row.accordion.actionBtnText && (
                                <button
                                  onClick={() => showToast('Action Dispatched', `${row.accordion.actionBtnText} initiated via OpenStack control plane.`, 'info')}
                                  className={`px-3 py-1 rounded text-xs font-sans font-semibold self-start ${
                                    row.accordion.actionBtnType === 'error' ? 'bg-error text-white hover:opacity-90' : 'bg-[#2D0035] text-white hover:bg-[#3D0346]'
                                  }`}
                                >
                                  {row.accordion.actionBtnText}
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination bar */}
        <div className="px-5 py-3 bg-[#F8F6F9] border-t border-[#E8E0EA] flex items-center justify-between text-xs text-[#827787]">
          <div className="flex items-center gap-2 font-mono">
            <span className="font-semibold text-[#170B1B]">1 - {filteredRows.length}</span>
            <span>of</span>
            <span className="font-semibold text-[#170B1B]">1,428</span>
            <span>audit frames</span>
          </div>
          <div className="flex items-center gap-2 font-mono">
            <button disabled className="px-2.5 py-1 rounded bg-white border border-[#E8E0EA] text-[#827787] opacity-50 cursor-not-allowed">
              Prev
            </button>
            <span className="font-semibold text-[#170B1B]">Page 1 / 286</span>
            <button
              onClick={() => showToast('Telemetry Bus', 'Viewing buffered records from live telemetry stream.', 'info')}
              className="px-2.5 py-1 rounded bg-white border border-[#E8E0EA] hover:bg-slate-50 text-[#170B1B] font-semibold"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Security drawer sub panel */}
      {showSecurityDrawer && (
        <div className="bg-white border border-[#E8E0EA] rounded-xl shadow-xs p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-[#E8E0EA] gap-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-error text-white flex items-center justify-center shadow-xs">
                <span className="material-symbols-outlined text-[22px]">shield_with_heart</span>
              </div>
              <div>
                <h2 className="text-base font-bold text-[#170B1B]">Security Policy Blocks &amp; Lateral Drops</h2>
                <span className="text-xs text-[#827787] font-mono">Neutron SG Rule Evaluation &amp; Gateway Port Protections</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-full bg-rose-50 text-error font-mono text-xs font-semibold border border-rose-200">
                14 Total Blocks in 24h
              </span>
              <button
                onClick={() => setShowSecurityDrawer(false)}
                className="p-1 rounded-lg text-[#827787] hover:text-[#170B1B] hover:bg-[#F8F6F9]"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Panel 1 */}
            <div className="p-4 bg-[#F8F6F9] border border-[#E8E0EA] rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#170B1B] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-error">alt_route</span>
                  Cross-Sandbox Lateral Traffic
                </span>
                <span className="px-2 py-0.5 rounded bg-error text-white font-mono text-[10px] font-bold">11 DROPPED</span>
              </div>
              <p className="text-xs text-[#827787]">
                Attempts by sandboxes to initiate direct point-to-point connections with neighboring sandbox VLAN namespaces without going through approved ingress proxies.
              </p>
              <div className="space-y-2 font-mono text-xs pt-1">
                <div className="p-2.5 bg-white border border-[#E8E0EA] rounded-lg flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#170B1B]">sb-analytics → sb-finance-db</div>
                    <span className="text-[10px] text-[#827787]">Rule ID: cstam-iso-strict-91</span>
                  </div>
                  <span className="text-error font-bold">TCP 5432 REJECT</span>
                </div>
                <div className="p-2.5 bg-white border border-[#E8E0EA] rounded-lg flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#170B1B]">sb-crawler-02 → sb-internal-auth</div>
                    <span className="text-[10px] text-[#827787]">Rule ID: cstam-iso-strict-91</span>
                  </div>
                  <span className="text-error font-bold">TCP 6379 REJECT</span>
                </div>
              </div>
            </div>

            {/* Panel 2 */}
            <div className="p-4 bg-[#F8F6F9] border border-[#E8E0EA] rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#170B1B] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-error">router</span>
                  Gateway Infrastructure Management Probes
                </span>
                <span className="px-2 py-0.5 rounded bg-error text-white font-mono text-[10px] font-bold">3 DROPPED</span>
              </div>
              <p className="text-xs text-[#827787]">
                Tenant VMs targeting CSTAM VIP management listeners, OpenStack API daemons, or Keepalived control sockets directly.
              </p>
              <div className="space-y-2 font-mono text-xs pt-1">
                <div className="p-2.5 bg-white border border-[#E8E0EA] rounded-lg flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#170B1B]">10.20.10.14 → gw1:8000 (REST API)</div>
                    <span className="text-[10px] text-[#827787]">Rule ID: cstam-sg-isolated-04</span>
                  </div>
                  <span className="text-error font-bold">DROP_SILENT</span>
                </div>
                <div className="p-2.5 bg-white border border-[#E8E0EA] rounded-lg flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#170B1B]">10.20.10.42 → gw1:22 (SSH Probe)</div>
                    <span className="text-[10px] text-[#827787]">Rule ID: cstam-mgmt-deny-all</span>
                  </div>
                  <span className="text-error font-bold">TCP RST</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
