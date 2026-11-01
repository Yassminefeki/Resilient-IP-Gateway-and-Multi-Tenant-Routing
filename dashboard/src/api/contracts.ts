/**
 * Proposed FelCloud API contract (see docs/API_CONTRACT.md).
 * These schemas validate every response; a response that does not match is
 * surfaced as an `invalid_response` error and never shown as a success.
 */
import { z } from 'zod';

const ts = z.string();

/* ------------------------------ capabilities ------------------------------ */

export const CAPABILITY_KEYS = [
  'sandbox_provision',
  'sandbox_teardown',
  'lease_reconcile',
  'gateway_failover',
  'failover_drill',
  'config_validate',
  'config_deploy',
  'config_rollback',
  'logs_haproxy',
  'logs_system',
  'benchmark_run',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string().optional(),
  checked_at: ts,
  components: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'degraded', 'down', 'unknown']),
      detail: z.string().optional(),
    }),
  ),
  capabilities: z.record(z.string(), z.boolean()),
});
export type Health = z.infer<typeof HealthSchema>;

/* --------------------------------- common --------------------------------- */

export interface ListParams {
  q?: string;
  status?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export const pagedOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), page: z.number(), page_size: z.number() });
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export const JOB_STATES = ['pending', 'running', 'succeeded', 'failed'] as const;
export const JobSchema = z.object({
  id: z.string(),
  kind: z.string().optional(),
  status: z.enum(JOB_STATES),
  created_at: ts.optional(),
  updated_at: ts.optional(),
  message: z.string().optional(),
  resource: z.object({ type: z.string(), id: z.string() }).optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
  /** Backend-reported steps. The UI never invents a percentage. */
  steps: z
    .array(
      z.object({ name: z.string(), status: z.enum(['pending', 'running', 'succeeded', 'failed']) }),
    )
    .optional(),
  simulated: z.boolean().optional(),
});
export type Job = z.infer<typeof JobSchema>;
export const isTerminal = (job: Job) => job.status === 'succeeded' || job.status === 'failed';

/** Result of a mutating call: completed synchronously (200/201) or accepted (202). */
export type Operation<T = unknown> =
  | { kind: 'done'; result: T; simulated?: boolean }
  | { kind: 'accepted'; job: Job; simulated?: boolean };

/* -------------------------------- sandboxes ------------------------------- */

export const SANDBOX_STATUSES = [
  'requested',
  'provisioning',
  'active',
  'failed',
  'terminating',
  'terminated',
  'expired',
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

export const SandboxSchema = z
  .object({
    id: z.string().or(z.number().transform(String)).optional(),
    sandbox_id: z.string().optional(),
    name: z.string().optional().default(''),
    team: z.string().optional().default(''),
    status: z
      .string()
      .transform((s) => s.toLowerCase() as SandboxStatus)
      .pipe(z.enum(SANDBOX_STATUSES))
      .or(z.enum(SANDBOX_STATUSES))
      .optional(),
    state: z.string().optional(),
    status_reason: z.string().optional(),
    private_ip: z.string().nullable().optional(),
    hostname: z.string().nullable().optional(),
    lease_id: z.string().nullable().optional(),
    route_id: z.string().nullable().optional(),
    custom_domain: z.string().nullable().optional(),
    created_at: ts.optional().default(() => new Date().toISOString()),
    expires_at: ts.nullable().optional(),
    history: z
      .array(z.object({ at: ts, status: z.string(), message: z.string().optional() }))
      .optional(),
  })
  .refine((s) => Boolean(s.id || s.sandbox_id), {
    message: 'Either id or sandbox_id is required',
    path: ['id'],
  })
  .refine((s) => Boolean(s.status || s.state), {
    message: 'Either status or state is required',
    path: ['status'],
  })
  .transform((s) => {
    const rawId = s.id || s.sandbox_id || '';
    let rawStatus = s.status;
    if (!rawStatus && s.state) {
      const lower = s.state.toLowerCase();
      if (lower === 'released' || lower === 'terminated') rawStatus = 'terminated';
      else if (lower === 'tearing_down' || lower === 'terminating') rawStatus = 'terminating';
      else if (lower === 'active') rawStatus = 'active';
      else rawStatus = 'terminated';
    }
    return {
      ...s,
      id: rawId,
      name: s.name || rawId,
      team: s.team || s.name || rawId,
      status: (rawStatus ?? 'active') as SandboxStatus,
    };
  });
export type Sandbox = z.infer<typeof SandboxSchema>;

export interface ProvisionRequest {
  name: string;
  team: string;
  ttl_hours: number;
}

export const CustomDomainResponseSchema = z.object({
  success: z.boolean(),
  custom_domain: z.string().optional(),
  sandbox_id: z.string().optional(),
});
export type CustomDomainResponse = z.infer<typeof CustomDomainResponseSchema>;

/* ----------------------------------- IPAM --------------------------------- */

export const LEASE_STATES = ['free', 'allocated', 'quarantined'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export const PoolStatsSchema = z.object({
  cidr: z.string().optional(),
  total: z.number(),
  allocated: z.number(),
  quarantined: z.number(),
  free: z.number(),
  quarantine_seconds: z.number().optional(),
  as_of: ts.optional(),
});
export type PoolStats = z.infer<typeof PoolStatsSchema>;

export const LeaseSchema = z.object({
  id: z.string(),
  ip: z.string(),
  state: z.enum(LEASE_STATES),
  sandbox_id: z.string().nullable().optional(),
  sandbox_name: z.string().nullable().optional(),
  allocated_at: ts.nullable().optional(),
  /** Lease expiry while allocated, or cooldown end while quarantined. */
  until: ts.nullable().optional(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const PoolCellSchema = z.object({
  ip: z.string(),
  host: z.number(),
  state: z.enum(['allocated', 'quarantined', 'free']),
  entity: z.string().optional(),
  id: z.string().optional(),
  allocated_at: ts.optional(),
  until: ts.optional(),
});
export type PoolCell = z.infer<typeof PoolCellSchema>;

export const PoolMapSchema = z.object({
  cidr: z.string(),
  total: z.number(),
  allocated: z.number(),
  quarantined: z.number(),
  free: z.number(),
  cells: z.array(PoolCellSchema),
  as_of: ts.optional(),
});
export type PoolMap = z.infer<typeof PoolMapSchema>;

export const ObservabilityMetricsSchema = z.object({
  summary: z.object({
    requests_total: z.number(),
    requests_per_sec: z.number(),
    http_2xx: z.number(),
    http_4xx: z.number(),
    http_5xx: z.number(),
    error_rate_pct: z.number(),
    latency_p50_ms: z.number(),
    latency_p95_ms: z.number(),
    latency_p99_ms: z.number(),
    active_connections: z.number(),
    total_connections: z.number(),
    bytes_out: z.number(),
    vip_holder: z.string(),
    vrrp_interval_sec: z.number(),
    keepalived_role: z.string(),
    active_backends: z.number(),
    total_backends: z.number(),
    idle_cpu_pct: z.number(),
    uptime_seconds: z.number(),
  }),
  time_series: z.array(
    z.object({
      timestamp: z.string(),
      requests_per_sec: z.number(),
      latency_p50_ms: z.number(),
      latency_p95_ms: z.number(),
      latency_p99_ms: z.number(),
      http_2xx: z.number(),
      http_4xx: z.number(),
      http_5xx: z.number(),
    }),
  ),
  backends: z.array(
    z.object({
      name: z.string(),
      target: z.string(),
      status: z.string(),
      check_status: z.string().optional(),
      latency_ms: z.number().optional(),
      requests: z.number().optional(),
    }),
  ),
  prometheus_text: z.string(),
  retrieved_at: z.string(),
});
export type ObservabilityMetrics = z.infer<typeof ObservabilityMetricsSchema>;

/* -------------------------------- gateways -------------------------------- */

const ServiceStatusSchema = z.object({
  status: z.enum(['up', 'down', 'unknown']),
  checked_at: ts.nullable().optional(),
  detail: z.string().optional(),
});
export const GatewaySchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().optional(),
  role: z.enum(['master', 'backup', 'fault', 'unknown']),
  owns_vip: z.boolean(),
  haproxy: ServiceStatusSchema,
  keepalived: ServiceStatusSchema,
  last_check_at: ts.nullable().optional(),
  config_generation: z.number().nullable().optional(),
});
export type Gateway = z.infer<typeof GatewaySchema>;

export const GatewaysSchema = z.object({
  vip: z.object({ address: z.string(), owner_gateway_id: z.string().nullable() }),
  gateways: z.array(GatewaySchema),
});
export type GatewaysView = z.infer<typeof GatewaysSchema>;

export interface FailoverRequest {
  target_gateway_id: string;
  mode?: string;
  confirm?: boolean;
}

export const DrillPlanSchema = z.object({
  dry_run: z.literal(true),
  steps: z.array(z.string()),
});
export type DrillPlan = z.infer<typeof DrillPlanSchema>;

/* ---------------------------------- routes -------------------------------- */

export const ROUTE_STAGES = ['configured', 'validated', 'deployed', 'reachable'] as const;
export const RouteSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  backend: z.string(),
  sandbox_id: z.string().nullable().optional(),
  sandbox_name: z.string().nullable().optional(),
  health: z.enum(['healthy', 'unhealthy', 'unknown']),
  stage: z.enum(ROUTE_STAGES),
  config_generation: z.number().nullable().optional(),
  last_check_at: ts.nullable().optional(),
  /** Only present when measured by a backend probe. */
  latency_ms: z.number().nullable().optional(),
  tls: z
    .object({ status: z.enum(['valid', 'expiring', 'invalid']), expires_at: ts.optional() })
    .nullable()
    .optional(),
  evidence: z.string().nullable().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

/* ----------------------------- configuration ------------------------------ */

export const ConfigGenerationSchema = z.object({
  id: z.string(),
  generation: z.number(),
  created_at: ts,
  checksum: z.string(),
  source: z.string().optional(),
  validation: z.object({
    status: z.enum(['passed', 'failed', 'not_run']),
    message: z.string().optional(),
    at: ts.nullable().optional(),
  }),
  deployment: z.object({
    status: z.enum(['not_deployed', 'pending', 'deployed', 'partial', 'failed']),
  }),
  gateways: z
    .array(
      z.object({
        gateway_id: z.string(),
        generation: z.number().nullable(),
        status: z.enum(['applied', 'pending', 'failed', 'unknown']),
      }),
    )
    .optional(),
  /** Unified diff against the previous generation, when the backend supplies one. */
  diff: z.string().nullable().optional(),
  last_known_good: z.boolean().nullable().optional(),
});
export type ConfigGeneration = z.infer<typeof ConfigGenerationSchema>;

/* ------------------------------ observability ----------------------------- */

export const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export const EventSchema = z.object({
  id: z.string(),
  at: ts,
  severity: z.enum(SEVERITIES),
  resource: z.object({
    type: z.enum(['sandbox', 'gateway', 'configuration', 'lease', 'route', 'system']),
    id: z.string(),
    name: z.string().optional(),
  }),
  message: z.string(),
  operation_id: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
});
export type PlatformEvent = z.infer<typeof EventSchema>;

export const OperationRecordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(JOB_STATES),
  resource: z.object({ type: z.string(), id: z.string() }).optional(),
  started_at: ts,
  finished_at: ts.nullable().optional(),
  requested_by: z.string().optional(),
  message: z.string().optional(),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const HaproxyLogSchema = z.object({
  at: ts,
  gateway_id: z.string(),
  client_ip: z.string().default('203.0.113.10'),
  method: z.string().default('GET'),
  host: z.string().default('sandbox.example.com'),
  path: z.string().default('/'),
  status: z.number().default(200),
  backend: z.string().default('default_maintenance'),
  duration_ms: z.number().default(1),
  message: z.string().optional(),
});
export type HaproxyLogEntry = z.infer<typeof HaproxyLogSchema>;

export const SystemLogSchema = z.object({
  at: ts,
  gateway_id: z.string(),
  unit: z.string().default('keepalived.service'),
  level: z
    .string()
    .transform((l) => (l === 'error' || l === 'err' || l === 'crit' ? 'error' : l === 'warning' || l === 'warn' || l === 'notice' ? 'warning' : 'info'))
    .pipe(z.enum(['info', 'warning', 'error'])),
  message: z.string(),
});
export type SystemLogEntry = z.infer<typeof SystemLogSchema>;

export interface LogParams {
  gatewayId?: string;
  since?: string;
  page?: number;
  pageSize?: number;
}
export const logsOf = <T extends z.ZodType>(entry: T) =>
  z.object({
    items: z.array(entry),
    total: z.number(),
    page: z.number(),
    page_size: z.number(),
    retrieved_at: ts,
  });
export interface LogPage<T> extends Paged<T> {
  retrieved_at: string;
}

/* ------------------------------- benchmarks ------------------------------- */

export const BenchmarkSuiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  disruptive: z.boolean(),
  parameters: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      default: z.number(),
      min: z.number(),
      max: z.number(),
      unit: z.string().optional(),
    }),
  ),
});
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;

export const BENCHMARK_ORIGINS = ['live', 'historical', 'imported', 'demo'] as const;
export type BenchmarkOrigin = (typeof BENCHMARK_ORIGINS)[number];
export const BenchmarkRunSchema = z.object({
  id: z.string(),
  suite_id: z.string(),
  status: z.enum(JOB_STATES),
  origin: z.enum(BENCHMARK_ORIGINS),
  started_at: ts,
  finished_at: ts.nullable().optional(),
  parameters: z.record(z.string(), z.number()),
  environment: z.string().optional(),
  metrics: z
    .object({
      attempted: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      p50_ms: z.number().nullable().optional(),
      p95_ms: z.number().nullable().optional(),
      p99_ms: z.number().nullable().optional(),
      failover_seconds: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  output: z.string().nullable().optional(),
  evidence_url: z.string().nullable().optional(),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export interface BenchmarkRunRequest {
  suite_id: string;
  parameters: Record<string, number>;
  acknowledge_disruption?: boolean;
}

/* ------------------------------ the Api surface --------------------------- */

export interface Api {
  /** 'live' talks to the backend; 'demo' is the local simulator. */
  readonly mode: 'live' | 'demo';
  health(signal?: AbortSignal): Promise<Health>;
  sandboxes: {
    list(params: ListParams, signal?: AbortSignal): Promise<Paged<Sandbox>>;
    get(id: string, signal?: AbortSignal): Promise<Sandbox>;
    provision(req: ProvisionRequest, idempotencyKey: string): Promise<Operation<Sandbox>>;
    teardown(id: string, idempotencyKey: string): Promise<Operation<Sandbox>>;
    customDomain?(req: { sandbox_id: string; custom_domain: string }): Promise<CustomDomainResponse>;
  };
  jobs: { get(id: string, signal?: AbortSignal): Promise<Job> };
  ipam: {
    stats(signal?: AbortSignal): Promise<PoolStats>;
    map(signal?: AbortSignal): Promise<PoolMap>;
    leases(params: ListParams, signal?: AbortSignal): Promise<Paged<Lease>>;
    reconcile(idempotencyKey: string): Promise<Operation<{ message: string }>>;
  };
  gateways: {
    get(signal?: AbortSignal): Promise<GatewaysView>;
    failover(req: FailoverRequest, idempotencyKey: string): Promise<Operation<{ message: string }>>;
    drill(signal?: AbortSignal): Promise<DrillPlan>;
  };
  routes: { list(params: ListParams, signal?: AbortSignal): Promise<Paged<Route>> };
  configurations: {
    list(signal?: AbortSignal): Promise<ConfigGeneration[]>;
    validate(id: string, idempotencyKey: string): Promise<Operation<ConfigGeneration>>;
    deploy(id: string, idempotencyKey: string): Promise<Operation<ConfigGeneration>>;
    rollback(id: string, idempotencyKey: string): Promise<Operation<ConfigGeneration>>;
  };
  events: {
    list(
      params: ListParams & { severity?: string },
      signal?: AbortSignal,
    ): Promise<Paged<PlatformEvent>>;
  };
  operations: { list(params: ListParams, signal?: AbortSignal): Promise<Paged<OperationRecord>> };
  logs: {
    haproxy(params: LogParams, signal?: AbortSignal): Promise<LogPage<HaproxyLogEntry>>;
    system(params: LogParams, signal?: AbortSignal): Promise<LogPage<SystemLogEntry>>;
  };
  observability: {
    metrics(signal?: AbortSignal): Promise<ObservabilityMetrics>;
  };
  benchmarks: {
    suites(signal?: AbortSignal): Promise<BenchmarkSuite[]>;
    runs(signal?: AbortSignal): Promise<BenchmarkRun[]>;
    run(req: BenchmarkRunRequest, idempotencyKey: string): Promise<Operation<BenchmarkRun>>;
  };
}
