// ── API Client ─────────────────────────────────────────────────────────────────
// Thin wrapper around fetch that injects Authorization: Bearer <token>.
// On 401 the caller should clear the token and redirect to login.

export class ApiError extends Error {
  status: number
  detail: string
  constructor(status: number, msg: string, detail = '') {
    super(msg)
    this.status = status
    this.detail = detail
  }
}

let _token = ''

export function setToken(t: string) { _token = t }
export function getToken(): string { return _token }
export function clearToken() { _token = '' }

/** Restore token from sessionStorage on page load (optional persistence). */
export function restoreToken(): boolean {
  const t = sessionStorage.getItem('fc_token')
  if (t) { _token = t; return true }
  return false
}

/** Persist token in sessionStorage (never localStorage or URL). */
export function persistToken(t: string) {
  _token = t
  sessionStorage.setItem('fc_token', t)
}

export function forgetToken() {
  _token = ''
  sessionStorage.removeItem('fc_token')
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (_token) headers['Authorization'] = `Bearer ${_token}`
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    forgetToken()
    throw new ApiError(401, 'Unauthorized')
  }

  if (res.status === 204) return undefined as T

  const data = await res.json()
  if (!res.ok) {
    throw new ApiError(res.status, data.error || res.statusText, data.detail || '')
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

// ── Typed API helpers ──────────────────────────────────────────────────────────

export interface ConfigResponse {
  routing_domain: string
  vip_address: string
  version: string
  provisioner: string
}

export interface GatewayInfo {
  reachable: boolean
  haproxy: string
  keepalived: string
  vip_holder_local: boolean
  probed_at: string
  error: string
}

export interface GatewayStatus {
  gateways: Record<string, GatewayInfo>
  vip: string
  vip_holder: string
  latest_generation: string
  fetched_at_ms: number
}

export interface Sandbox {
  id?: number
  sandbox_id: string
  ip_address: string
  private_ip?: string
  hostname: string
  status: string
  created_at: string
  updated_at?: string
  expires_at: number | null
  custom_domain: string
  ttl_seconds: number
}

export interface LeaseEntry {
  id?: number
  sandbox_id: string
  entity_name?: string
  ip_address: string
  subnet_name?: string
  status: string
  created_at: string
  released_at: string | null
  expires_at: number | null
  ttl_seconds: number
}

export interface EventEntry {
  id: number
  scope: string
  event_type: string
  type?: string
  detail: string
  duration_ms: number
  created_at: string
}

export interface FailoverResponse {
  success: boolean
  before: string
  after: string
  downtime_ms: number
  failover_ms: number
  failed_requests: number
  total_requests: number
  serving_gateway_before: string
  serving_gateway_after: string
  verified_by: string
  mode: string
}

export interface LogsResponse {
  gateway: string
  source: string
  since: string
  limit: number
  count: number
  entries: string[]
}

export const fetchConfig = () => api.get<ConfigResponse>('/api/config')

export const fetchGatewayStatus = async (refresh = false): Promise<GatewayStatus> => {
  const data = await api.get<any>(`/api/gateways/status${refresh ? '?refresh=true' : ''}`)
  return {
    gateways: data?.gateways || {},
    vip: data?.vip || '',
    vip_holder: data?.vip_holder || '',
    latest_generation: data?.latest_generation || '',
    fetched_at_ms: data?.fetched_at_ms || Date.now(),
  }
}

export const fetchSandboxes = async (): Promise<Sandbox[]> => {
  const data = await api.get<any>('/api/sandboxes')
  const rawList: any[] = Array.isArray(data) ? data : (data?.sandboxes ?? [])
  return rawList.map((s: any) => ({
    id: s.id,
    sandbox_id: s.sandbox_id || '',
    ip_address: s.private_ip || s.ip_address || '',
    private_ip: s.private_ip || s.ip_address || '',
    hostname: s.hostname || '',
    status: s.status || '',
    created_at: s.created_at || '',
    updated_at: s.updated_at || '',
    expires_at: s.expires_at ?? null,
    custom_domain: s.custom_domain || '',
    ttl_seconds: s.ttl_remaining_seconds ?? s.ttl_seconds ?? 0,
  }))
}

export const fetchLeases = async (): Promise<LeaseEntry[]> => {
  const data = await api.get<any>('/api/leases')
  const rawList: any[] = Array.isArray(data) ? data : (data?.leases ?? [])
  return rawList.map((l: any) => ({
    id: l.id,
    sandbox_id: l.entity_name || l.sandbox_id || '',
    entity_name: l.entity_name || l.sandbox_id || '',
    ip_address: l.ip_address || '',
    subnet_name: l.subnet_name || '',
    status: l.status || '',
    created_at: l.created_at || l.assigned_at || '',
    released_at: l.released_at || l.quarantined_at || (l.status === 'RELEASED' ? l.quarantine_until : null) || null,
    expires_at: l.expires_at ?? null,
    ttl_seconds: l.ttl_seconds ?? 0,
  }))
}

export const fetchEvents = async (limit = 100): Promise<{ events: EventEntry[] }> => {
  const data = await api.get<any>(`/api/gateways/events?limit=${limit}`)
  const rawList: any[] = Array.isArray(data) ? data : (data?.events ?? [])
  const events = rawList.map((e: any) => ({
    id: e.id,
    scope: e.scope || (e.sandbox_id ? `sandbox:${e.sandbox_id}` : 'gateway'),
    event_type: e.event_type || e.type || 'info',
    type: e.type || e.event_type || 'info',
    detail: e.detail || '',
    duration_ms: e.duration_ms || 0,
    created_at: e.created_at || e.ts_iso || (e.ts_ms ? new Date(e.ts_ms).toISOString() : ''),
  }))
  return { events }
}

export const fetchLogs = (gw: string, source = 'haproxy', limit = 100) =>
  api.get<LogsResponse>(`/api/gateways/logs?gateway=${gw}&source=${source}&limit=${limit}`)

export const triggerFailover = (target?: string) =>
  api.post<FailoverResponse>('/api/gateways/failover', { target_gateway: target || '', mode: 'manual' })

export const triggerSync = (dryRun = false) =>
  api.post<{ success: boolean; message: string; duration_ms: number }>('/api/gateways/sync', { dry_run: dryRun })

export const triggerRollback = (gen?: string) =>
  api.post<{ success: boolean; generation: string; duration_ms: number }>('/api/gateways/rollback', { target_generation: gen || '' })

export const provisionSandbox = (team: string) =>
  api.post<Sandbox>('/api/sandboxes/provision', { team })

export const teardownSandbox = (id: string) =>
  api.delete<{ success: boolean }>(`/api/sandboxes/${id}`)

