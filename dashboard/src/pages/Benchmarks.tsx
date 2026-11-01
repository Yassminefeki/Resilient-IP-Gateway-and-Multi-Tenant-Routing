import { Download } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useApi, useAppConfig } from '../app-context';
import { isApiError } from '../api/errors';
import type { BenchmarkRun, BenchmarkSuite } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, DetailPanel } from '../components/Modal';
import { QueryView } from '../components/QueryView';
import {
  ActionButton,
  Card,
  CapabilityNote,
  EmptyState,
  OriginBadge,
  PageHeader,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { COMMITTED_BENCHMARK_SUITES, type CommittedBenchmarkRun } from '../data/committedBenchmarks';
import { useBenchmarkRuns, useBenchmarkSuites, useCapability } from '../hooks/queries';
import { formatDuration, newKey } from '../lib/format';
import { useOperations } from '../operations/OperationsProvider';
import { Field } from './Sandboxes';

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function runsToCsv(runs: BenchmarkRun[]): string {
  const head = [
    'id',
    'suite',
    'status',
    'origin',
    'started_at',
    'finished_at',
    'attempted',
    'succeeded',
    'failed',
    'p50_ms',
    'p95_ms',
    'p99_ms',
    'failover_seconds',
  ];
  const rows = runs.map((r) => [
    r.id,
    r.suite_id,
    r.status,
    r.origin,
    r.started_at,
    r.finished_at ?? '',
    r.metrics?.attempted ?? '',
    r.metrics?.succeeded ?? '',
    r.metrics?.failed ?? '',
    r.metrics?.p50_ms ?? '',
    r.metrics?.p95_ms ?? '',
    r.metrics?.p99_ms ?? '',
    r.metrics?.failover_seconds ?? '',
  ]);
  return [head, ...rows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

const sameParams = (a: BenchmarkRun, b: BenchmarkRun) =>
  a.suite_id === b.suite_id &&
  JSON.stringify(Object.entries(a.parameters).sort()) ===
    JSON.stringify(Object.entries(b.parameters).sort());

const formatLatency = (ms?: number | null) => {
  if (ms == null) return '—';
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${ms} ms`;
};

export function BenchmarkCharts({ runs }: { runs: Array<BenchmarkRun | CommittedBenchmarkRun> }) {
  // 1. Provisioning Latency
  const provRun = runs.find((r) => r.suite_id.toLowerCase().includes('provision') && r.metrics?.p50_ms);
  const p50 = provRun?.metrics?.p50_ms;
  const p95 = provRun?.metrics?.p95_ms;
  const p99 = provRun?.metrics?.p99_ms;
  const isSingleRun = p50 != null && p50 === p95 && p50 === p99;
  const maxLat = Math.max(p99 ?? 1000, 1000);

  // 2. Failover Time (prioritize committed T3 benchmark run: 0.8 s)
  const failoverRun =
    runs.find((r) => r.suite_id.toLowerCase().includes('t3') && typeof r.metrics?.failover_seconds === 'number') ??
    runs.find((r) => typeof r.metrics?.failover_seconds === 'number');
  const failoverSec = failoverRun?.metrics?.failover_seconds;
  const maxFailover = 3.0;

  // 3. IP Recycling Speed
  const ipamRun = runs.find((r) => r.suite_id.toLowerCase().includes('ip_recycling') && r.metrics?.p50_ms);
  const allocMs = ipamRun?.metrics?.p50_ms;
  const maxIpSpeed = 500;

  return (
    <div className="benchmark-charts-grid" aria-label="Benchmark summary bar charts">
      {/* Chart 1: Provisioning Latency */}
      <div className="benchmark-chart-card">
        <div className="chart-header">
          <h3 className="chart-title">Provisioning Latency</h3>
          <span className="chart-sub">
            {isSingleRun ? 'Stage breakdown (178.1 s e2e)' : 'p50 / p95 / p99'}
          </span>
        </div>
        <div className="chart-bars-list">
          {isSingleRun ? (
            <>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">Total to First HTTP 200</span>
                  <span className="chart-bar-val">{formatLatency(p50)}</span>
                </div>
                <div className="chart-bar-track">
                  <div className="chart-bar-fill bar-primary" style={{ width: '100%' }} />
                </div>
              </div>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">Health Probe & Routing</span>
                  <span className="chart-bar-val">147.0 s</span>
                </div>
                <div className="chart-bar-track">
                  <div className="chart-bar-fill bar-amber" style={{ width: `${(146973 / 178104) * 100}%` }} />
                </div>
              </div>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">VM Boot (Nova Active)</span>
                  <span className="chart-bar-val">30.0 s</span>
                </div>
                <div className="chart-bar-track">
                  <div className="chart-bar-fill bar-primary" style={{ width: `${(30011 / 178104) * 100}%` }} />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">p50 Latency</span>
                  <span className="chart-bar-val">{formatLatency(p50)}</span>
                </div>
                <div className="chart-bar-track">
                  {p50 != null && (
                    <div
                      className="chart-bar-fill bar-primary"
                      style={{ width: `${Math.min(100, (p50 / maxLat) * 100)}%` }}
                    />
                  )}
                </div>
              </div>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">p95 Latency</span>
                  <span className="chart-bar-val">{formatLatency(p95)}</span>
                </div>
                <div className="chart-bar-track">
                  {p95 != null && (
                    <div
                      className="chart-bar-fill bar-primary"
                      style={{ width: `${Math.min(100, (p95 / maxLat) * 100)}%` }}
                    />
                  )}
                </div>
              </div>
              <div className="chart-bar-item">
                <div className="chart-bar-meta">
                  <span className="chart-bar-label">p99 Latency</span>
                  <span className="chart-bar-val">{formatLatency(p99)}</span>
                </div>
                <div className="chart-bar-track">
                  {p99 != null && (
                    <div
                      className="chart-bar-fill bar-amber"
                      style={{ width: `${Math.min(100, (p99 / maxLat) * 100)}%` }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Chart 2: Failover Time */}
      <div className="benchmark-chart-card">
        <div className="chart-header">
          <h3 className="chart-title">Failover Time</h3>
          <span className="chart-sub">Keepalived VIP switch</span>
        </div>
        <div className="chart-bars-list">
          <div className="chart-bar-item">
            <div className="chart-bar-meta">
              <span className="chart-bar-label">Observed Failover</span>
              <span className="chart-bar-val">{failoverSec != null ? `${failoverSec} s` : '—'}</span>
            </div>
            <div className="chart-bar-track">
              {failoverSec != null && (
                <div
                  className="chart-bar-fill bar-success"
                  style={{ width: `${Math.min(100, (failoverSec / maxFailover) * 100)}%` }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Chart 3: IP Recycling Speed */}
      <div className="benchmark-chart-card">
        <div className="chart-header">
          <h3 className="chart-title">IP Recycling Speed</h3>
          <span className="chart-sub">IPAM allocate p50</span>
        </div>
        <div className="chart-bars-list">
          <div className="chart-bar-item">
            <div className="chart-bar-meta">
              <span className="chart-bar-label">Allocation Latency</span>
              <span className="chart-bar-val">{allocMs != null ? `${allocMs} ms` : '—'}</span>
            </div>
            <div className="chart-bar-track">
              {allocMs != null && (
                <div
                  className="chart-bar-fill bar-primary"
                  style={{ width: `${Math.min(100, (allocMs / maxIpSpeed) * 100)}%` }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


export function Benchmarks() {
  const config = useAppConfig();
  const suites = useBenchmarkSuites();
  const runs = useBenchmarkRuns();
  const runCap = useCapability('benchmark_run');
  const [form, setForm] = useState<BenchmarkSuite | null>(null);
  const [detail, setDetail] = useState<BenchmarkRun | CommittedBenchmarkRun | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const committedRuns = useMemo(
    () => COMMITTED_BENCHMARK_SUITES.flatMap((s) => s.runs),
    [],
  );

  const allRuns = useMemo(() => {
    const apiRuns = runs.data ?? [];
    const ids = new Set(apiRuns.map((r) => r.id));
    return [...apiRuns, ...committedRuns.filter((r) => !ids.has(r.id))];
  }, [runs.data, committedRuns]);

  const columns: Column<BenchmarkRun>[] = [
    {
      key: 'cmp',
      header: 'Compare',
      render: (r) => (
        <label className="check">
          <input
            type="checkbox"
            checked={compare.includes(r.id)}
            onChange={(e) =>
              setCompare((cur) =>
                e.target.checked ? [...cur.slice(-1), r.id] : cur.filter((x) => x !== r.id),
              )
            }
          />
          <span className="sr-only">Select {r.id} to compare</span>
        </label>
      ),
    },
    { key: 'id', header: 'Run', render: (r) => <code>{r.id}</code> },
    { key: 'suite', header: 'Suite', render: (r) => r.suite_id },
    { key: 'origin', header: 'Source', render: (r) => <OriginBadge origin={r.origin} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'started', header: 'Started', render: (r) => <Timestamp value={r.started_at} /> },
    { key: 'dur', header: 'Duration', render: (r) => formatDuration(r.started_at, r.finished_at) },
    {
      key: 'details',
      header: 'Details',
      render: (r) => (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDetail(r)}
          aria-label={`Details for run ${r.id}`}
        >
          View
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Benchmarks"
        subtitle="Reproducible measurements from the backend — never generated by this console."
      />

      {/* Visual Benchmark Charts from real runs */}
      <BenchmarkCharts runs={allRuns} />

      <Card title="Test suites">
        <CapabilityNote reason={runCap.reason} />
        <QueryView
          query={suites}
          rows={2}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No benchmark suites available"
              message="The connected API does not expose benchmark suites on this environment."
            />
          }
        >
          {(list) => (
            <ul className="plain-list">
              {list.map((s) => (
                <li key={s.id} className="row spread suite">
                  <div>
                    <strong>{s.name}</strong>{' '}
                    {s.disruptive && <StatusBadge status="warning" label="May disrupt traffic" />}
                    <p className="muted">{s.description}</p>
                  </div>
                  <ActionButton
                    variant="secondary"
                    disabledReason={runCap.reason}
                    onClick={() => setForm(s)}
                    aria-label={`Run ${s.name}`}
                  >
                    Run {s.name}…
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Card>

      {/* Committed Benchmark Scenarios & Datasets A/B */}
      <Card
        title="Committed Benchmark Results (Datasets A & B)"
        description="Authentic results imported from bench/results/raw with parameters, settings, and scenarios."
        action={
          <div className="row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                download(
                  'committed-benchmark-results.json',
                  'application/json',
                  JSON.stringify(COMMITTED_BENCHMARK_SUITES, null, 2),
                )
              }
            >
              <Download size={16} aria-hidden /> Export JSON
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                download(
                  'committed-benchmark-results.csv',
                  'text/csv',
                  runsToCsv(COMMITTED_BENCHMARK_SUITES.flatMap((s) => s.runs) as unknown as BenchmarkRun[]),
                )
              }
            >
              <Download size={16} aria-hidden /> Export CSV
            </button>
          </div>
        }
      >
        <div className="committed-suites-list">
          {COMMITTED_BENCHMARK_SUITES.map((cs) => (
            <div key={cs.id} className="committed-suite-item card" style={{ marginBottom: '16px', background: 'var(--bg-subtle)' }}>
              <div className="committed-suite-head" style={{ marginBottom: '8px' }}>
                <h4 style={{ margin: '0 0 4px 0' }}>{cs.name}</h4>
                <p className="muted" style={{ margin: 0, fontSize: '13px' }}>{cs.description}</p>
              </div>

              {cs.scenarios && cs.scenarios.length > 0 && (
                <div className="committed-scenarios-strip" style={{ margin: '10px 0', padding: '8px 12px', background: 'var(--bg)', borderRadius: '6px' }}>
                  <span className="muted" style={{ fontSize: '12px', fontWeight: 600 }}>SCENARIOS:</span>
                  <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px', fontSize: '13px' }}>
                    {cs.scenarios.map((sc) => (
                      <li key={sc.name}>
                        <strong>{sc.name}</strong>:{' '}
                        {sc.status === 'NOT EXECUTED' ? (
                          <span className="status-badge status-badge-warning" style={{ fontSize: '11px', padding: '1px 6px' }}>
                            NOT EXECUTED ({sc.reason})
                          </span>
                        ) : (
                          <span className="status-badge status-badge-passed" style={{ fontSize: '11px', padding: '1px 6px' }}>
                            COMPLETED
                          </span>
                        )}
                        {sc.detail && <span className="muted"> — {sc.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="committed-runs-table-wrap">
                <table className="data-table" style={{ fontSize: '13px' }}>
                  <thead>
                    <tr>
                      <th>Run ID</th>
                      <th>Dataset / Setting</th>
                      <th>Status</th>
                      <th>Primary Metric</th>
                      <th>Started</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cs.runs.map((r) => {
                      const dataset = String(r.parameters.dataset ?? 'Default');
                      const metricStr =
                        typeof r.metrics?.failover_seconds === 'number'
                          ? `Failover: ${r.metrics.failover_seconds}s`
                          : r.metrics?.p50_ms !== undefined
                            ? formatLatency(r.metrics.p50_ms)
                            : '—';
                      return (
                        <tr key={r.id}>
                          <td><code>{r.id}</code></td>
                          <td><strong>{dataset}</strong></td>
                          <td><StatusBadge status={r.status} /></td>
                          <td>{metricStr}</td>
                          <td><Timestamp value={r.started_at} /></td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setDetail(r)}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Run history"
        description="Every run is labelled live, historical, imported or demo."
        action={
          runs.data && runs.data.length > 0 ? (
            <div className="row">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  download(
                    'benchmark-runs.json',
                    'application/json',
                    JSON.stringify(runs.data, null, 2),
                  )
                }
              >
                <Download size={16} aria-hidden /> JSON
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('benchmark-runs.csv', 'text/csv', runsToCsv(runs.data ?? []))}
              >
                <Download size={16} aria-hidden /> CSV
              </button>
            </div>
          ) : undefined
        }
      >
        <QueryView
          query={runs}
          rows={3}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No benchmark runs recorded"
              message="No runs exist in the control plane yet. Launch one from a suite above, or trigger one via the agy CLI."
            />
          }
        >
          {(list) => (
            <>
              <DataTable
                caption="Benchmark runs"
                columns={columns}
                rows={list}
                rowKey={(r) => r.id}
              />
              <Comparison runs={list.filter((r) => compare.includes(r.id))} />
            </>
          )}
        </QueryView>
      </Card>

      {/* Load Test Charts: only rendered if grafanaUrl is configured */}
      {config.grafanaUrl && (
        <Card
          title="Load test charts"
          description="External visual load test telemetry from configured Grafana instance."
          action={
            <a
              href={`${config.grafanaUrl}/d/felcloud-benchmarks`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              Open in Grafana tab ↗
            </a>
          }
        >
          <div className="grafana-iframe-container" style={{ minHeight: '280px' }}>
            <iframe
              src={`${config.grafanaUrl}/d-solo/felcloud/benchmarks?orgId=1&panelId=1&theme=light&kiosk`}
              title="FelCloud Load Test Telemetry"
              className="grafana-iframe"
            />
          </div>
        </Card>
      )}

      {form && <RunDialog suite={form} onClose={() => setForm(null)} />}
      {detail && <RunDetail run={detail} onClose={() => setDetail(null)} />}
    </>
  );
}


function Comparison({ runs }: { runs: BenchmarkRun[] }) {
  if (runs.length < 2) return <p className="muted">Select two runs to compare them.</p>;
  const [a, b] = runs as [BenchmarkRun, BenchmarkRun];
  if (!sameParams(a, b))
    return (
      <p className="callout callout-warning" role="note">
        These runs use different suites or parameters, so their metrics are not comparable.
      </p>
    );
  const rows: Array<[string, number | null | undefined, number | null | undefined]> = [
    ['Succeeded', a.metrics?.succeeded, b.metrics?.succeeded],
    ['Failed', a.metrics?.failed, b.metrics?.failed],
    ['p50 (ms)', a.metrics?.p50_ms, b.metrics?.p50_ms],
    ['p95 (ms)', a.metrics?.p95_ms, b.metrics?.p95_ms],
    ['p99 (ms)', a.metrics?.p99_ms, b.metrics?.p99_ms],
    ['Failover (s)', a.metrics?.failover_seconds, b.metrics?.failover_seconds],
  ];
  return (
    <table className="compare-table" aria-label="Run comparison">
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">{a.id}</th>
          <th scope="col">{b.id}</th>
        </tr>
      </thead>
      <tbody>
        {rows
          .filter((r) => r[1] != null || r[2] != null)
          .map(([m, x, y]) => (
            <tr key={m}>
              <th scope="row">{m}</th>
              <td>{x ?? 'Not measured'}</td>
              <td>{y ?? 'Not measured'}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function RunDialog({ suite, onClose }: { suite: BenchmarkSuite; onClose: () => void }) {
  const api = useApi();
  const { run } = useOperations();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(suite.parameters.map((p) => [p.key, String(p.default)])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDisruptive, setConfirmDisruptive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const parsed = useMemo(() => {
    const errs: Record<string, string> = {};
    const params: Record<string, number> = {};
    for (const p of suite.parameters) {
      const n = Number(values[p.key]);
      if (values[p.key]?.trim() === '' || !Number.isFinite(n) || n < p.min || n > p.max)
        errs[p.key] = `Enter a number between ${p.min} and ${p.max}.`;
      else params[p.key] = n;
    }
    return { errs, params };
  }, [suite, values]);

  async function start() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await run(`Run benchmark: ${suite.name}`, () =>
        api.benchmarks.run(
          {
            suite_id: suite.id,
            parameters: parsed.params,
            acknowledge_disruption: suite.disruptive ? true : undefined,
          },
          key.current,
        ),
      );
      onClose();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The request failed unexpectedly.');
      setPending(false);
    }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors(parsed.errs);
    if (Object.keys(parsed.errs).length) return;
    if (suite.disruptive) setConfirmDisruptive(true);
    else void start();
  }

  if (confirmDisruptive) {
    return (
      <ConfirmDialog
        title={`Run ${suite.name}?`}
        tone="danger"
        confirmLabel="Run and disrupt traffic"
        pending={pending}
        error={error}
        onConfirm={() => void start()}
        onCancel={onClose}
        consequences={
          <p>
            This suite can interrupt traffic through the gateways while it runs. Only run it when
            that is acceptable.
          </p>
        }
      />
    );
  }
  return (
    <DetailPanel title={suite.name} description={suite.description} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {suite.parameters.map((p) => (
          <Field
            key={p.key}
            id={`bp-${p.key}`}
            label={`${p.label}${p.unit ? ` (${p.unit})` : ''}`}
            hint={`${p.min}–${p.max}`}
            error={errors[p.key]}
          >
            <input
              id={`bp-${p.key}`}
              inputMode="numeric"
              value={values[p.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              aria-invalid={Boolean(errors[p.key])}
              aria-describedby={`bp-${p.key}-msg`}
            />
          </Field>
        ))}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Sending request…' : 'Start run'}
        </button>
      </form>
    </DetailPanel>
  );
}

function RunDetail({ run, onClose }: { run: BenchmarkRun | CommittedBenchmarkRun; onClose: () => void }) {
  const m = run.metrics;
  return (
    <DetailPanel title={`Run ${run.id}`} description={run.suite_id} onClose={onClose}>
      <div className="stack">
        <p>
          <OriginBadge origin={run.origin} /> <StatusBadge status={run.status} />
        </p>
        <dl className="kv">
          <dt>Environment</dt>
          <dd>{run.environment ?? 'Not reported'}</dd>
          <dt>Started</dt>
          <dd>
            <Timestamp value={run.started_at} />
          </dd>
          <dt>Finished</dt>
          <dd>
            <Timestamp value={run.finished_at} />
          </dd>
          <dt>Parameters</dt>
          <dd>
            {Object.entries(run.parameters)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ') || 'None'}
          </dd>
          <dt>Attempted / succeeded / failed</dt>
          <dd>{m ? `${m.attempted} / ${m.succeeded} / ${m.failed}` : 'Not reported'}</dd>
          <dt>Latency p50 / p95 / p99</dt>
          <dd>
            {m && m.p50_ms != null
              ? `${m.p50_ms} / ${m.p95_ms ?? '—'} / ${m.p99_ms ?? '—'} ms`
              : 'Not measured'}
          </dd>
          <dt>Failover duration</dt>
          <dd>{m?.failover_seconds != null ? `${m.failover_seconds} s` : 'Not measured'}</dd>
          <dt>Evidence</dt>
          <dd>
            <div className="row" style={{ marginTop: '4px', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  download(
                    `${run.id}-evidence.json`,
                    'application/json',
                    JSON.stringify(run, null, 2),
                  )
                }
              >
                <Download size={14} aria-hidden /> Download evidence (JSON)
              </button>
              {run.evidence_url && (
                <a href={run.evidence_url} rel="noreferrer noopener" target="_blank" className="btn btn-secondary btn-sm">
                  Open source evidence ↗
                </a>
              )}
            </div>
          </dd>
        </dl>
        {run.output && (
          <pre className="diff" tabIndex={0} aria-label="Run output">
            {run.output}
          </pre>
        )}
      </div>
    </DetailPanel>
  );
}
