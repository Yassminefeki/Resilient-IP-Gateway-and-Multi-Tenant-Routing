import { useState, useEffect, useCallback, useRef } from 'react'

/** Countdown that ticks every second. Returns remaining seconds. */
export function useCountdown(expiresAt: number | null): number {
  const [remaining, setRemaining] = useState(() => {
    if (!expiresAt) return 0
    return Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  })

  useEffect(() => {
    if (!expiresAt) { setRemaining(0); return }
    const tick = () => setRemaining(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  return remaining
}

/** Auto-refreshing data fetcher. */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcher()
      if (mountedRef.current) { setData(result); setError(null) }
    } catch (e: any) {
      if (mountedRef.current) setError(e.message || 'Unknown error')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled) return
    doFetch()
    const id = setInterval(doFetch, intervalMs)
    return () => { mountedRef.current = false; clearInterval(id) }
  }, [doFetch, intervalMs, enabled])

  return { data, error, loading, refresh: doFetch }
}

/** Format seconds into human readable (e.g. "2h 15m 30s") */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Expired'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

/** Validate DNS label for sandbox/team names. */
export function isValidDnsLabel(s: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(s) && !s.endsWith('-')
}
