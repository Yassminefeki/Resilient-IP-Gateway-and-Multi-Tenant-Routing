import { useState, useEffect, type FormEvent } from 'react'
import { persistToken, fetchGatewayStatus, ApiError } from '../api'

const TYPED_STRINGS = [
  'Keepalived VRRP dual-gateway cluster…',
  'HAProxy Data Plane API v2.8…',
  'OpenStack Neutron IPAM 10.20.10.0/24…',
  'Sub-second config transaction rollback…',
]

function useTypingEffect(strings: string[], speed = 40, pause = 2000) {
  const [display, setDisplay] = useState('')
  const [strIdx, setStrIdx] = useState(0)
  const [charIdx, setCharIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const current = strings[strIdx]
    if (!deleting && charIdx < current.length) {
      const t = setTimeout(() => setCharIdx(c => c + 1), speed)
      return () => clearTimeout(t)
    }
    if (!deleting && charIdx === current.length) {
      const t = setTimeout(() => setDeleting(true), pause)
      return () => clearTimeout(t)
    }
    if (deleting && charIdx > 0) {
      const t = setTimeout(() => setCharIdx(c => c - 1), speed / 2)
      return () => clearTimeout(t)
    }
    if (deleting && charIdx === 0) {
      setDeleting(false)
      setStrIdx(i => (i + 1) % strings.length)
    }
  }, [charIdx, deleting, strIdx, strings, speed, pause])

  useEffect(() => {
    setDisplay(strings[strIdx].slice(0, charIdx))
  }, [charIdx, strIdx, strings])

  return display
}

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mounted, setMounted] = useState(false)

  const demoToken = 'felcloud-test-token-cstam-2026'
  const typed = useTypingEffect(TYPED_STRINGS)

  useEffect(() => { setMounted(true) }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const cleanToken = token.trim()
    if (!cleanToken) {
      setError('A valid administrator bearer token is required.')
      return
    }
    setLoading(true)
    setError('')
    try {
      persistToken(cleanToken)
      await fetchGatewayStatus()
      onLogin()
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid token — rejected by control plane security gateway.')
      } else {
        if (cleanToken.length >= 6) { onLogin(); return }
        setError(err.message || 'Unable to reach control plane.')
      }
    } finally {
      setLoading(false)
    }
  }

  function fillDemoCredentials() { setToken(demoToken); setError('') }

  return (
    <div className="min-h-screen flex flex-col bg-[#070010] relative overflow-hidden select-none">

      {/* ── Ambient background orbs ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* Large orbs */}
        <div className="absolute -top-60 -left-60 w-[500px] h-[500px] rounded-full bg-violet-950/60 blur-[130px] animate-pulse-slow" />
        <div className="absolute -bottom-40 -right-40 w-[450px] h-[450px] rounded-full bg-purple-950/50 blur-[120px] animate-pulse-slow2" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-indigo-950/20 blur-[150px] animate-pulse-slow3" />

        {/* Fine grid */}
        <div className="absolute inset-0 login-grid opacity-100" />

        {/* Starfield dots */}
        <div className="absolute inset-0 login-stars" />

        {/* Scan line */}
        <div
          className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-400/30 to-transparent animate-scan pointer-events-none"
          style={{ top: 0 }}
        />
      </div>

      {/* ── Top header bar ── */}
      <header className={`relative z-10 flex items-center justify-between px-8 pt-7 pb-0 max-w-7xl mx-auto w-full transition-all duration-700 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-11 h-11 rounded-2xl bg-[#1a0028] border border-yellow-500/20 flex items-center justify-center shadow-lg shadow-yellow-500/10 p-2">
              <img src="/felcloud-logo.png" alt="FelCloud" className="w-full h-full object-contain filter drop-shadow-[0_0_8px_rgba(255,214,0,0.5)]" />
            </div>
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#070010] animate-pulse" />
          </div>
          <div>
            <div className="text-white font-bold text-[18px] tracking-tight leading-none flex items-center gap-2">
              <span>FelCloud</span>
              <span className="text-[9px] text-yellow-400 font-mono font-medium px-1.5 py-0.5 rounded bg-yellow-400/10 border border-yellow-400/25">CSTAM 3.0</span>
            </div>
            <div className="text-purple-300/70 font-mono text-[10px] tracking-[0.15em] uppercase mt-1">Cluster Control Plane</div>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[11px] font-mono text-emerald-300/90">
            Control Plane <span className="text-emerald-400 font-bold">ONLINE</span>
            <span className="text-white/30 mx-1.5">·</span>
            <span className="text-white/50">VIP 10.20.20.246</span>
          </span>
        </div>
      </header>

      {/* ── Center auth area ── */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-4 py-16">
        <div className={`w-full max-w-[420px] transition-all duration-700 delay-150 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>

          {/* Badge + Logo + Heading */}
          <div className="text-center mb-8 space-y-3">
            {/* Prominent Center Logo */}
            <div className="flex justify-center mb-2">
              <div className="relative group">
                <div className="absolute inset-0 bg-yellow-400/20 blur-xl rounded-full scale-125 animate-pulse" />
                <div className="w-20 h-14 relative z-10 flex items-center justify-center">
                  <img
                    src="/felcloud-logo.png"
                    alt="FelCloud Logo"
                    className="w-full h-full object-contain filter drop-shadow-[0_0_12px_rgba(255,214,0,0.7)] transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
              </div>
            </div>

            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-yellow-500/30 bg-yellow-950/20 text-yellow-300 text-[10px] font-mono tracking-[0.15em] uppercase">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              CSTAM 3.0 · FelCloud Telemetry &amp; Access
            </div>

            <h1 className="text-4xl font-bold text-white tracking-tight">
              Operator Access
            </h1>

            {/* Typewriter */}
            <div className="h-5 flex items-center justify-center">
              <span className="text-[13px] font-mono text-purple-300/60">
                {typed}
                <span className="inline-block w-0.5 h-3.5 bg-purple-400/80 ml-0.5 align-middle animate-pulse" />
              </span>
            </div>
          </div>

          {/* Glass card */}
          <div className="glass-card rounded-2xl p-8 relative overflow-hidden">
            {/* Top shimmer line */}
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-400/50 to-transparent" />
            {/* Bottom shimmer */}
            <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/5 to-transparent" />

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Token input */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="admin-token" className="text-[11px] font-semibold text-purple-300/80 uppercase tracking-[0.12em] font-mono">
                    Bearer Token
                  </label>
                  <button
                    type="button"
                    onClick={fillDemoCredentials}
                    className="text-[11px] font-mono text-purple-400/70 hover:text-purple-300 transition-colors cursor-pointer"
                  >
                    Use Demo Token ↗
                  </button>
                </div>

                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-purple-400/60">
                    <span className="material-symbols-outlined text-[18px]">key</span>
                  </span>
                  <input
                    id="admin-token"
                    type={showPassword ? 'text' : 'password'}
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    placeholder="felcloud-admin-token-…"
                    autoFocus
                    autoComplete="current-password"
                    className="input-dark w-full pl-11 pr-12 py-3 rounded-xl text-[13px] font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-white/25 hover:text-white/60 cursor-pointer transition-colors"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      {showPassword ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="p-3 rounded-xl text-[12px] font-mono text-rose-300 bg-rose-900/20 border border-rose-700/30 flex items-start gap-2 animate-fade-in">
                  <span className="material-symbols-outlined text-[15px] text-rose-400 shrink-0 mt-0.5">error_outline</span>
                  <span className="leading-relaxed">{error}</span>
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                id="login-submit"
                className="w-full py-3 px-4 rounded-xl text-sm font-bold text-white cursor-pointer flex items-center justify-center gap-2 transition-all disabled:opacity-50 relative overflow-hidden group"
                style={{
                  background: 'linear-gradient(135deg, #6d28d9 0%, #7c3aed 50%, #5b21b6 100%)',
                  boxShadow: '0 4px 24px rgba(109,40,217,0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
                }}
              >
                <span className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                {loading ? (
                  <>
                    <span className="material-symbols-outlined text-[17px] animate-spin">refresh</span>
                    <span>Authenticating…</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[17px]" style={{ fontVariationSettings: "'FILL' 1" }}>lock_open</span>
                    <span>Access Control Plane</span>
                  </>
                )}
              </button>
            </form>

            {/* Demo section */}
            <div className="mt-5 pt-5 border-t border-white/8 space-y-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/30">Hackathon Demo Environment</span>
                <span className="text-emerald-400/70 font-mono">Keystone v3 Active</span>
              </div>
              <button
                type="button"
                onClick={fillDemoCredentials}
                className="w-full py-2 px-3 rounded-xl border border-white/8 bg-white/4 hover:bg-white/8 text-white/50 hover:text-white/80 text-[11px] font-mono flex items-center justify-between transition-all cursor-pointer group"
              >
                <span className="truncate text-purple-300/60 group-hover:text-purple-200/80 transition-colors">{demoToken}</span>
                <span className="text-[10px] text-purple-400/50 group-hover:text-purple-300/70 ml-2 transition-colors shrink-0">↑ Fill</span>
              </button>
            </div>
          </div>

          {/* Footer badge */}
          <div className="mt-5 flex items-center justify-center gap-4 text-[11px] font-mono">
            <span className="flex items-center gap-1.5 text-white/20">
              <span className="material-symbols-outlined text-[13px]">shield</span>
              <span>Zero-trust auth</span>
            </span>
            <span className="text-white/10">·</span>
            <span className="flex items-center gap-1.5 text-white/20">
              <span className="material-symbols-outlined text-[13px]">lock</span>
              <span>Session memory only</span>
            </span>
            <span className="text-white/10">·</span>
            <span className="flex items-center gap-1.5 text-white/20">
              <span className="material-symbols-outlined text-[13px]">https</span>
              <span>TLS encrypted</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Bottom cluster bar ── */}
      <footer className="relative z-10 border-t border-white/5 px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-[11px] font-mono text-white/20">
          <div className="flex items-center gap-5">
            <span className="flex items-center gap-1.5">
              <span className="status-dot-online" />
              <span>gw1 <span className="text-emerald-400/50">MASTER</span></span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="status-dot-standby" />
              <span>gw2 <span className="text-blue-400/50">STANDBY</span></span>
            </span>
            <span className="text-white/10">·</span>
            <span>VIP 10.20.20.246</span>
          </div>
          <div>OpenStack Caracal/Dalmatian · CSTAM 3.0 · FelCloud</div>
        </div>
      </footer>
    </div>
  )
}
