/**
 * Local simulator that implements the same `Api` interface as the live client.
 * Every mutation returns a job flagged `simulated`; jobs advance one state per
 * poll (pending -> running -> done), so behaviour is deterministic. Nothing here
 * touches real infrastructure.
 */
import { ApiError } from '../api/errors';
import type {
  Api,
  BenchmarkRun,
  ConfigGeneration,
  Health,
  Job,
  ListParams,
  Operation,
  Paged,
  Sandbox,
} from '../api/contracts';
import {
  POOL_CIDR,
  QUARANTINE_SECONDS,
  VIP,
  DEMO_NOW,
  ago,
  ahead,
  demoConfigs,
  demoEvents,
  demoGateways,
  demoHaproxyLogs,
  demoLeases,
  demoOperations,
  demoRoutes,
  demoRuns,
  demoSandboxes,
  demoSuites,
  demoSystemLogs,
} from './data';

interface SimJob {
  job: Job;
  polls: number;
  willFail: boolean;
  finish: () => void;
  fail: () => void;
}

function paginate<T>(items: T[], p: { page?: number; pageSize?: number }): Paged<T> {
  const page = Math.max(1, p.page ?? 1);
  const size = Math.max(1, p.pageSize ?? 10);
  return {
    items: items.slice((page - 1) * size, page * size),
    total: items.length,
    page,
    page_size: size,
  };
}

function sortBy<T>(items: T[], sort: string | undefined): T[] {
  if (!sort) return items;
  const [field, dir] = sort.split(':');
  const factor = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const av = String((a as Record<string, unknown>)[field ?? ''] ?? '');
    const bv = String((b as Record<string, unknown>)[field ?? ''] ?? '');
    return av.localeCompare(bv, undefined, { numeric: true }) * factor;
  });
}

const matches = (q: string | undefined, ...fields: Array<string | null | undefined>) =>
  !q || fields.some((f) => (f ?? '').toLowerCase().includes(q.toLowerCase()));

export function createDemoApi(): Api {
  const sandboxes = demoSandboxes();
  const leases = demoLeases();
  const gateways = demoGateways();
  const routes = demoRoutes();
  let configs = demoConfigs();
  const events = demoEvents();
  const operations = demoOperations();
  const runs: BenchmarkRun[] = demoRuns();
  const jobs = new Map<string, SimJob>();
  let jobCounter = 2000;
  let vipOwner: string | null = 'gw-1';

  const steps = (names: string[], polls: number, failed: boolean): NonNullable<Job['steps']> =>
    names.map((name, i) => {
      if (polls >= 3)
        return { name, status: failed && i === names.length - 1 ? 'failed' : 'succeeded' };
      if (polls === 2)
        return { name, status: i === 0 ? 'succeeded' : i === 1 ? 'running' : 'pending' };
      return { name, status: 'pending' };
    });

  function startJob(
    kind: string,
    resource: Job['resource'],
    stepNames: string[],
    hooks: { finish: () => void; fail?: () => void; willFail?: boolean; failMessage?: string },
  ): Operation<never> {
    jobCounter += 1;
    const id = `job-${jobCounter}`;
    const job: Job = {
      id,
      kind,
      status: 'pending',
      resource,
      created_at: ago(0),
      simulated: true,
      steps: steps(stepNames, 1, false),
    };
    jobs.set(id, {
      job,
      polls: 0,
      willFail: hooks.willFail ?? false,
      finish: hooks.finish,
      fail: hooks.fail ?? (() => undefined),
    });
    (job as Job & { _failMessage?: string })._failMessage = hooks.failMessage;
    operations.unshift({
      id,
      kind,
      status: 'pending',
      resource,
      started_at: ago(0),
      requested_by: 'demo-operator',
      message: 'Simulated',
    });
    return { kind: 'accepted', job: { ...job }, simulated: true };
  }

  const stepNamesFor = {
    provision: ['Allocate IP lease', 'Create compute instance', 'Attach network', 'Publish route'],
    teardown: ['Remove route', 'Delete compute instance', 'Quarantine IP lease'],
    config: ['Check generation', 'Apply on gateways', 'Verify gateway state'],
    failover: ['Request VRRP priority change', 'Wait for virtual IP to move'],
    generic: ['Prepare', 'Run', 'Collect result'],
  };

  const getSandbox = (id: string): Sandbox => {
    const found = sandboxes.find((s) => s.id === id);
    if (!found)
      throw new ApiError({ kind: 'not_found', status: 404, message: 'Sandbox not found.' });
    return found;
  };
  const getConfig = (id: string): ConfigGeneration => {
    const found = configs.find((c) => c.id === id);
    if (!found)
      throw new ApiError({
        kind: 'not_found',
        status: 404,
        message: 'Configuration generation not found.',
      });
    return found;
  };
  const pushEvent = (
    severity: 'info' | 'error',
    resource: Job['resource'],
    message: string,
    op: string,
  ) =>
    events.unshift({
      id: `evt-sim-${events.length}`,
      at: ago(0),
      severity,
      resource: { type: (resource?.type as 'sandbox') ?? 'system', id: resource?.id ?? 'demo' },
      message: `[Simulated] ${message}`,
      operation_id: op,
    });

  const health: Health = {
    status: 'degraded',
    version: 'demo-simulator',
    checked_at: ago(0),
    components: [
      { name: 'control-plane', status: 'ok', detail: 'Simulated' },
      { name: 'openstack', status: 'ok', detail: 'Simulated' },
      {
        name: 'gateway-2 config sync',
        status: 'degraded',
        detail: 'Simulated: generation 41 vs 42',
      },
    ],
    capabilities: {
      sandbox_provision: true,
      sandbox_teardown: true,
      lease_reconcile: true,
      gateway_failover: true,
      failover_drill: false,
      config_validate: true,
      config_deploy: true,
      config_rollback: true,
      logs_haproxy: true,
      logs_system: true,
      benchmark_run: true,
    },
  };

  return {
    mode: 'demo',
    health: async () => ({ ...health, checked_at: new Date().toISOString() }),

    sandboxes: {
      list: async (p: ListParams) => {
        const filtered = sandboxes.filter(
          (s) =>
            (!p.status || s.status === p.status) &&
            matches(p.q, s.name, s.team, s.id, s.private_ip, s.hostname),
        );
        return paginate(sortBy(filtered, p.sort ?? 'created_at:desc'), p);
      },
      get: async (id) => ({ ...getSandbox(id) }),
      provision: async (req) => {
        const errors: Record<string, string> = {};
        if (sandboxes.some((s) => s.name === req.name && s.status !== 'terminated'))
          errors.name = 'A sandbox with this name already exists.';
        const free = leases.find((l) => l.state === 'free');
        if (!free)
          throw new ApiError({
            kind: 'conflict',
            status: 409,
            message: 'The IP pool has no free addresses.',
          });
        if (Object.keys(errors).length)
          throw new ApiError({
            kind: 'validation',
            status: 422,
            message: 'The request was rejected.',
            fieldErrors: errors,
          });
        const sbx: Sandbox = {
          id: `sbx-${String(sandboxes.length + 1).padStart(3, '0')}`,
          name: req.name,
          team: req.team,
          status: 'requested',
          private_ip: null,
          hostname: null,
          created_at: ago(0),
          expires_at: ahead(req.ttl_hours * 60),
          history: [{ at: ago(0), status: 'requested' }],
        };
        sandboxes.push(sbx);
        free.state = 'allocated';
        free.sandbox_id = sbx.id;
        free.sandbox_name = sbx.name;
        free.allocated_at = ago(0);
        free.until = sbx.expires_at ?? null;
        sbx.lease_id = free.id;
        sbx.private_ip = free.ip;
        const willFail = req.name.includes('fail');
        const op = startJob(
          'sandbox.provision',
          { type: 'sandbox', id: sbx.id },
          stepNamesFor.provision,
          {
            willFail,
            failMessage:
              'Compute instance did not reach ACTIVE (simulated failure: name contains "fail").',
            finish: () => {
              sbx.status = 'active';
              sbx.hostname = `${sbx.name}.sandbox.felcloud.test`;
              sbx.history?.push({ at: ago(0), status: 'active', message: 'Simulated' });
              pushEvent(
                'info',
                { type: 'sandbox', id: sbx.id },
                `Sandbox ${sbx.name} reached ACTIVE.`,
                'sim',
              );
            },
            fail: () => {
              sbx.status = 'failed';
              sbx.status_reason = 'Simulated provisioning failure.';
              sbx.private_ip = null;
              free.state = 'quarantined';
              free.until = ahead(QUARANTINE_SECONDS / 60);
              pushEvent(
                'error',
                { type: 'sandbox', id: sbx.id },
                `Provisioning of ${sbx.name} failed.`,
                'sim',
              );
            },
          },
        );
        sbx.status = 'provisioning';
        return op as Operation<Sandbox>;
      },
      teardown: async (id) => {
        const sbx = getSandbox(id);
        if (sbx.status === 'terminated' || sbx.status === 'terminating') {
          throw new ApiError({
            kind: 'conflict',
            status: 409,
            message: `Sandbox is already ${sbx.status}.`,
          });
        }
        sbx.status = 'terminating';
        return startJob('sandbox.teardown', { type: 'sandbox', id }, stepNamesFor.teardown, {
          finish: () => {
            sbx.status = 'terminated';
            const lease = leases.find((l) => l.id === sbx.lease_id);
            if (lease) {
              lease.state = 'quarantined';
              lease.until = ahead(QUARANTINE_SECONDS / 60);
            }
            sbx.private_ip = null;
            pushEvent('info', { type: 'sandbox', id }, `Sandbox ${sbx.name} torn down.`, 'sim');
          },
        }) as Operation<Sandbox>;
      },
    },

    jobs: {
      get: async (id) => {
        const sim = jobs.get(id);
        if (!sim) throw new ApiError({ kind: 'not_found', status: 404, message: 'Job not found.' });
        if (sim.job.status === 'succeeded' || sim.job.status === 'failed') return { ...sim.job };
        sim.polls += 1;
        const names = sim.job.steps?.map((s) => s.name) ?? stepNamesFor.generic;
        if (sim.polls === 1)
          sim.job = { ...sim.job, status: 'pending', steps: steps(names, 1, false) };
        else if (sim.polls === 2)
          sim.job = { ...sim.job, status: 'running', steps: steps(names, 2, false) };
        else {
          const failMessage = (sim.job as Job & { _failMessage?: string })._failMessage;
          if (sim.willFail) {
            sim.fail();
            sim.job = {
              ...sim.job,
              status: 'failed',
              steps: steps(names, 3, true),
              error: { code: 'simulated_failure', message: failMessage ?? 'Simulated failure.' },
            };
          } else {
            sim.finish();
            sim.job = {
              ...sim.job,
              status: 'succeeded',
              steps: steps(names, 3, false),
              message: 'Simulated outcome',
            };
          }
          const rec = operations.find((o) => o.id === id);
          if (rec) {
            rec.status = sim.job.status;
            rec.finished_at = ago(0);
          }
        }
        return { ...sim.job };
      },
    },

    ipam: {
      stats: async () => ({
        cidr: POOL_CIDR,
        total: leases.length,
        allocated: leases.filter((l) => l.state === 'allocated').length,
        quarantined: leases.filter((l) => l.state === 'quarantined').length,
        free: leases.filter((l) => l.state === 'free').length,
        quarantine_seconds: QUARANTINE_SECONDS,
        as_of: ago(0),
      }),
      map: async () => ({
        cidr: POOL_CIDR,
        total: leases.length,
        allocated: leases.filter((l) => l.state === 'allocated').length,
        quarantined: leases.filter((l) => l.state === 'quarantined').length,
        free: leases.filter((l) => l.state === 'free').length,
        cells: leases.map((l, idx) => ({
          ip: l.ip,
          host: idx + 1,
          state: l.state,
          entity: l.sandbox_name ?? undefined,
          id: l.id,
          allocated_at: l.allocated_at ?? undefined,
          until: l.until ?? undefined,
        })),
        as_of: ago(0),
      }),
      leases: async (p) => {
        const filtered = leases.filter(
          (l) =>
            (!p.status || l.state === p.status) &&
            matches(p.q, l.ip, l.id, l.sandbox_name, l.sandbox_id),
        );
        return paginate(sortBy(filtered, p.sort), { page: p.page, pageSize: p.pageSize ?? 12 });
      },
      reconcile: async () =>
        startJob('ipam.reconcile', undefined, stepNamesFor.generic, {
          finish: () => undefined,
        }) as Operation<{ message: string }>,
    },

    gateways: {
      get: async () => ({
        vip: { address: VIP, owner_gateway_id: vipOwner },
        gateways: gateways.map((g) => ({ ...g })),
      }),
      failover: async (req) => {
        const target = gateways.find((g) => g.id === req.target_gateway_id);
        if (!target)
          throw new ApiError({ kind: 'not_found', status: 404, message: 'Gateway not found.' });
        if (vipOwner === target.id)
          throw new ApiError({
            kind: 'conflict',
            status: 409,
            message: `${target.name} already owns the virtual IP.`,
          });
        return startJob(
          'gateway.failover',
          { type: 'gateway', id: target.id },
          stepNamesFor.failover,
          {
            finish: () => {
              vipOwner = target.id;
              for (const g of gateways) {
                g.owns_vip = g.id === target.id;
                g.role = g.id === target.id ? 'master' : 'backup';
              }
              pushEvent(
                'info',
                { type: 'gateway', id: target.id },
                `${target.name} took over the virtual IP.`,
                'sim',
              );
            },
          },
        ) as Operation<{ message: string }>;
      },
      drill: async () => ({
        dry_run: true as const,
        steps: ['Dry run only: no service is stopped.'],
      }),
    },

    routes: {
      list: async (p) =>
        paginate(
          routes.filter(
            (r) =>
              (!p.status || r.health === p.status) &&
              matches(p.q, r.hostname, r.backend, r.sandbox_name),
          ),
          p,
        ),
    },

    configurations: {
      list: async () => configs.map((c) => ({ ...c })),
      validate: async (id) => {
        const cfg = getConfig(id);
        return startJob(
          'configuration.validate',
          { type: 'configuration', id },
          stepNamesFor.config,
          {
            finish: () => {
              cfg.validation = {
                status: 'passed',
                message: 'Simulated: configuration file is valid',
                at: ago(0),
              };
            },
          },
        ) as Operation<ConfigGeneration>;
      },
      deploy: async (id) => {
        const cfg = getConfig(id);
        if (cfg.validation.status !== 'passed') {
          throw new ApiError({
            kind: 'conflict',
            status: 409,
            message: 'Validate this generation successfully before deploying it.',
          });
        }
        return startJob(
          'configuration.deploy',
          { type: 'configuration', id },
          stepNamesFor.config,
          {
            finish: () => {
              cfg.deployment = { status: 'deployed' };
              cfg.gateways = gateways.map((g) => ({
                gateway_id: g.id,
                generation: cfg.generation,
                status: 'applied' as const,
              }));
              for (const g of gateways) g.config_generation = cfg.generation;
            },
          },
        ) as Operation<ConfigGeneration>;
      },
      rollback: async (id) => {
        const cfg = getConfig(id);
        return startJob(
          'configuration.rollback',
          { type: 'configuration', id },
          stepNamesFor.config,
          {
            finish: () => {
              configs = configs.map((c) => ({ ...c, last_known_good: c.id === id }));
              const target = getConfig(id);
              target.deployment = { status: 'deployed' };
              target.gateways = gateways.map((g) => ({
                gateway_id: g.id,
                generation: cfg.generation,
                status: 'applied' as const,
              }));
              for (const g of gateways) g.config_generation = cfg.generation;
            },
          },
        ) as Operation<ConfigGeneration>;
      },
    },

    events: {
      list: async (p) =>
        paginate(
          events.filter(
            (e) =>
              (!p.severity || e.severity === p.severity) &&
              matches(p.q, e.message, e.resource.id, e.resource.name, e.operation_id, e.trace_id),
          ),
          p,
        ),
    },
    operations: {
      list: async (p) =>
        paginate(
          operations.filter(
            (o) =>
              (!p.status || o.status === p.status) && matches(p.q, o.id, o.kind, o.resource?.id),
          ),
          p,
        ),
    },
    logs: {
      haproxy: async (p) => {
        const all = demoHaproxyLogs().filter((l) => !p.gatewayId || l.gateway_id === p.gatewayId);
        return {
          ...paginate(all, { page: p.page, pageSize: p.pageSize ?? 15 }),
          retrieved_at: ago(0),
        };
      },
      system: async (p) => {
        const all = demoSystemLogs().filter((l) => !p.gatewayId || l.gateway_id === p.gatewayId);
        return {
          ...paginate(all, { page: p.page, pageSize: p.pageSize ?? 15 }),
          retrieved_at: ago(0),
        };
      },
    },
    observability: {
      metrics: async () => ({
        summary: {
          requests_total: 7122,
          requests_per_sec: 12.8,
          http_2xx: 47,
          http_4xx: 2582,
          http_5xx: 5265,
          error_rate_pct: 3.2,
          latency_p50_ms: 1.2,
          latency_p95_ms: 2.9,
          latency_p99_ms: 5.6,
          active_connections: 0,
          total_connections: 9842958,
          bytes_out: 11056438,
          vip_holder: 'gw1',
          vrrp_interval_sec: 1.0,
          keepalived_role: 'MASTER',
          active_backends: 12,
          total_backends: 13,
          idle_cpu_pct: 100,
          uptime_seconds: 801159,
        },
        time_series: Array.from({ length: 15 }, (_, i) => ({
          timestamp: new Date(Date.now() - (14 - i) * 10000).toISOString(),
          requests_per_sec: 12 + (i % 3) * 0.5,
          latency_p50_ms: 1.2,
          latency_p95_ms: 2.9,
          latency_p99_ms: 5.6,
          http_2xx: 10,
          http_4xx: 2,
          http_5xx: 1,
        })),
        backends: [
          { name: 'team1', target: '10.20.30.37:80', status: 'UP', latency_ms: 1.2, requests: 842 },
          { name: 'team2', target: '10.20.30.15:80', status: 'UP', latency_ms: 1.4, requests: 765 },
          { name: 'live1', target: '10.20.30.9:80', status: 'UP', latency_ms: 1.1, requests: 520 },
          { name: 'live2', target: '10.20.30.17:80', status: 'UP', latency_ms: 1.3, requests: 490 },
          { name: 'live3', target: '10.20.30.19:80', status: 'UP', latency_ms: 1.0, requests: 530 },
          { name: 'live4', target: '10.20.30.10:80', status: 'UP', latency_ms: 1.2, requests: 515 },
          { name: 'live5', target: '10.20.30.14:80', status: 'UP', latency_ms: 1.5, requests: 480 },
          { name: 'live6', target: '10.20.30.18:80', status: 'UP', latency_ms: 1.1, requests: 505 },
          { name: 'live7', target: '10.20.30.11:80', status: 'UP', latency_ms: 1.2, requests: 495 },
          { name: 'live8', target: '10.20.30.16:80', status: 'UP', latency_ms: 1.4, requests: 510 },
          { name: 'live9', target: '10.20.30.13:80', status: 'UP', latency_ms: 1.3, requests: 500 },
          { name: 'live10', target: '10.20.30.12:80', status: 'UP', latency_ms: 1.2, requests: 535 },
          { name: 'default_maintenance', target: 'local:503', status: 'UP', latency_ms: 0.2, requests: 1392 },
        ],
        prometheus_text: '# HELP haproxy_up Whether HAProxy is running\nhaproxy_up{gateway="gw1"} 1\n',
        retrieved_at: new Date().toISOString(),
      }),
    },
    benchmarks: {
      suites: async () => demoSuites(),
      runs: async () => runs.map((r) => ({ ...r })),
      run: async (req) => {
        const suite = demoSuites().find((s) => s.id === req.suite_id);
        if (!suite)
          throw new ApiError({
            kind: 'not_found',
            status: 404,
            message: 'Unknown benchmark suite.',
          });
        if (suite.disruptive && !req.acknowledge_disruption) {
          throw new ApiError({
            kind: 'validation',
            status: 422,
            message: 'This suite disrupts traffic and must be acknowledged.',
          });
        }
        const n = runs.length + 1;
        const run: BenchmarkRun = {
          id: `run-${String(n).padStart(3, '0')}`,
          suite_id: suite.id,
          status: 'pending',
          origin: 'demo',
          started_at: new Date(DEMO_NOW).toISOString(),
          parameters: req.parameters,
          environment: 'demo simulator',
          metrics: null,
          output: 'Simulated run — values are fixtures, not measurements.',
        };
        runs.unshift(run);
        return startJob('benchmark.run', { type: 'benchmark', id: run.id }, stepNamesFor.generic, {
          finish: () => {
            const attempted = Object.values(req.parameters)[0] ?? 1;
            run.status = 'succeeded';
            run.finished_at = ago(0);
            run.metrics =
              suite.id === 'failover-timing'
                ? { attempted: 1, succeeded: 1, failed: 0, failover_seconds: 3.1 }
                : {
                    attempted,
                    succeeded: attempted,
                    failed: 0,
                    p50_ms: 15,
                    p95_ms: 44,
                    p99_ms: 70,
                  };
          },
        }) as Operation<BenchmarkRun>;
      },
    },
  };
}
