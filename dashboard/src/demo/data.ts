/**
 * Deterministic demo fixtures. Used ONLY when VITE_DEMO_MODE=true.
 * Nothing here describes real infrastructure.
 */
import type {
  BenchmarkRun,
  BenchmarkSuite,
  ConfigGeneration,
  Gateway,
  HaproxyLogEntry,
  Lease,
  OperationRecord,
  PlatformEvent,
  Route,
  Sandbox,
  SystemLogEntry,
} from '../api/contracts';

export const DEMO_NOW = Date.parse('2026-03-12T09:30:00Z');
export const ago = (minutes: number): string => new Date(DEMO_NOW - minutes * 60_000).toISOString();
export const ahead = (minutes: number): string => ago(-minutes);

export const VIP = '10.20.0.100';
export const POOL_CIDR = '10.20.0.0/26';
export const QUARANTINE_SECONDS = 900;

export function demoSandboxes(): Sandbox[] {
  const base = (
    s: Partial<Sandbox> & Pick<Sandbox, 'id' | 'name' | 'team' | 'status' | 'created_at'>,
  ): Sandbox => s;
  return [
    base({
      id: 'sbx-001',
      name: 'alpha-api',
      team: 'team-alpha',
      status: 'active',
      private_ip: '10.20.0.11',
      hostname: 'alpha-api.sandbox.felcloud.test',
      lease_id: 'lease-11',
      route_id: 'rte-001',
      created_at: ago(3 * 24 * 60),
      expires_at: ahead(2 * 24 * 60),
      history: [
        { at: ago(3 * 24 * 60), status: 'requested' },
        { at: ago(3 * 24 * 60 - 4), status: 'provisioning' },
        { at: ago(3 * 24 * 60 - 9), status: 'active', message: 'Instance reported ACTIVE' },
      ],
    }),
    base({
      id: 'sbx-002',
      name: 'bravo-web',
      team: 'team-bravo',
      status: 'active',
      private_ip: '10.20.0.12',
      hostname: 'bravo-web.sandbox.felcloud.test',
      lease_id: 'lease-12',
      route_id: 'rte-002',
      created_at: ago(2 * 24 * 60),
      expires_at: ahead(24 * 60),
    }),
    base({
      id: 'sbx-003',
      name: 'charlie-ml',
      team: 'team-charlie',
      status: 'active',
      private_ip: '10.20.0.13',
      hostname: 'charlie-ml.sandbox.felcloud.test',
      lease_id: 'lease-13',
      route_id: 'rte-003',
      created_at: ago(26 * 60),
      expires_at: ahead(46 * 60),
    }),
    base({
      id: 'sbx-004',
      name: 'delta-docs',
      team: 'team-delta',
      status: 'provisioning',
      private_ip: '10.20.0.15',
      hostname: null,
      lease_id: 'lease-15',
      route_id: 'rte-005',
      created_at: ago(6),
      expires_at: ahead(24 * 60),
    }),
    base({
      id: 'sbx-005',
      name: 'echo-etl',
      team: 'team-echo',
      status: 'failed',
      status_reason:
        'Compute instance did not reach ACTIVE within the allowed time. The address lease was released into quarantine.',
      private_ip: null,
      created_at: ago(5 * 60),
      expires_at: null,
    }),
    base({
      id: 'sbx-006',
      name: 'alpha-staging',
      team: 'team-alpha',
      status: 'active',
      private_ip: '10.20.0.14',
      hostname: 'alpha-staging.sandbox.felcloud.test',
      lease_id: 'lease-14',
      route_id: 'rte-004',
      created_at: ago(9 * 60),
      expires_at: ahead(15 * 60),
    }),
    base({
      id: 'sbx-007',
      name: 'foxtrot-ci',
      team: 'team-foxtrot',
      status: 'expired',
      private_ip: null,
      created_at: ago(4 * 24 * 60),
      expires_at: ago(8),
    }),
    base({
      id: 'sbx-008',
      name: 'bravo-batch',
      team: 'team-bravo',
      status: 'terminated',
      private_ip: null,
      created_at: ago(2 * 24 * 60),
      expires_at: null,
    }),
  ];
}

export function demoLeases(): Lease[] {
  const owners: Record<number, { sandbox_id: string; sandbox_name: string }> = {
    11: { sandbox_id: 'sbx-001', sandbox_name: 'alpha-api' },
    12: { sandbox_id: 'sbx-002', sandbox_name: 'bravo-web' },
    13: { sandbox_id: 'sbx-003', sandbox_name: 'charlie-ml' },
    14: { sandbox_id: 'sbx-006', sandbox_name: 'alpha-staging' },
    15: { sandbox_id: 'sbx-004', sandbox_name: 'delta-docs' },
  };
  const quarantined: Record<number, { sandbox_id: string; sandbox_name: string; mins: number }> = {
    16: { sandbox_id: 'sbx-007', sandbox_name: 'foxtrot-ci', mins: 7 },
    17: { sandbox_id: 'sbx-008', sandbox_name: 'bravo-batch', mins: 11 },
    18: { sandbox_id: 'sbx-005', sandbox_name: 'echo-etl', mins: 4 },
  };
  const leases: Lease[] = [];
  for (let host = 10; host <= 39; host += 1) {
    const ip = `10.20.0.${host}`;
    const own = owners[host];
    const quar = quarantined[host];
    if (own)
      leases.push({
        id: `lease-${host}`,
        ip,
        state: 'allocated',
        ...own,
        allocated_at: ago(host * 100),
        until: ahead(host * 50),
      });
    else if (quar)
      leases.push({
        id: `lease-${host}`,
        ip,
        state: 'quarantined',
        sandbox_id: quar.sandbox_id,
        sandbox_name: quar.sandbox_name,
        allocated_at: ago(2000),
        until: ahead(quar.mins),
      });
    else
      leases.push({
        id: `lease-${host}`,
        ip,
        state: 'free',
        sandbox_id: null,
        sandbox_name: null,
        allocated_at: null,
        until: null,
      });
  }
  return leases;
}

export function demoGateways(): Gateway[] {
  return [
    {
      id: 'gw-1',
      name: 'gateway-1',
      address: '10.20.0.2',
      role: 'master',
      owns_vip: true,
      haproxy: { status: 'up', checked_at: ago(1) },
      keepalived: { status: 'up', checked_at: ago(1) },
      last_check_at: ago(1),
      config_generation: 42,
    },
    {
      id: 'gw-2',
      name: 'gateway-2',
      address: '10.20.0.3',
      role: 'backup',
      owns_vip: false,
      haproxy: { status: 'up', checked_at: ago(1) },
      keepalived: { status: 'up', checked_at: ago(1) },
      last_check_at: ago(1),
      config_generation: 41,
    },
  ];
}

export function demoRoutes(): Route[] {
  return [
    {
      id: 'rte-001',
      hostname: 'alpha-api.sandbox.felcloud.test',
      backend: '10.20.0.11:8080',
      sandbox_id: 'sbx-001',
      sandbox_name: 'alpha-api',
      health: 'healthy',
      stage: 'reachable',
      config_generation: 42,
      last_check_at: ago(1),
      latency_ms: 12.4,
      tls: { status: 'valid', expires_at: ahead(60 * 24 * 40) },
      evidence: 'HTTP 200 from GET /healthz via both gateways',
    },
    {
      id: 'rte-002',
      hostname: 'bravo-web.sandbox.felcloud.test',
      backend: '10.20.0.12:8080',
      sandbox_id: 'sbx-002',
      sandbox_name: 'bravo-web',
      health: 'healthy',
      stage: 'reachable',
      config_generation: 42,
      last_check_at: ago(1),
      latency_ms: 18.9,
      tls: null,
      evidence: 'HTTP 200 from GET /healthz via gateway-1; gateway-2 still on generation 41',
    },
    {
      id: 'rte-003',
      hostname: 'charlie-ml.sandbox.felcloud.test',
      backend: '10.20.0.13:8080',
      sandbox_id: 'sbx-003',
      sandbox_name: 'charlie-ml',
      health: 'unhealthy',
      stage: 'deployed',
      config_generation: 42,
      last_check_at: ago(2),
      latency_ms: null,
      tls: null,
      evidence: 'Health check timed out 3 consecutive times',
    },
    {
      id: 'rte-004',
      hostname: 'alpha-staging.sandbox.felcloud.test',
      backend: '10.20.0.14:8080',
      sandbox_id: 'sbx-006',
      sandbox_name: 'alpha-staging',
      health: 'unknown',
      stage: 'validated',
      config_generation: null,
      last_check_at: null,
      latency_ms: null,
      tls: null,
      evidence: null,
    },
    {
      id: 'rte-005',
      hostname: 'docs.acme-corp.com',
      backend: '10.20.0.15:8080',
      sandbox_id: 'sbx-004',
      sandbox_name: 'delta-docs',
      health: 'healthy',
      stage: 'reachable',
      config_generation: 42,
      last_check_at: ago(1),
      latency_ms: 14.2,
      tls: { status: 'valid', expires_at: ahead(60 * 24 * 90) },
      evidence: 'Custom SNI domain bound to delta-docs MicroVM backend',
    },
  ];
}

const DIFF_42 = `--- generation 41
+++ generation 42
@@ backend be_sandboxes @@
   server alpha-api 10.20.0.11:8080 check
   server bravo-web 10.20.0.12:8080 check
+  server charlie-ml 10.20.0.13:8080 check inter 5s fall 3
+  server alpha-staging 10.20.0.14:8080 check`;
const DIFF_43 = `--- generation 42
+++ generation 43
@@ backend be_sandboxes @@
+  server delta-docs 10.20.0.15:8080 check
-  server charlie-ml 10.20.0.13:8080 check inter 5s fall 3
+  server charlie-ml 10.20.0.13:8080 check inter 2s fall 2`;

export function demoConfigs(): ConfigGeneration[] {
  return [
    {
      id: 'cfg-43',
      generation: 43,
      created_at: ago(12),
      checksum: 'sha256:9c1f0a7be42d',
      source: 'control-plane / route sync',
      validation: { status: 'not_run' },
      deployment: { status: 'not_deployed' },
      gateways: [
        { gateway_id: 'gw-1', generation: 42, status: 'unknown' },
        { gateway_id: 'gw-2', generation: 41, status: 'unknown' },
      ],
      diff: DIFF_43,
      last_known_good: false,
    },
    {
      id: 'cfg-42',
      generation: 42,
      created_at: ago(95),
      checksum: 'sha256:51ab33d0c7e9',
      source: 'control-plane / route sync',
      validation: {
        status: 'passed',
        message: 'haproxy -c: configuration file is valid',
        at: ago(94),
      },
      deployment: { status: 'partial' },
      gateways: [
        { gateway_id: 'gw-1', generation: 42, status: 'applied' },
        { gateway_id: 'gw-2', generation: 41, status: 'pending' },
      ],
      diff: DIFF_42,
      last_known_good: false,
    },
    {
      id: 'cfg-41',
      generation: 41,
      created_at: ago(26 * 60),
      checksum: 'sha256:e07d9b214aa8',
      source: 'control-plane / route sync',
      validation: { status: 'passed', at: ago(26 * 60 - 1) },
      deployment: { status: 'deployed' },
      gateways: [
        { gateway_id: 'gw-1', generation: 41, status: 'applied' },
        { gateway_id: 'gw-2', generation: 41, status: 'applied' },
      ],
      diff: null,
      last_known_good: true,
    },
    {
      id: 'cfg-40',
      generation: 40,
      created_at: ago(2 * 24 * 60),
      checksum: 'sha256:7a44c1be09f3',
      source: 'control-plane / route sync',
      validation: { status: 'passed', at: ago(2 * 24 * 60 - 1) },
      deployment: { status: 'deployed' },
      gateways: [
        { gateway_id: 'gw-1', generation: 40, status: 'applied' },
        { gateway_id: 'gw-2', generation: 40, status: 'applied' },
      ],
      diff: null,
      last_known_good: false,
    },
    {
      id: 'cfg-39',
      generation: 39,
      created_at: ago(3 * 24 * 60),
      checksum: 'sha256:2f90e5d8b611',
      source: 'manual import',
      validation: { status: 'failed', message: "unknown keyword 'bakend' in backend section" },
      deployment: { status: 'not_deployed' },
      gateways: [],
      diff: null,
      last_known_good: false,
    },
  ];
}

const EVENT_TEMPLATES: Array<Omit<PlatformEvent, 'id' | 'at'>> = [
  {
    severity: 'info',
    resource: { type: 'sandbox', id: 'sbx-001', name: 'alpha-api' },
    message: 'Sandbox reached ACTIVE and route published.',
    operation_id: 'op-1001',
  },
  {
    severity: 'warning',
    resource: { type: 'route', id: 'rte-003', name: 'charlie-ml' },
    message: 'Backend health check timed out (3 consecutive failures).',
    trace_id: 'trc-77a1',
  },
  {
    severity: 'info',
    resource: { type: 'configuration', id: 'cfg-42' },
    message: 'Configuration generation 42 applied on gateway-1.',
    operation_id: 'op-1007',
  },
  {
    severity: 'warning',
    resource: { type: 'configuration', id: 'cfg-42' },
    message: 'Generation 42 not yet applied on gateway-2 (still on 41).',
    operation_id: 'op-1007',
  },
  {
    severity: 'error',
    resource: { type: 'sandbox', id: 'sbx-005', name: 'echo-etl' },
    message: 'Provisioning failed: instance did not reach ACTIVE in time.',
    operation_id: 'op-1004',
    trace_id: 'trc-5b02',
  },
  {
    severity: 'info',
    resource: { type: 'lease', id: 'lease-18' },
    message: 'Lease 10.20.0.18 moved to QUARANTINED after failed provisioning.',
    operation_id: 'op-1004',
  },
  {
    severity: 'info',
    resource: { type: 'sandbox', id: 'sbx-007', name: 'foxtrot-ci' },
    message: 'Sandbox expired; teardown completed.',
    operation_id: 'op-1006',
  },
  {
    severity: 'info',
    resource: { type: 'gateway', id: 'gw-1', name: 'gateway-1' },
    message: 'Gateway reports MASTER and owns the virtual IP.',
  },
  {
    severity: 'critical',
    resource: { type: 'gateway', id: 'gw-2', name: 'gateway-2' },
    message: 'Keepalived heartbeat missed twice; recovered.',
    trace_id: 'trc-9e44',
  },
  {
    severity: 'info',
    resource: { type: 'system', id: 'control-plane' },
    message: 'Lease reconciliation completed with no drift.',
    operation_id: 'op-1002',
  },
];

export function demoEvents(): PlatformEvent[] {
  const events: PlatformEvent[] = [];
  for (let i = 0; i < 30; i += 1) {
    const tpl = EVENT_TEMPLATES[i % EVENT_TEMPLATES.length]!;
    events.push({ ...tpl, id: `evt-${String(3000 - i)}`, at: ago(3 + i * 37) });
  }
  return events;
}

export function demoOperations(): OperationRecord[] {
  return [
    {
      id: 'op-1007',
      kind: 'configuration.deploy',
      status: 'succeeded',
      resource: { type: 'configuration', id: 'cfg-42' },
      started_at: ago(94),
      finished_at: ago(92),
      requested_by: 'operator',
      message: 'Applied on gateway-1; gateway-2 pending',
    },
    {
      id: 'op-1006',
      kind: 'sandbox.teardown',
      status: 'succeeded',
      resource: { type: 'sandbox', id: 'sbx-007' },
      started_at: ago(8),
      finished_at: ago(7),
      requested_by: 'lease-expiry',
    },
    {
      id: 'op-1004',
      kind: 'sandbox.provision',
      status: 'failed',
      resource: { type: 'sandbox', id: 'sbx-005' },
      started_at: ago(300),
      finished_at: ago(285),
      requested_by: 'operator',
      message: 'Instance did not reach ACTIVE',
    },
    {
      id: 'op-1002',
      kind: 'ipam.reconcile',
      status: 'succeeded',
      started_at: ago(180),
      finished_at: ago(179),
      requested_by: 'scheduler',
    },
    {
      id: 'op-1001',
      kind: 'sandbox.provision',
      status: 'succeeded',
      resource: { type: 'sandbox', id: 'sbx-001' },
      started_at: ago(4320),
      finished_at: ago(4311),
      requested_by: 'operator',
    },
  ];
}

/** Deterministic pseudo-sequence so demo logs are identical on every load. */
const seq = (i: number, mod: number) => (i * 7919 + 104_729) % mod;

export function demoHaproxyLogs(): HaproxyLogEntry[] {
  const hosts = demoRoutes();
  const statuses = [200, 200, 200, 200, 304, 200, 404, 200, 503, 200];
  const paths = ['/', '/healthz', '/api/v1/items', '/static/app.js', '/login'];
  return Array.from({ length: 60 }, (_, i) => {
    const route = hosts[seq(i, hosts.length)]!;
    return {
      at: ago(i * 3 + 1),
      gateway_id: i % 5 === 4 ? 'gw-2' : 'gw-1',
      client_ip: `10.30.${seq(i, 4)}.${10 + seq(i, 200)}`,
      method: i % 6 === 5 ? 'POST' : 'GET',
      host: route.hostname,
      path: paths[seq(i, paths.length)]!,
      status: statuses[seq(i, statuses.length)]!,
      backend: route.backend,
      duration_ms: 5 + seq(i, 90),
    };
  });
}

export function demoSystemLogs(): SystemLogEntry[] {
  const lines: Array<Pick<SystemLogEntry, 'unit' | 'level' | 'message'>> = [
    { unit: 'keepalived', level: 'info', message: 'VRRP_Instance(VI_1) Entering MASTER STATE' },
    { unit: 'haproxy', level: 'info', message: 'Proxy be_sandboxes started.' },
    {
      unit: 'keepalived',
      level: 'warning',
      message: 'VRRP_Instance(VI_1) advertisement timer missed',
    },
    {
      unit: 'haproxy',
      level: 'warning',
      message: 'Server be_sandboxes/charlie-ml is DOWN, reason: Layer4 timeout',
    },
    { unit: 'keepalived', level: 'info', message: 'VRRP_Script(chk_haproxy) succeeded' },
  ];
  return Array.from({ length: 30 }, (_, i) => ({
    at: ago(i * 5 + 2),
    gateway_id: i % 3 === 2 ? 'gw-2' : 'gw-1',
    ...lines[seq(i, lines.length)]!,
  }));
}

export function demoSuites(): BenchmarkSuite[] {
  return [
    {
      id: 'ip-allocation',
      name: 'IP allocation throughput',
      description:
        'Allocates and releases leases concurrently to measure allocation latency and detect duplicate addresses.',
      disruptive: false,
      parameters: [
        { key: 'concurrency', label: 'Concurrent allocations', default: 8, min: 1, max: 32 },
        { key: 'iterations', label: 'Iterations', default: 200, min: 10, max: 1000 },
      ],
    },
    {
      id: 'route-latency',
      name: 'Route latency probe',
      description: 'Sends probe requests through the virtual IP to every deployed route.',
      disruptive: false,
      parameters: [
        { key: 'requests', label: 'Requests per route', default: 100, min: 10, max: 500 },
      ],
    },
    {
      id: 'failover-timing',
      name: 'Failover timing',
      description:
        'Requests a gateway failover and measures how long the virtual IP is unreachable. Disrupts traffic.',
      disruptive: true,
      parameters: [
        {
          key: 'probe_interval_ms',
          label: 'Probe interval',
          default: 100,
          min: 50,
          max: 1000,
          unit: 'ms',
        },
      ],
    },
  ];
}

export function demoRuns(): BenchmarkRun[] {
  return [
    {
      id: 'run-003',
      suite_id: 'failover-timing',
      status: 'succeeded',
      origin: 'demo',
      started_at: ago(2 * 24 * 60),
      finished_at: ago(2 * 24 * 60 - 3),
      parameters: { probe_interval_ms: 100 },
      environment: 'demo fixture',
      metrics: { attempted: 1, succeeded: 1, failed: 0, failover_seconds: 0.8 },
      output:
        'Demo fixture — calibrated with T3 VRRP failover benchmark (0.8s failover, 0 lost packets).',
    },
    {
      id: 'run-002',
      suite_id: 'ip-allocation',
      status: 'succeeded',
      origin: 'demo',
      started_at: ago(3 * 24 * 60),
      finished_at: ago(3 * 24 * 60 - 2),
      parameters: { concurrency: 8, iterations: 200 },
      environment: 'demo fixture',
      metrics: { attempted: 200, succeeded: 200, failed: 0, p50_ms: 14, p95_ms: 41, p99_ms: 63 },
      output: 'Demo fixture — not a real measurement.',
    },
    {
      id: 'run-001',
      suite_id: 'ip-allocation',
      status: 'succeeded',
      origin: 'demo',
      started_at: ago(4 * 24 * 60),
      finished_at: ago(4 * 24 * 60 - 2),
      parameters: { concurrency: 8, iterations: 200 },
      environment: 'demo fixture',
      metrics: { attempted: 200, succeeded: 198, failed: 2, p50_ms: 17, p95_ms: 52, p99_ms: 88 },
      output: 'Demo fixture — not a real measurement.',
    },
  ];
}
