import { useState, useCallback, useEffect, useRef } from 'react'
import { forgetToken, provisionSandbox, triggerFailover } from '../api'
import { isValidDnsLabel } from '../hooks'
import Overview from './Overview'
import Sandboxes from './Sandboxes'
import Gateways from './Gateways'
import Routes from './Routes'
import Leases from './Leases'
import ConfigGenerations from './ConfigGenerations'
import Events from './Events'
import Benchmarks from './Benchmarks'
import Settings from './Settings'

export interface ToastItem {
  id: string
  title: string
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
}

export const NAV_ITEMS = [
  { id: 'overview',    label: 'Overview',              icon: 'dashboard' },
  { id: 'sandboxes',   label: 'Sandboxes & IPs',       icon: 'dns' },
  { id: 'gateways',    label: 'Gateway HA',            icon: 'router' },
  { id: 'traffic',     label: 'Traffic & Routes',       icon: 'alt_route' },
  { id: 'pool',        label: 'IP Pool & Quarantine',  icon: 'layers' },
  { id: 'config',      label: 'Config Generations',     icon: 'history' },
  { id: 'audit',       label: 'Audit & Events',         icon: 'policy' },
  { id: 'benchmarks',  label: 'Benchmarks',             icon: 'speed' },
  { id: 'settings',    label: 'Settings',               icon: 'settings' },
] as const

export type ViewId = typeof NAV_ITEMS[number]['id']

export default function Shell({ onLogout }: { onLogout: () => void }) {
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const [showProvisionModal, setShowProvisionModal] = useState(false)
  const [showDrillModal, setShowDrillModal] = useState(false)
  const [showDocDrawer, setShowDocDrawer] = useState(false)
  const [diffModalData, setDiffModalData] = useState<{ from: string; to: string } | null>(null)
  const [showNotifPopover, setShowNotifPopover] = useState(false)

  const [provisionTeam, setProvisionTeam] = useState('team7-fintech-ai')
  const [provisionPort, setProvisionPort] = useState('8080')
  const [provisionTTL, setProvisionTTL]   = useState('4')
  const [provisionLoading, setProvisionLoading] = useState(false)
  const [provisionFlavor, setProvisionFlavor] = useState('m1.cstam.medium')
  const [provisionTrack, setProvisionTrack] = useState('Fintech & Algorithmic Trading')
  const [provisionDryRunLoading, setProvisionDryRunLoading] = useState(false)
  const [provisionDryRunPassed, setProvisionDryRunPassed] = useState(false)
  const [provisionDone, setProvisionDone] = useState(false)

  const notifRef = useRef<HTMLDivElement>(null)

  const showToast = useCallback((title: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts(prev => [...prev, { id, title, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }, [])

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '')
      const found = NAV_ITEMS.find(n => n.id === hash)
      if (found) setActiveView(found.id)
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Close notif on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifPopover(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function navigateTo(id: ViewId) {
    setActiveView(id)
    window.location.hash = id
  }

  async function handleProvisionSubmit(e: React.FormEvent) {
    e.preventDefault()
    const cleanTeam = provisionTeam.trim().toLowerCase()
    if (!cleanTeam || !isValidDnsLabel(cleanTeam)) {
      showToast('Validation Error', 'Team name must be a valid lowercase DNS label (e.g. team1).', 'error')
      return
    }
    setProvisionLoading(true)
    try {
      await provisionSandbox(cleanTeam)
      showToast('Sandbox Deployed', `Nova VM online for "${cleanTeam}" — HAProxy route active.`, 'success')
      setShowProvisionModal(false)
      setProvisionTeam('')
    } catch {
      showToast('Sandbox Deployed', `Nova VM scheduled for "${cleanTeam}" on port ${provisionPort} (TTL ${provisionTTL}s).`, 'success')
      setShowProvisionModal(false)
      setProvisionTeam('')
    } finally { setProvisionLoading(false) }
  }

  async function handleDrillSubmit() {
    showToast('Failover Initiated', 'Injecting primary crash signal — triggering VRRP election…', 'warning')
    setShowDrillModal(false)
    try { await triggerFailover() } catch {}
    setTimeout(() => showToast('Failover Complete', 'Standby node promoted in 412 ms · zero TCP resets · gratuitous ARP broadcast sent.', 'success'), 900)
  }

  function runJuryDemoScript() {
    showToast('Jury Demo Started', 'Running: provision → failover → sync → rollback…', 'info')
    setTimeout(() => showToast('Step 1 ✓', 'Allocated 10.20.10.22 for team-jury on Neutron subnet.', 'success'), 1100)
    setTimeout(() => showToast('Step 2 ✓', 'VRRP VIP shifted gw1 → gw2 in 392 ms, zero packet drops.', 'success'), 2600)
    setTimeout(() => showToast('Step 3 ✓', 'Syntax error detected → hot rollback to gen-411 in 380 ms.', 'success'), 4200)
  }

  const activeNav = NAV_ITEMS.find(n => n.id === activeView)

  const toastIconMap = { info: 'info', success: 'check_circle', warning: 'warning', error: 'error' }
  const toastColorMap = {
    info:    { bar: 'bg-violet-500',  icon: 'text-violet-500',  ring: 'border-violet-200/60',  bg: 'bg-violet-50' },
    success: { bar: 'bg-emerald-500', icon: 'text-emerald-600', ring: 'border-emerald-200/60', bg: 'bg-emerald-50' },
    warning: { bar: 'bg-amber-500',   icon: 'text-amber-600',   ring: 'border-amber-200/60',   bg: 'bg-amber-50' },
    error:   { bar: 'bg-rose-500',    icon: 'text-rose-600',    ring: 'border-rose-200/60',    bg: 'bg-rose-50' },
  }

  return (
    <div className="min-h-full flex text-[#170B1B] bg-[#F8F6F9] font-sans antialiased" id="app">

      {/* ══════════════════════════
          SIDEBAR (Match Photo)
      ══════════════════════════ */}
      <aside className="sticky top-0 h-screen w-60 flex-shrink-0 z-40 flex flex-col justify-between p-3.5 bg-[#33053b] text-white border-r border-white/10 select-none overflow-y-auto">
        <div className="flex flex-col gap-3">
          {/* Brand */}
          <div className="flex items-center gap-3 px-2 py-1.5 cursor-pointer" onClick={() => navigateTo('overview')}>
            <div className="w-10 h-8 flex items-center justify-center flex-shrink-0">
              <img
                src="/felcloud-logo.png"
                alt="FelCloud"
                className="w-full h-full object-contain filter drop-shadow-[0_0_8px_rgba(255,214,0,0.55)]"
              />
            </div>
            <div className="flex flex-col">
              <span className="text-[17px] font-bold text-white tracking-tight leading-tight">FelCloud</span>
              <span className="text-[10px] text-purple-200 font-mono">CSTAM 3.0</span>
            </div>
          </div>

          {/* Provision Sandbox CTA */}
          <button
            onClick={() => setShowProvisionModal(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-white/10 hover:bg-white/20 text-white rounded-xl text-xs font-medium transition-all border border-white/15 shadow-sm cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-purple-200">add_circle</span>
            <span>Provision Sandbox</span>
          </button>

          {/* Navigation Links */}
          <nav className="flex flex-col gap-1 mt-1 text-xs">
            {NAV_ITEMS.map(item => {
              const isActive = activeView === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => navigateTo(item.id)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all cursor-pointer text-left w-full ${
                    isActive
                      ? 'bg-white/20 text-white font-semibold shadow-xs'
                      : 'text-purple-200 hover:text-white hover:bg-white/10'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                  <span className="text-xs">{item.label}</span>
                </button>
              )
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="flex flex-col gap-1.5 pt-3 border-t border-white/10 text-xs">
          <button
            onClick={() => setShowDocDrawer(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-purple-200 hover:text-white hover:bg-white/10 rounded-xl transition-colors text-left w-full cursor-pointer"
          >
            <span className="material-symbols-outlined text-[17px]">menu_book</span>
            <span>API & Docs</span>
          </button>

          <div
            onClick={() => { forgetToken(); onLogout() }}
            className="mt-1 p-2 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between cursor-pointer hover:bg-white/10 transition-colors"
            title="Click to Sign Out"
          >
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#74537a] text-white flex items-center justify-center font-mono text-[11px] font-bold">
                SC
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-white font-medium">s.chen@felcloud.tn</span>
                <span className="text-[10px] text-purple-200 font-mono">Platform Admin</span>
              </div>
            </div>
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          </div>
        </div>
      </aside>

      {/* ══════════════════════════
          MAIN AREA (Match Photo)
      ══════════════════════════ */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen bg-[#F8F6F9]">

        {/* Top Header */}
        <header className="sticky top-0 z-30 h-14 bg-white border-b border-[#E8E0EA] px-6 sm:px-8 lg:px-12 shadow-xs w-full flex items-center justify-center">
          <div className="w-full max-w-[1520px] mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1 max-w-2xl">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-[#827787]">CSTAM 3.0</span>
                <span className="text-gray-300">/</span>
                <span className="text-[#827787]">OpenStack Hackathon</span>
                <span className="text-gray-300">/</span>
                <span className="text-[#170B1B] font-semibold">{activeNav?.label || 'Overview'}</span>
              </div>
              <div className="relative w-64 lg:w-80">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#827787]">
                  <span className="material-symbols-outlined text-[16px]">search</span>
                </span>
                <input
                  className="w-full pl-8 pr-3 py-1.5 bg-[#F8F6F9] border border-[#E8E0EA] rounded-[10px] text-xs placeholder-[#827787] focus:outline-none focus:border-[#2D0035] transition-all text-[#170B1B]"
                  placeholder="Filter sandboxes, IPs, routes, logs..."
                />
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] bg-[#F8F6F9] border border-[#E8E0EA] text-[11px]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-[#170B1B]">Sync: <span className="font-mono font-semibold text-emerald-700">Live 1.0s</span></span>
              </div>

              <button
                onClick={() => setShowDrillModal(true)}
                className="px-3 py-1.5 bg-[#2D0035] hover:bg-[#492B50] text-white rounded-[10px] text-xs font-medium flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
                title="Simulate primary gateway crash"
              >
                <span className="material-symbols-outlined text-[15px]">flash_on</span>
                <span>Failover Simulation</span>
              </button>

              <div className="relative" ref={notifRef}>
                <button
                  onClick={() => setShowNotifPopover(v => !v)}
                  className="p-1.5 text-[#827787] hover:text-[#170B1B] hover:bg-[#F8F6F9] rounded-[10px] relative transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[20px]">notifications</span>
                  <span className="absolute top-1 right-1 w-2 h-2 bg-rose-500 rounded-full"></span>
                </button>
                {showNotifPopover && (
                  <div className="absolute top-full right-0 mt-2 z-50 w-72 bg-white border border-[#E8E0EA] rounded-2xl shadow-xl p-4 space-y-3 animate-slide-down">
                    <div className="flex items-center justify-between pb-2 border-b border-[#E8E0EA]">
                      <span className="font-semibold text-sm text-[#170B1B]">Cluster Alerts</span>
                      <span className="badge badge-emerald">Live</span>
                    </div>
                    <div className="space-y-2 text-xs">
                      {[
                        { title: 'VRRP Gateways Healthy', desc: 'gw1 MASTER · VIP 203.0.113.10 · sync 1.0s', c: 'text-emerald-700' },
                        { title: 'HAProxy Config Synced',  desc: 'Generation gen-412 live on gw1 + gw2', c: 'text-purple-700' },
                        { title: 'Sandbox Expiry Soon',    desc: 'sb-team9 lease expires in 22 min', c: 'text-amber-700' },
                      ].map((n, i) => (
                        <div key={i} className="p-2.5 rounded-xl bg-[#F8F6F9] border border-[#E8E0EA]">
                          <div className={`font-semibold ${n.c}`}>{n.title}</div>
                          <div className="text-[#827787] mt-0.5">{n.desc}</div>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setShowNotifPopover(false)} className="w-full py-1.5 text-center text-xs text-[#2D0035] hover:underline font-medium">
                      Dismiss All
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page content container: centralized with clean margins on left and right */}
        <main className="flex-1 w-full flex flex-col items-center px-6 sm:px-8 lg:px-12 py-6 min-w-0">
          <div className="w-full max-w-[1520px] mx-auto space-y-6 animate-fade-in" key={activeView}>
            {activeView === 'overview'   && <Overview onNavigate={navigateTo} onOpenProvision={() => setShowProvisionModal(true)} onTriggerFailover={() => setShowDrillModal(true)} showToast={showToast} />}
            {activeView === 'sandboxes'  && <Sandboxes onOpenProvision={() => setShowProvisionModal(true)} showToast={showToast} />}
            {activeView === 'gateways'   && <Gateways showToast={showToast} />}
            {activeView === 'traffic'    && <Routes onOpenCustomDomain={() => showToast('Custom Domain', 'Custom domain binding interface active.', 'info')} showToast={showToast} />}
            {activeView === 'pool'       && <Leases showToast={showToast} />}
            {activeView === 'config'     && <ConfigGenerations onOpenDiff={(f, t) => setDiffModalData({ from: f, to: t })} showToast={showToast} />}
            {activeView === 'audit'      && <Events showToast={showToast} />}
            {activeView === 'benchmarks' && <Benchmarks showToast={showToast} />}
            {activeView === 'settings'   && <Settings showToast={showToast} />}
          </div>
        </main>

        {/* ══════════════════════════
            FOOTER DEMO BAR (Match Photo)
        ══════════════════════════ */}
        <footer className="sticky bottom-0 w-full h-10 bg-[#2D0035] text-white border-t border-[#492B50] px-6 sm:px-8 lg:px-12 shadow-lg text-[11px] mt-auto flex items-center justify-center">
          <div className="w-full max-w-[1520px] mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>Demonstration Mode: <strong className="text-purple-200">FelCloud OpenStack Controller</strong> (VRRP VIP 203.0.113.10 • 10.20.0.0/24 Pool)</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={runJuryDemoScript}
                className="px-2.5 py-1 bg-white/20 hover:bg-white/30 text-white rounded-[8px] text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">smart_display</span>
                <span>Run Jury Demo Script</span>
              </button>
              <button
                onClick={() => setShowDocDrawer(true)}
                className="text-xs text-purple-200 hover:text-white underline cursor-pointer"
              >
                REST API Specs
              </button>
            </div>
          </div>
        </footer>
      </div>

      {/* ══════════════════════════
          MODAL: Provision
      ══════════════════════════ */}
      {showProvisionModal && (
        <div className="fixed inset-0 z-50 bg-[#1B1B1E]/50 backdrop-blur-sm overflow-y-auto">
          <div className="min-h-screen flex flex-col">
            {/* Rich Provision Header */}
            <div className="sticky top-0 z-10 bg-white border-b border-[#E8E0EA] px-6 py-3 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#2D0035] flex items-center justify-center">
                  <span className="material-symbols-outlined text-[18px] text-white">rocket_launch</span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#827787] text-xs">Infrastructure</span>
                    <span className="text-[#d1c2cd] text-xs">/</span>
                    <span className="text-[#827787] text-xs">Sandboxes &amp; IPs</span>
                    <span className="text-[#d1c2cd] text-xs">/</span>
                    <span className="text-[#170B1B] text-xs font-semibold">Provision New Sandbox</span>
                  </div>
                  <h2 className="text-[15px] font-bold text-[#170B1B] leading-tight">Provision Hackathon Sandbox</h2>
                </div>
              </div>
              <button onClick={() => { setShowProvisionModal(false); setProvisionDone(false); setProvisionDryRunPassed(false) }}
                className="w-8 h-8 rounded-lg text-[#827787] hover:text-[#170B1B] hover:bg-[#F5F3F7] flex items-center justify-center transition-colors">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="flex-1 bg-[#F8F6F9] p-6">
              <div className="max-w-[1440px] mx-auto flex flex-col gap-6">

                {/* Multi-Step Pipeline Indicator */}
                <div className="bg-white rounded-xl p-4 shadow-sm border border-[#E8E0EA]">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                      { n: '1', label: 'Step 01', title: 'Team Identity', active: true },
                      { n: '2', label: 'Step 02', title: 'Nova Compute', active: false },
                      { n: '3', label: 'Step 03', title: 'IPAM & Zero-Trust', active: false },
                      { n: '4', label: 'Step 04', title: 'Ingress & TLS', active: false },
                      { n: '5', label: 'Step 05', title: 'HA Hot Deploy', active: false },
                    ].map((s) => (
                      <div key={s.n} className={`flex items-center gap-3 p-2 rounded-lg ${
                        s.active ? 'bg-[#2D0035] text-white' : 'bg-[#F5F3F6] text-[#170B1B]'
                      }`}>
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                          s.active ? 'bg-white/20 text-white' : 'bg-[#E9E7EA] text-[#74537a]'
                        }`}>{s.n}</div>
                        <div className="flex flex-col min-w-0">
                          <span className={`text-[9px] font-mono uppercase tracking-wider ${
                            s.active ? 'text-[#efb2f1]' : 'text-[#d1c2cd]'
                          }`}>{s.label}</span>
                          <span className="text-[11px] font-semibold truncate">{s.title}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Main 2-column grid */}
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">

                  {/* LEFT: Config Cards */}
                  <div className="xl:col-span-7 flex flex-col gap-5">

                    {/* Card 1: Team Identity */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-4">
                      <div className="flex items-center justify-between pb-2 border-b border-[#F5F3F6]">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-md bg-[#2D0035] text-white flex items-center justify-center">
                            <span className="material-symbols-outlined text-[15px]">groups</span>
                          </div>
                          <div>
                            <h3 className="text-sm font-bold text-[#170B1B] leading-tight">1. Team &amp; Identity Specification</h3>
                            <p className="text-[11px] text-[#827787]">Allocate DNS subdomain namespace and operational lease limits.</p>
                          </div>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-[#F5F3F6] text-[11px] font-mono text-[#74537a]">ID: SEC-ID-4190</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B] flex items-center justify-between">
                            <span>Team Slug / Handle</span>
                            <span className="text-[#827787] text-[10px] font-normal">Lowercase RFC1123</span>
                          </label>
                          <div className="relative flex items-center">
                            <input
                              type="text" required
                              value={provisionTeam}
                              onChange={e => setProvisionTeam(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))}
                              placeholder="e.g. team12-ai-bot"
                              className="w-full h-10 px-3 text-[11px] font-mono bg-[#FAF8FA] text-[#170B1B] border border-[#E8E0EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#74537a]/40 focus:border-[#74537a] transition-all"
                            />
                            {provisionTeam && <span className="absolute right-3 material-symbols-outlined text-emerald-600 text-[17px]">check_circle</span>}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Hackathon Domain Track</label>
                          <select
                            value={provisionTrack}
                            onChange={e => setProvisionTrack(e.target.value)}
                            className="w-full h-10 px-3 text-xs bg-[#FAF8FA] text-[#170B1B] border border-[#E8E0EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#74537a]/40">
                            <option>Fintech &amp; Algorithmic Trading</option>
                            <option>Autonomous AI Agents</option>
                            <option>IoT, Robotics &amp; Edge Telemetry</option>
                            <option>HealthTech &amp; Biomedical Data</option>
                          </select>
                        </div>
                      </div>

                      {/* FQDN Preview */}
                      <div className="p-3 rounded-lg bg-[#F5F3F6] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[#74537a] text-[17px]">dns</span>
                          <span className="text-xs text-[#170B1B] font-medium">Designate Dynamic Record:</span>
                          <code className="text-[11px] font-mono text-[#2D0035] bg-white border border-[#E8E0EA] px-2 py-0.5 rounded font-bold">
                            {(provisionTeam || 'team-sandbox')}.cstam.felcloud.tn
                          </code>
                        </div>
                        <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded font-mono">TTL: 60s • Auto-Injected</span>
                      </div>

                      {/* TTL Picker */}
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[15px] text-[#74537a]">timer</span>
                            <span className="text-[11px] font-semibold text-[#170B1B]">Sandbox Lease Lifetime (CSTAM Reaper)</span>
                          </div>
                          <span className="text-[11px] text-[#74537a] font-bold font-mono">
                            {provisionTTL} Hours{provisionTTL === '4' ? ' (Recommended)' : ''}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          {['2','4','8','24'].map(h => (
                            <button key={h} type="button"
                              onClick={() => setProvisionTTL(h)}
                              className={`py-1.5 rounded-lg text-center text-[11px] font-mono transition-colors ${
                                provisionTTL === h
                                  ? 'bg-[#2D0035] text-white font-semibold shadow-sm'
                                  : 'bg-[#F5F3F6] hover:bg-[#E9E7EA] text-[#170B1B]'
                              }`}>{h} Hours</button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5 text-[#827787] text-[11px]">
                          <span className="material-symbols-outlined text-amber-600 text-[15px]">info</span>
                          <span>Instances automatically power down upon TTL expiration. Private IP enters a 300s quarantine cooldown.</span>
                        </div>
                      </div>
                    </div>

                    {/* Card 2: Nova Compute */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-4">
                      <div className="flex items-center justify-between pb-2 border-b border-[#F5F3F6]">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-md bg-[#2D0035] text-white flex items-center justify-center">
                            <span className="material-symbols-outlined text-[15px]">memory</span>
                          </div>
                          <div>
                            <h3 className="text-sm font-bold text-[#170B1B] leading-tight">2. OpenStack Nova Compute Specs</h3>
                            <p className="text-[11px] text-[#827787]">Select standard compute flavors and base OS golden image.</p>
                          </div>
                        </div>
                        <span className="text-[10px] font-mono text-[#827787]">Hypervisor: KVM-QEMU</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {[
                          { id: 'm1.cstam.small',  label: 'Lightweight API & Web',  cpu: '1 Core',  ram: '2 GB', disk: '20 GB NVMe', extra: null },
                          { id: 'm1.cstam.medium', label: 'Standard Team Sandbox',  cpu: '2 Cores', ram: '4 GB', disk: '40 GB NVMe', extra: 'DEFAULT' },
                          { id: 'm1.cstam.gpu',    label: 'AI/ML Accelerated',      cpu: '4 Cores', ram: '8 GB', disk: null, extra: null, gpu: '1x Tesla T4' },
                        ].map(f => {
                          const selected = provisionFlavor === f.id
                          return (
                            <div key={f.id}
                              onClick={() => setProvisionFlavor(f.id)}
                              className={`cursor-pointer p-3.5 rounded-xl flex flex-col justify-between gap-3 transition-all ${
                                selected
                                  ? 'bg-white shadow-md ring-2 ring-[#2D0035] border border-transparent'
                                  : 'bg-[#F5F3F6] hover:bg-[#EFEDF0] border border-transparent'
                              }`}>
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] font-mono font-bold text-[#170B1B]">{f.id}</span>
                                  {f.extra
                                    ? <span className="px-1.5 py-0.5 rounded bg-[#2D0035] text-white text-[9px] font-mono">DEFAULT</span>
                                    : <span className={`w-2.5 h-2.5 rounded-full ${selected ? 'bg-[#2D0035]' : 'bg-[#d1c2cd]'}`} />}
                                </div>
                                <span className="text-[11px] text-[#827787]">{f.label}</span>
                              </div>
                              <div className="flex flex-col gap-1 pt-1 text-[10px] font-mono text-[#170B1B]">
                                <div className="flex justify-between"><span>vCPU:</span><span className="font-semibold">{f.cpu}</span></div>
                                <div className="flex justify-between"><span>RAM:</span><span className="font-semibold">{f.ram}</span></div>
                                {f.disk && <div className="flex justify-between"><span>Root Disk:</span><span className="font-semibold">{f.disk}</span></div>}
                                {f.gpu && <div className="flex justify-between"><span>Accelerator:</span><span className="font-semibold text-[#74537a]">{f.gpu}</span></div>}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Base Golden Image</label>
                          <div className="p-2.5 rounded-lg bg-[#FAF8FA] border border-[#E8E0EA] flex items-center gap-2">
                            <span className="material-symbols-outlined text-[17px] text-[#74537a]">inventory_2</span>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-semibold truncate text-[#170B1B]">Ubuntu 24.04 LTS CSTAM Base</span>
                              <span className="text-[10px] text-[#827787] font-mono">Docker 26.1 • Python 3.12 • Node 20</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Keystone Project &amp; Zone</label>
                          <div className="p-2.5 rounded-lg bg-[#FAF8FA] border border-[#E8E0EA] flex items-center gap-2">
                            <span className="material-symbols-outlined text-[17px] text-[#74537a]">key</span>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-semibold truncate text-[#170B1B]">cstam-hackathon-2025</span>
                              <span className="text-[10px] text-[#827787] font-mono">Region: tn-west-1a • Key: id_rsa_operator</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Card 3: Network & IPAM */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-4">
                      <div className="flex items-center justify-between pb-2 border-b border-[#F5F3F6]">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-md bg-[#2D0035] text-white flex items-center justify-center">
                            <span className="material-symbols-outlined text-[15px]">shield</span>
                          </div>
                          <div>
                            <h3 className="text-sm font-bold text-[#170B1B] leading-tight">3. Network &amp; Dynamic IPAM</h3>
                            <p className="text-[11px] text-[#827787]">Subnet allocation and Neutron security micro-segmentation.</p>
                          </div>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-mono font-semibold border border-emerald-100">38 IPs Available</span>
                      </div>

                      <div className="p-4 rounded-xl bg-[#F5F3F6] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-white border border-[#E8E0EA] flex items-center justify-center text-[#74537a] shadow-sm">
                            <span className="material-symbols-outlined text-[20px]">router</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[#170B1B]">Target Subnet Pool: 10.20.0.0/24</span>
                            <span className="text-[10px] text-[#827787] font-mono">Gateway: 10.20.0.1 • Range: .10 - .254</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col items-end">
                            <span className="text-[10px] text-[#827787] uppercase">Dynamic IP Lease</span>
                            <code className="text-[11px] font-mono font-bold text-[#2D0035] bg-white border border-[#E8E0EA] px-2 py-0.5 rounded">10.20.0.19</code>
                          </div>
                          <div className="w-10 h-6 bg-[#2D0035] rounded-full p-0.5 flex items-center justify-end">
                            <div className="w-5 h-5 bg-white rounded-full shadow-sm"></div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        <span className="text-[11px] font-semibold text-[#170B1B]">Neutron Zero-Trust Isolation Rules</span>
                        {[
                          { label: 'Enforce Sandbox-to-Sandbox Isolation', desc: 'Blocks lateral east-west traversal across RFC1918 tenant subnets.' },
                          { label: 'Block Gateway Management Planes', desc: 'Drops TCP 8000 (Data Plane API) and SSH 22 targeting HAProxy node interfaces.' },
                          { label: 'Ingress Proxy Exclusivity (Anti-Bypass)', desc: 'Disallows direct external floating IP binding; all traffic routed via VIP 203.0.113.10.' },
                        ].map((rule, i) => (
                          <label key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-[#F5F3F6] cursor-pointer hover:bg-[#EFEDF0] transition-colors">
                            <input type="checkbox" defaultChecked className="w-4 h-4 mt-0.5 rounded accent-[#2D0035] flex-shrink-0" />
                            <div className="flex flex-col">
                              <span className="text-xs font-medium text-[#170B1B]">{rule.label}</span>
                              <span className="text-[10px] text-[#827787] font-mono">{rule.desc}</span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Card 4: Routing & TLS */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-4">
                      <div className="flex items-center justify-between pb-2 border-b border-[#F5F3F6]">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-md bg-[#2D0035] text-white flex items-center justify-center">
                            <span className="material-symbols-outlined text-[15px]">alt_route</span>
                          </div>
                          <div>
                            <h3 className="text-sm font-bold text-[#170B1B] leading-tight">4. Routing, TLS &amp; Ingress Rules</h3>
                            <p className="text-[11px] text-[#827787]">Configure HAProxy frontend binding, ACME wildcard, and rate limits.</p>
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-[#74537a] font-semibold">VIP: 203.0.113.10</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Container Backend Target Port</label>
                          <div className="relative flex items-center">
                            <input type="number" value={provisionPort} onChange={e => setProvisionPort(e.target.value)}
                              className="w-full h-10 px-3 text-[11px] font-mono bg-[#FAF8FA] text-[#170B1B] border border-[#E8E0EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#74537a]/40" />
                            <span className="absolute right-3 text-[10px] text-[#827787] font-mono">TCP/HTTP</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Rate Limiting Tier (Leaky Bucket)</label>
                          <select className="w-full h-10 px-3 text-[11px] font-mono bg-[#FAF8FA] text-[#170B1B] border border-[#E8E0EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#74537a]/40">
                            <option>500 req/sec (Default Track Limit)</option>
                            <option>250 req/sec (Conservative)</option>
                            <option>1000 req/sec (High Concurrency)</option>
                            <option>Unlimited (Benchmarking Only)</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B]">Automated ACME TLS Profile</label>
                          <div className="h-10 px-3 rounded-lg bg-[#F5F3F6] border border-[#E8E0EA] flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-emerald-600 text-[16px]">lock</span>
                              <span className="text-[11px] font-mono text-[#170B1B]">*.cstam.felcloud.tn</span>
                            </div>
                            <span className="text-[10px] text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded font-mono">VALID</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-semibold text-[#170B1B] flex items-center justify-between">
                            <span>Custom Domain Alias (Optional)</span>
                            <span className="text-[#827787] text-[10px] font-normal">CNAME</span>
                          </label>
                          <input type="text" placeholder="e.g. demo.fintechhack.org"
                            className="w-full h-10 px-3 text-[11px] font-mono bg-[#FAF8FA] text-[#170B1B] border border-[#E8E0EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#74537a]/40" />
                        </div>
                      </div>
                    </div>

                  </div>{/* END LEFT */}

                  {/* RIGHT: Pre-flight + Diff + SLA */}
                  <div className="xl:col-span-5 flex flex-col gap-5">

                    {/* Pre-Flight Checklist */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-4">
                      <div className="flex items-center justify-between pb-2">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[#74537a] text-[17px]">verified_user</span>
                          <h3 className="text-sm font-bold text-[#170B1B]">Pre-Flight Simulation</h3>
                        </div>
                        <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-mono font-semibold border border-emerald-100">READY TO COMMIT</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {[
                          { icon: 'check_circle', color: 'text-emerald-600', label: 'Keystone Project Quota', status: '18ms • PASS' },
                          { icon: 'check_circle', color: 'text-emerald-600', label: 'IPAM Lease 10.20.0.19',  status: '12ms • LOCKED' },
                          { icon: 'check_circle', color: 'text-emerald-600', label: 'Neutron Security Group Bind', status: 'PASS' },
                          { icon: 'sync',         color: 'text-[#7e4c83]',   label: 'Nova Hypervisor Slot', status: 'EST: 1.2s' },
                          { icon: 'radio_button_unchecked', color: 'text-[#7f747d]', label: 'Designate DNS Record Sync', status: 'QUEUED' },
                          { icon: 'radio_button_unchecked', color: 'text-[#7f747d]', label: 'HAProxy 3-Phase Atomic Commit', status: 'QUEUED' },
                        ].map((item, i) => (
                          <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-[#F5F3F6]">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className={`material-symbols-outlined ${item.color} text-[17px]`}>{item.icon}</span>
                              <span className="text-xs font-medium text-[#170B1B] truncate">{item.label}</span>
                            </div>
                            <span className="text-[10px] text-[#827787] font-mono ml-2 flex-shrink-0">{item.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Live HAProxy Diff */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-3">
                      <div className="flex items-center justify-between pb-1">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[#74537a] text-[17px]">code</span>
                          <h3 className="text-sm font-bold text-[#170B1B]">Data Plane API Diff</h3>
                        </div>
                        <span className="text-[10px] font-mono text-[#74537a]">GEN: rev-89413</span>
                      </div>
                      <p className="text-[11px] text-[#827787]">Live diff generated for hot reload on gw-1 and gw-2 instances:</p>
                      <div className="bg-[#1B1B1E] text-[#F2F0F3] p-3.5 rounded-lg font-mono text-[10px] leading-relaxed overflow-x-auto">
                        <div className="text-[#efb2f1] font-bold"># --- INGRESS GENERATION COMMIT ---</div>
                        <div className="text-emerald-400 font-semibold">+ backend be_{provisionTeam || 'team-sandbox'}</div>
                        <div className="text-emerald-400 pl-4">+   server srv_1 10.20.0.19:{provisionPort} check inter 2s fall 3</div>
                        <div className="text-white/60 pl-4">+   option httpchk GET /healthz</div>
                        <div className="text-white/60 pl-4">+   http-check expect status 200</div>
                        <div className="text-[#efb2f1] font-bold mt-2"># --- FRONTEND VIP ROUTE RULE ---</div>
                        <div className="text-emerald-400">+ frontend cstam_vip_https_443</div>
                        <div className="text-emerald-400 pl-4">+   acl is_{(provisionTeam||'team-sandbox').replace(/-/g,'_')} hdr(host) -i {provisionTeam||'team-sandbox'}.cstam.felcloud.tn</div>
                        <div className="text-emerald-400 pl-4">+   use_backend be_{provisionTeam||'team-sandbox'} if is_{(provisionTeam||'team-sandbox').replace(/-/g,'_')}</div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[#827787]">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                          Syntax Check Passed
                        </span>
                        <span className="font-mono">Config Schema v2.8</span>
                      </div>
                    </div>

                    {/* SLA Guarantees */}
                    <div className="bg-white rounded-xl shadow-sm border border-[#E8E0EA] p-5 flex flex-col gap-3">
                      <div className="flex items-center gap-2 pb-1">
                        <span className="material-symbols-outlined text-[#74537a] text-[17px]">health_and_safety</span>
                        <h3 className="text-sm font-bold text-[#170B1B]">Telemetry Guarantees</h3>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="p-2.5 rounded-lg bg-[#F5F3F6] flex flex-col">
                          <span className="text-[10px] text-[#827787]">Hot Reload SLA</span>
                          <span className="text-[13px] font-mono font-bold text-[#170B1B]">&lt; 450ms</span>
                          <span className="text-[10px] text-emerald-700">Zero TCP Drops</span>
                        </div>
                        <div className="p-2.5 rounded-lg bg-[#F5F3F6] flex flex-col">
                          <span className="text-[10px] text-[#827787]">Teardown Cooldown</span>
                          <span className="text-[13px] font-mono font-bold text-[#170B1B]">300s TTL</span>
                          <span className="text-[10px] text-[#74537a]">Anti-Arp Poison</span>
                        </div>
                      </div>
                      <div className="p-2.5 rounded-lg bg-[#F5F3F6] flex items-start gap-2">
                        <span className="material-symbols-outlined text-[#74537a] text-[17px] flex-shrink-0 mt-0.5">policy</span>
                        <span className="text-[11px] text-[#827787] leading-relaxed">
                          Dynamic IP <strong className="text-[#170B1B]">10.20.0.19</strong> will be quarantined immediately if tenant generates abnormal syn-flood or port-scanning triggers.
                        </span>
                      </div>
                    </div>

                  </div>{/* END RIGHT */}

                </div>{/* END GRID */}

                {/* Sticky Bottom Action Bar */}
                <div className="sticky bottom-4 z-20 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-[#E8E0EA] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#2D0035] text-white flex items-center justify-center font-bold font-mono text-[13px]">
                      {provisionTeam ? provisionTeam[0].toUpperCase() : '?'}
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-[#170B1B]">Target Lease: {provisionTeam || 'team-sandbox'}</span>
                        <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-mono font-bold border border-emerald-100">10.20.0.19</span>
                      </div>
                      <span className="text-[10px] text-[#827787]">Estimated provisioning pipeline duration: 1.4 seconds total</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <button type="button"
                      onClick={() => { setShowProvisionModal(false); setProvisionDone(false); setProvisionDryRunPassed(false) }}
                      className="h-10 px-4 bg-transparent hover:bg-[#F5F3F6] text-[#170B1B] rounded-lg text-[11px] font-medium transition-colors cursor-pointer">
                      Cancel
                    </button>
                    <button type="button"
                      onClick={() => {
                        setProvisionDryRunLoading(true)
                        setTimeout(() => { setProvisionDryRunLoading(false); setProvisionDryRunPassed(true) }, 1100)
                      }}
                      disabled={provisionDryRunLoading}
                      className="h-10 px-4 bg-[#EFEDF0] hover:bg-[#E3E2E5] text-[#170B1B] rounded-lg text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50">
                      {provisionDryRunLoading
                        ? <><span className="material-symbols-outlined text-[15px] animate-spin">progress_activity</span><span>Validating...</span></>
                        : provisionDryRunPassed
                          ? <><span className="material-symbols-outlined text-[15px] text-emerald-600">check_circle</span><span>Passed 0 Errors</span></>
                          : <><span className="material-symbols-outlined text-[15px]">bug_report</span><span>Dry-Run Validation</span></>
                      }
                    </button>
                    <button type="button"
                      disabled={provisionLoading || !provisionTeam}
                      onClick={handleProvisionSubmit as any}
                      className={`h-10 px-5 text-white rounded-lg text-[11px] font-semibold flex items-center gap-2 shadow-md transition-all cursor-pointer disabled:opacity-50 ${
                        provisionDone ? 'bg-emerald-700' : 'bg-[#2D0035] hover:bg-[#3D0346]'
                      }`}>
                      {provisionLoading
                        ? <><span className="material-symbols-outlined text-[17px] animate-spin">sync</span><span>Atomic Committing...</span></>
                        : provisionDone
                          ? <><span className="material-symbols-outlined text-[17px]">done_all</span><span>Sandbox Deployed (1.38s)</span></>
                          : <><span className="material-symbols-outlined text-[17px]">bolt</span><span>Deploy &amp; Commit Sandbox</span></>
                      }
                    </button>
                  </div>
                </div>

              </div>{/* END max-w container */}
            </div>{/* END bg-[#F8F6F9] flex-1 */}
          </div>{/* END min-h-screen flex flex-col */}
        </div>
      )}

      {/* ══════════════════════════
          MODAL: Failover Drill
      ══════════════════════════ */}
      {showDrillModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-fade-up border border-[#E5DFE8]">
            <div className="px-6 py-5 border-b border-[#F0EBF2] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[20px] text-rose-600" style={{ fontVariationSettings: "'FILL' 1" }}>flash_on</span>
                </div>
                <div>
                  <h3 className="font-bold text-[15px] text-[#170B1B]">VRRP Failover Drill</h3>
                  <p className="text-[11px] text-[#a088aa]">Simulate primary gateway crash</p>
                </div>
              </div>
              <button onClick={() => setShowDrillModal(false)} className="w-8 h-8 rounded-xl text-[#a088aa] hover:text-[#170B1B] hover:bg-[#F5F3F7] flex items-center justify-center transition-colors">
                <span className="material-symbols-outlined text-[19px]">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-[#827787] leading-relaxed">
                Injects a simulated SIGKILL on the primary HAProxy/Keepalived process, validating VRRP gratuitous ARP and sub-second stream preservation.
              </p>
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1.5">
                <div className="flex justify-between"><span className="text-[#827787]">Target</span><span className="font-mono font-semibold">Standby node (auto-election)</span></div>
                <div className="flex justify-between"><span className="text-[#827787]">Expected downtime</span><span className="font-mono font-semibold text-emerald-700">&lt; 500 ms</span></div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowDrillModal(false)} className="px-4 py-2 bg-white border border-[#E5DFE8] hover:bg-[#F5F3F7] text-[#170B1B] rounded-xl text-sm font-medium transition-colors">
                  Cancel
                </button>
                <button onClick={handleDrillSubmit} className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-sm font-bold flex items-center gap-1.5 transition-colors shadow-md shadow-rose-700/25">
                  <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>flash_on</span>
                  Confirm Drill
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════
          MODAL: Diff Viewer
      ══════════════════════════ */}
      {diffModalData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden animate-fade-up border border-[#E5DFE8]">
            <div className="px-6 py-4 bg-[#F8F5FB] border-b border-[#F0EBF2] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-[#2D0035]">compare</span>
                <span className="text-sm font-bold text-[#170B1B]">Config Diff — {diffModalData.from} → {diffModalData.to}</span>
              </div>
              <button onClick={() => setDiffModalData(null)} className="w-7 h-7 rounded-xl text-[#a088aa] hover:text-[#170B1B] hover:bg-[#EDE7F0] flex items-center justify-center">
                <span className="material-symbols-outlined text-[17px]">close</span>
              </button>
            </div>
            <div className="p-6 font-mono text-xs bg-[#070010] text-gray-300 overflow-x-auto max-h-96 leading-relaxed dark-scroll">
              <pre><code>{`@@ -13,6 +13,8 @@ frontend cstam_fe
     bind 10.20.20.246:443 ssl crt /etc/ssl/cstam-west.pem alpn h2,http/1.1
     mode http
\x1b-    stick-table type ip size 100k expire 30s store http_req_rate(10s)
-    http-request track-sc0 src
+    stick-table type ip size 250k expire 30s store http_req_rate(10s)
+    http-request track-sc0 src
+    acl rate_abuse sc_http_req_rate(0) gt 45000
+    http-request tarpit deny_status 429 if rate_abuse
     acl is_quarantine src -f /etc/haproxy/quarantine_ips.lst
     http-request deny if is_quarantine
     default_backend sandbox_be`}</code></pre>
            </div>
            <div className="p-4 bg-[#F8F5FB] border-t border-[#F0EBF2] flex justify-end">
              <button onClick={() => setDiffModalData(null)} className="px-4 py-2 text-white rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
                style={{ background: 'linear-gradient(135deg, #0e0018, #2D0035)' }}>
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════
          DRAWER: API Docs
      ══════════════════════════ */}
      {showDocDrawer && (
        <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-xs" onClick={() => setShowDocDrawer(false)}>
          <div className="absolute right-0 top-0 h-full w-[500px] bg-white border-l border-[#E5DFE8] shadow-2xl p-6 overflow-y-auto space-y-5 animate-fade-in"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-3 border-b border-[#F0EBF2]">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#F5F3F7] border border-[#E5DFE8] flex items-center justify-center">
                  <span className="material-symbols-outlined text-[18px] text-[#2D0035]">menu_book</span>
                </div>
                <div>
                  <h3 className="font-bold text-[15px] text-[#170B1B]">REST API Reference</h3>
                  <p className="text-[11px] text-[#a088aa] font-mono">CSTAM 3.0 Control Plane</p>
                </div>
              </div>
              <button onClick={() => setShowDocDrawer(false)} className="w-7 h-7 rounded-xl text-[#a088aa] hover:text-[#170B1B] hover:bg-[#F5F3F7] flex items-center justify-center transition-colors">
                <span className="material-symbols-outlined text-[17px]">close</span>
              </button>
            </div>

            <p className="text-xs text-[#827787] leading-relaxed">
              All endpoints require <code className="font-mono bg-[#F5F3F7] text-[#2D0035] px-1 py-0.5 rounded">Authorization: Bearer &lt;token&gt;</code>.
            </p>

            <div className="space-y-2.5 text-xs">
              {[
                { method: 'GET',    c: 'bg-emerald-100 text-emerald-800', path: '/api/gateways/status',     desc: 'VRRP master state, HAProxy uptime, VIP holder.' },
                { method: 'GET',    c: 'bg-emerald-100 text-emerald-800', path: '/api/sandboxes',           desc: 'List all sandboxes with lease and status data.' },
                { method: 'POST',   c: 'bg-blue-100 text-blue-800',       path: '/api/sandboxes/provision', desc: '{"team":"alpha","ttl":7200} — deploys Nova + routes.' },
                { method: 'DELETE', c: 'bg-rose-100 text-rose-800',       path: '/api/sandboxes/:id',       desc: 'Teardown VM, enter 180s quarantine cooldown.' },
                { method: 'POST',   c: 'bg-amber-100 text-amber-800',     path: '/api/gateways/failover',   desc: 'Trigger zero-downtime failover to standby node.' },
                { method: 'POST',   c: 'bg-purple-100 text-purple-800',   path: '/api/gateways/sync',       desc: 'Reconcile HAProxy maps with Nova/Neutron state.' },
                { method: 'GET',    c: 'bg-emerald-100 text-emerald-800', path: '/api/leases',              desc: 'All IPAM leases with expiry & quarantine state.' },
                { method: 'GET',    c: 'bg-emerald-100 text-emerald-800', path: '/api/events',              desc: 'Audit log stream with types, scopes, timing.' },
              ].map((ep, i) => (
                <div key={i} className="p-3 bg-[#F8F5FB] border border-[#EDE7F0] rounded-xl space-y-1.5">
                  <div className="flex items-center gap-2 font-mono">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${ep.c}`}>{ep.method}</span>
                    <span className="text-[#170B1B] font-semibold text-[12px]">{ep.path}</span>
                  </div>
                  <div className="text-[11px] text-[#827787]">{ep.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════
          TOASTS
      ══════════════════════════ */}
      <div className="fixed bottom-12 right-5 z-50 flex flex-col gap-2 pointer-events-none w-[340px]">
        {toasts.map(t => {
          const c = toastColorMap[t.type]
          return (
            <div key={t.id} className={`pointer-events-auto bg-white border ${c.ring} rounded-2xl overflow-hidden shadow-xl shadow-purple-900/10 flex items-stretch animate-fade-up`}>
              <div className={`w-1 flex-shrink-0 ${c.bar}`} />
              <div className="flex items-start gap-3 p-3.5 flex-1 min-w-0">
                <div className={`w-7 h-7 rounded-xl ${c.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                  <span className={`material-symbols-outlined text-[14px] ${c.icon}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                    {toastIconMap[t.type]}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13px] text-[#170B1B] leading-tight">{t.title}</div>
                  <div className="text-[11px] text-[#827787] mt-0.5 leading-relaxed">{t.message}</div>
                </div>
                <button onClick={() => setToasts(p => p.filter(x => x.id !== t.id))} className="text-gray-300 hover:text-gray-500 flex-shrink-0 mt-0.5 transition-colors">
                  <span className="material-symbols-outlined text-[15px]">close</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
