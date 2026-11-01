import type { BenchmarkOrigin, JOB_STATES } from '../api/contracts';

export type JobState = (typeof JOB_STATES)[number];

export interface CommittedBenchmarkRun {
  id: string;
  suite_id: string;
  status: JobState;
  origin: BenchmarkOrigin;
  started_at: string;
  finished_at?: string | null;
  parameters: Record<string, number | string>;
  environment?: string;
  metrics?: {
    attempted: number;
    succeeded: number;
    failed: number;
    p50_ms?: number | null;
    p95_ms?: number | null;
    p99_ms?: number | null;
    failover_seconds?: number | null;
  } | null;
  output?: string | null;
  evidence_url?: string | null;
}

export interface CommittedBenchmarkSuite {
  id: string;
  name: string;
  description: string;
  runs: CommittedBenchmarkRun[];
  scenarios?: Array<{
    name: string;
    status: 'COMPLETED' | 'NOT EXECUTED';
    reason?: string;
    detail?: string;
  }>;
}

export const COMMITTED_BENCHMARK_SUITES: CommittedBenchmarkSuite[] = [
  {
    id: 't1_provisioning',
    name: 'T1: MicroVM Provisioning Latency',
    description: 'Measures end-to-end sandbox creation from HTTP POST to first HTTP 200 via HAProxy.',
    runs: [
      {
        id: 't1_provisioning_20261018T175400Z',
        suite_id: 't1_provisioning',
        status: 'succeeded',
        origin: 'imported',
        started_at: '2026-10-18T17:54:00Z',
        finished_at: '2026-10-18T17:57:09Z',
        parameters: { dataset: 'Dataset B (Smoke Run)', planned_runs: 1, concurrency: 1 },
        metrics: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          p50_ms: 178104,
          p95_ms: 178104,
          p99_ms: 178104,
        },
        output: 'Smoke run: 1/1 sandboxes reached first HTTP 200 in 178.1s. IPAM allocate: 216ms, DNS: 69ms.',
      },
      {
        id: 't1_provisioning_20261018T133258Z',
        suite_id: 't1_provisioning',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-18T13:32:58Z',
        finished_at: '2026-10-18T15:22:31Z',
        parameters: { dataset: 'Dataset A (Sequential Stress)', planned_runs: 30, concurrency: 1 },
        metrics: {
          attempted: 30,
          succeeded: 27,
          failed: 3,
          p50_ms: 217136,
          p95_ms: 234406,
          p99_ms: 245154,
        },
        output: 'Sequential stress run: 27/30 succeeded (90.0% success rate, p50: 217.1s, p95: 234.4s). 3 runs failed during gateway_sync with context deadline exceeded.',
      },
    ],
  },
  {
    id: 't2_concurrent',
    name: 'T2: Concurrent Provisioning Burst',
    description: 'Burst load evaluation testing serialized SQLite IPAM transactions and routing convergence.',
    runs: [
      {
        id: 't2_concurrent_20261018T211200Z',
        suite_id: 't2_concurrent',
        status: 'succeeded',
        origin: 'imported',
        started_at: '2026-10-18T21:12:00Z',
        finished_at: '2026-10-18T21:28:40Z',
        parameters: { dataset: 'Dataset B (Burst Tiers 10 & 15)', burst_sizes: '10, 15', max_concurrent: 15 },
        metrics: {
          attempted: 25,
          succeeded: 25,
          failed: 0,
          p50_ms: 214200,
          p95_ms: 247900,
        },
        output: 'Burst tiers 10 and 15: 25/25 sandboxes provisioned concurrently with 0 IP collisions.',
      },
      {
        id: 't2_concurrent_20261018T201509Z',
        suite_id: 't2_concurrent',
        status: 'succeeded',
        origin: 'imported',
        started_at: '2026-10-18T20:15:09Z',
        finished_at: '2026-10-18T20:46:12Z',
        parameters: { dataset: 'Dataset A (Incremental Tiers)', burst_sizes: '3, 5, 10, 15' },
        metrics: {
          attempted: 33,
          succeeded: 26,
          failed: 7,
          p50_ms: 209107,
          p95_ms: 209304,
        },
        output: 'Burst tiers 3, 5, 10 succeeded at 100%; tier 15 had 8 successes while 7 client requests timed out.',
      },
    ],
  },
  {
    id: 't3_failover',
    name: 'T3: VRRP Gateway Failover Recovery',
    description: 'Keepalived heartbeat loss, secondary election, Gratuitous ARP broadcast, and HTTP traffic resumption.',
    scenarios: [
      {
        name: 'Baseline Probing',
        status: 'COMPLETED',
        detail: '60 seconds continuous probing on gw1 without failure.',
      },
      {
        name: 'stop_keepalived_gw1',
        status: 'COMPLETED',
        detail: 'Bastion VIP failover in 1.13s (run 174949Z) and 1.36s (run 145556Z). WAN probe in 145556Z took 22.4s due to floating IP ARP delay.',
      },
      {
        name: 'stop_haproxy_gw1',
        status: 'COMPLETED',
        detail: 'Harness evaluated FAILED (detection took 5.56s–6.45s due to deployed 2s check interval; positive weight prevented preempt in preliminary run).',
      },
      {
        name: 'Hard Stop Crash Scenario',
        status: 'NOT EXECUTED',
        reason: 'requires --include-hard-stop',
        detail: 'Omitted during automated benchmark to preserve host VM stability.',
      },
    ],
    runs: [
      {
        id: 't3_failover_20261019T174949Z',
        suite_id: 't3_failover',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T17:47:29Z',
        finished_at: '2026-10-19T17:49:49Z',
        parameters: {
          dataset: 'Dataset B (Production Setup)',
          check_haproxy: 'interval 2; fall 2; rise 2; weight 60',
        },
        metrics: {
          attempted: 2,
          succeeded: 1,
          failed: 1,
          failover_seconds: 1.13,
        },
        output: 'stop_keepalived_gw1 passed in 1.13s WAN / 1.25s Bastion. stop_haproxy_gw1 took 5.56s/6.45s (>3s threshold) due to 2s check interval.',
      },
      {
        id: 't3_failover_20261019T145556Z',
        suite_id: 't3_failover',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T14:53:20Z',
        finished_at: '2026-10-19T14:55:56Z',
        parameters: {
          dataset: 'Dataset A (Preliminary)',
          check_haproxy: 'interval 2; fall 2; rise 2; weight 60',
        },
        metrics: {
          attempted: 2,
          succeeded: 0,
          failed: 2,
          failover_seconds: 22.36,
        },
        output: 'stop_keepalived_gw1 bastion failover took 1.36s, but WAN probe took 22.4s. stop_haproxy_gw1 failed to preempt due to positive weight.',
      },
    ],
  },
  {
    id: 't4_ip_recycling',
    name: 'T4: IPAM Recycling & Quarantine Cooldown',
    description: 'Guarantees addresses enter cooldown after sandbox teardown and cannot be reassigned prematurely.',
    runs: [
      {
        id: 't4_ip_recycling_20261018T215336Z',
        suite_id: 't4_ip_recycling',
        status: 'succeeded',
        origin: 'imported',
        started_at: '2026-10-18T21:53:36Z',
        finished_at: '2026-10-18T21:56:00Z',
        parameters: { dataset: 'Dataset B', quarantine_seconds: 60, cycles: 3 },
        metrics: {
          attempted: 3,
          succeeded: 3,
          failed: 0,
          p50_ms: 1870,
          p95_ms: 2120,
        },
        output: 'Quarantine duration verified: addresses safely quarantined before clean reassignment.',
      },
      {
        id: 't4_ip_recycling_20261018T214746Z',
        suite_id: 't4_ip_recycling',
        status: 'succeeded',
        origin: 'imported',
        started_at: '2026-10-18T21:47:46Z',
        finished_at: '2026-10-18T21:50:00Z',
        parameters: { dataset: 'Dataset A', quarantine_seconds: 60, cycles: 1 },
        metrics: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          p50_ms: 1910,
          p95_ms: 1910,
        },
        output: 'Single-cycle IP quarantine and reuse verified.',
      },
    ],
  },
  {
    id: 't5_lease_expiry',
    name: 'T5: Lease Expiry & Autonomous Teardown',
    description: 'Background reaper sweeps expired leases and reclaims IP addresses.',
    runs: [
      {
        id: 't5_lease_expiry_20261019T123746Z',
        suite_id: 't5_lease_expiry',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T12:37:46Z',
        finished_at: '2026-10-19T12:46:12Z',
        parameters: { requested_sandboxes: 5, ttl_seconds: 120 },
        metrics: {
          attempted: 5,
          succeeded: 2,
          failed: 3,
        },
        output: 'Harness evaluated FAILED: 3 preflight rows were stuck in TEARDOWN_FAILED; 3/5 sandboxes missed rapid quarantine polling window.',
      },
    ],
  },
  {
    id: 't6_reload_rollback',
    name: 'T6: Atomic Configuration Reload & Rollback',
    description: 'Hot-reloads HAProxy with zero dropped sockets and auto-rolls back invalid configs.',
    runs: [
      {
        id: 't6_reload_rollback_20261019T142804Z',
        suite_id: 't6_reload_rollback',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T14:28:04Z',
        finished_at: '2026-10-19T14:29:10Z',
        parameters: { sync_count: 5, rollback_count: 5 },
        metrics: {
          attempted: 5,
          succeeded: 5,
          failed: 0,
          p50_ms: 12621,
          p95_ms: 12850,
        },
        output: 'Harness evaluated FAILED (rollback_under_1_second: false): 5/5 syncs had 0 probe drops; rollbacks took ~12.6s (includes 5s post-rollback health verification window).',
      },
      {
        id: 't6_reload_rollback_20261019T142508Z',
        suite_id: 't6_reload_rollback',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T14:25:08Z',
        finished_at: '2026-10-19T14:26:00Z',
        parameters: { sync_count: 1, rollback_count: 1 },
        metrics: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          p50_ms: 9414,
          p95_ms: 9414,
        },
        output: 'Harness evaluated FAILED (rollback_under_1_second: false): single-node rollback took 9.4s (includes 5s health soak window).',
      },
    ],
  },
  {
    id: 't7_isolation',
    name: 'T7: Multi-Tenant Network Isolation',
    description: 'Verifies OpenStack Neutron security group boundaries and tenant sandbox isolation.',
    runs: [
      {
        id: 't7_isolation_20261019T133840Z',
        suite_id: 't7_isolation',
        status: 'failed',
        origin: 'imported',
        started_at: '2026-10-19T13:38:40Z',
        finished_at: '2026-10-19T13:43:05Z',
        parameters: { total_probes: 24 },
        metrics: {
          attempted: 24,
          succeeded: 22,
          failed: 2,
        },
        output: 'Harness evaluated FAILED: inter-sandbox lateral movement blocked, but 2 forbidden open connections detected (gw1:22 and gw2:22 open on sandbox interface).',
      },
    ],
  },
];
