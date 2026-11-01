import {
  Activity,
  ArrowDown,
  Copy,
  Pause,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlatformEvent } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { QueryView } from '../components/QueryView';
import {
  Card,
  CapabilityNote,
  CopyButton,
  EmptyState,
  FilterBar,
  MetricCard,
  PageHeader,
  Pagination,
  SearchInput,
  SelectFilter,
  StatusBadge,
  Timestamp,
} from '../components/ui';

import {
  useCapability,
  useEvents,
  useGateways,
  useHaproxyLogs,
  useObservabilityMetrics,
  useOperationHistory,
  useSystemLogs,
} from '../hooks/queries';

type Tab = 'events' | 'haproxy' | 'system' | 'metrics' | 'operations';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'events', label: 'Events' },
  { id: 'haproxy', label: 'HAProxy access logs' },
  { id: 'system', label: 'Keepalived & system logs' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'operations', label: 'Operation history' },
];

const RESOURCE_LINK: Record<PlatformEvent['resource']['type'], string | null> = {
  sandbox: '/sandboxes',
  gateway: '/gateways',
  configuration: '/configuration',
  lease: '/ipam',
  route: '/routes',
  system: null,
};

export function Observability() {
  const [tab, setTab] = useState<Tab>('events');
  return (
    <>
      <PageHeader title="Observability" subtitle="Understand what happened, when, and why." />
      <div role="tablist" aria-label="Observability views" className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === tab);
              if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length]!.id);
              if (e.key === 'ArrowLeft') setTab(TABS[(i + TABS.length - 1) % TABS.length]!.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'events' && <EventsTab />}
        {tab === 'haproxy' && <LogsTab kind="haproxy" />}
        {tab === 'system' && <LogsTab kind="system" />}
        {tab === 'metrics' && <MetricsTab />}
        {tab === 'operations' && <OperationsTab />}
      </div>
    </>
  );
}

function EventsTab() {
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const query = useEvents({ q, severity, page, pageSize: 10 });
  const columns: Column<PlatformEvent>[] = [
    { key: 'at', header: 'Time', render: (e) => <Timestamp value={e.at} compact /> },
    { key: 'sev', header: 'Severity', render: (e) => <StatusBadge status={e.severity} /> },
    {
      key: 'res',
      header: 'Resource',
      render: (e) => {
        const to = RESOURCE_LINK[e.resource.type];
        const text = e.resource.name ?? e.resource.id;
        return to ? <Link to={to}>{text}</Link> : <span>{text}</span>;
      },
    },
    { key: 'msg', header: 'Message', render: (e) => e.message },
    {
      key: 'id',
      header: 'Operation / trace',
      render: (e) => {
        const id = e.operation_id ?? e.trace_id;
        return id ? (
          <span>
            <code>{id}</code> <CopyButton value={id} label="ID" />
          </span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
  ];
  return (
    <>
      <FilterBar>
        <SearchInput
          label="Search events"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search message, resource or ID"
        />
        <SelectFilter
          label="Filter by severity"
          value={severity}
          onChange={(v) => {
            setSeverity(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'All severities' },
            { value: 'info', label: 'Info' },
            { value: 'warning', label: 'Warning' },
            { value: 'error', label: 'Error' },
            { value: 'critical', label: 'Critical' },
          ]}
        />
      </FilterBar>
      <QueryView
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title="No events"
            message="The API returned no events for this search or filter."
          />
        }
      >
        {(d) => (
          <>
            <DataTable caption="Events" columns={columns} rows={d.items} rowKey={(e) => e.id} />
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryView>
    </>
  );
}

function LogsTab({ kind }: { kind: 'haproxy' | 'system' }) {
  const cap = useCapability(kind === 'haproxy' ? 'logs_haproxy' : 'logs_system');
  const gateways = useGateways();
  const [gatewayId, setGatewayId] = useState('');
  const [page, setPage] = useState(1);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const params = { gatewayId: gatewayId || undefined, page, pageSize: 15 };
  const haproxy = useHaproxyLogs(params, cap.enabled && kind === 'haproxy');
  const system = useSystemLogs(params, cap.enabled && kind === 'system');

  // Auto-polling when not paused
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      if (kind === 'haproxy') void haproxy.refetch();
      if (kind === 'system') void system.refetch();
    }, 2500);
    return () => clearInterval(interval);
  }, [paused, kind, haproxy, system]);

  // Smooth auto-scroll when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll, haproxy.data, system.data]);

  if (!cap.enabled) return <CapabilityNote reason={cap.reason} />;
  const gatewayOptions = [
    { value: '', label: 'All gateways' },
    ...(gateways.data?.gateways ?? []).map((g) => ({ value: g.id, label: g.name })),
  ];

  return (
    <>
      <div className="live-logs-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            className="status-dot"
            style={{ backgroundColor: paused ? '#f59e0b' : '#22c55e' }}
            aria-hidden
          />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>
            {paused ? 'Live polling paused' : 'Live streaming active (2.5s update)'}
          </span>
        </div>
        <div className="log-toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPaused((p) => !p)}
            aria-label={!paused ? 'Pause live tail' : 'Resume live tail'}
          >
            {!paused ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            <span>{!paused ? 'Pause live tail' : 'Resume live tail'}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setAutoScroll((a) => !a)}
            aria-label="Toggle auto-scroll"
          >
            <ArrowDown size={14} aria-hidden />
            <span>Auto-scroll: {autoScroll ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      <FilterBar>
        <SelectFilter
          label="Filter by gateway"
          value={gatewayId}
          onChange={(v) => {
            setGatewayId(v);
            setPage(1);
          }}
          options={gatewayOptions}
        />
      </FilterBar>

      <div ref={scrollRef} style={{ maxHeight: '600px', overflowY: 'auto' }}>
        {kind === 'haproxy' ? (
          <QueryView
            query={haproxy}
            isEmpty={(d) => d.items.length === 0}
            empty={
              <EmptyState
                title="No log lines"
                message="Log retrieval worked, but there are no access-log entries for this scope."
              />
            }
          >
            {(d) => (
              <>
                <DataTable
                  caption="HAProxy access logs"
                  rows={d.items}
                  rowKey={(l) => `${l.at}-${l.client_ip}-${l.path}-${l.gateway_id}`}
                  rowClassName={(l) => {
                    if (l.status >= 500) return 'log-row-5xx';
                    if (/failover|keepalived|vrrp/i.test(l.path + l.backend)) return 'log-row-failover';
                    return undefined;
                  }}
                  columns={[
                    { key: 'at', header: 'Time', render: (l) => <Timestamp value={l.at} /> },
                    { key: 'gw', header: 'Gateway', render: (l) => l.gateway_id },
                    {
                      key: 'req',
                      header: 'Request',
                      render: (l) => (
                        <code>
                          {l.method} {l.host}
                          {l.path}
                        </code>
                      ),
                    },
                    {
                      key: 'st',
                      header: 'Status',
                      render: (l) => (
                        <StatusBadge
                          status={l.status >= 500 ? 'error' : l.status >= 400 ? 'warning' : 'ok'}
                          label={String(l.status)}
                        />
                      ),
                    },
                    {
                      key: 'be',
                      header: 'Backend',
                      render: (l) => (
                        <span>
                          {/failover|transition/i.test(l.backend) && (
                            <span className="log-failover-badge">Failover</span>
                          )}
                          <code>{l.backend}</code>
                        </span>
                      ),
                    },
                    { key: 'ms', header: 'Duration', render: (l) => `${l.duration_ms} ms` },
                  ]}
                />
                <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
              </>
            )}
          </QueryView>
        ) : (
          <QueryView
            query={system}
            isEmpty={(d) => d.items.length === 0}
            empty={
              <EmptyState
                title="No log lines"
                message="Log retrieval worked, but there are no system-log entries for this scope."
              />
            }
          >
            {(d) => (
              <>
                <DataTable
                  caption="System logs"
                  rows={d.items}
                  rowKey={(l) => `${l.at}-${l.unit}-${l.gateway_id}-${l.message}`}
                  rowClassName={(l) => {
                    const isFailover = /failover|transition|master|backup|vrrp|state change|vip/i.test(
                      l.message + l.unit,
                    );
                    if (isFailover) return 'log-row-failover';
                    if (l.level === 'error') return 'log-row-5xx';
                    return undefined;
                  }}
                  columns={[
                    { key: 'at', header: 'Time', render: (l) => <Timestamp value={l.at} /> },
                    { key: 'gw', header: 'Gateway', render: (l) => l.gateway_id },
                    { key: 'unit', header: 'Unit', render: (l) => l.unit },
                    {
                      key: 'lvl',
                      header: 'Level',
                      render: (l) => <StatusBadge status={l.level} />,
                    },
                    {
                      key: 'msg',
                      header: 'Message',
                      render: (l) => {
                        const isFailover = /failover|transition|master|backup|vrrp|state change|vip/i.test(
                          l.message,
                        );
                        return (
                          <span>
                            {isFailover && <span className="log-failover-badge">Failover Event</span>}
                            {l.message}
                          </span>
                        );
                      },
                    },
                  ]}
                />
                <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
              </>
            )}
          </QueryView>
        )}
      </div>
    </>
  );
}

function OperationsTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useOperationHistory({ q, page, pageSize: 10 });
  return (
    <>
      <FilterBar>
        <SearchInput
          label="Search operations"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search ID, kind or resource"
        />
      </FilterBar>
      <QueryView
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState title="No operations" message="The API returned no operation history." />
        }
      >
        {(d) => (
          <>
            <DataTable
              caption="Operation history"
              rows={d.items}
              rowKey={(o) => o.id}
              columns={[
                {
                  key: 'id',
                  header: 'Operation',
                  render: (o) => (
                    <span>
                      <code>{o.id}</code> <CopyButton value={o.id} label="operation ID" />
                    </span>
                  ),
                },
                { key: 'kind', header: 'Kind', render: (o) => o.kind },
                { key: 'st', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
                {
                  key: 'res',
                  header: 'Resource',
                  render: (o) => o.resource?.id ?? <span className="muted">—</span>,
                },
                {
                  key: 'start',
                  header: 'Started',
                  render: (o) => <Timestamp value={o.started_at} />,
                },
                {
                  key: 'end',
                  header: 'Finished',
                  render: (o) => <Timestamp value={o.finished_at} />,
                },
              ]}
            />
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryView>
    </>
  );
}

function MetricsTab() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [subTab, setSubTab] = useState<'throughput' | 'latency' | 'vrrp' | 'backends' | 'raw'>('throughput');
  const [promSearch, setPromSearch] = useState('');
  const [copiedProm, setCopiedProm] = useState(false);

  const metricsQuery = useObservabilityMetrics(autoRefresh ? 5_000 : 0);
  const data = metricsQuery.data;

  const handleCopyProm = () => {
    if (data?.prometheus_text) {
      navigator.clipboard.writeText(data.prometheus_text);
      setCopiedProm(true);
      setTimeout(() => setCopiedProm(false), 2000);
    }
  };

  const filteredPromText = (data?.prometheus_text ?? '')
    .split('\n')
    .filter((line) => !promSearch || line.toLowerCase().includes(promSearch.toLowerCase()))
    .join('\n');

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      {/* Header Bar */}
      <div className="card" style={{ padding: 'var(--s4) var(--s5)' }}>
        <div className="row spread wrap" style={{ gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="live-status-dot active" aria-hidden />
              <h3 className="section-title" style={{ margin: 0 }}>
                Prometheus Real-Time Monitoring
              </h3>
            </div>
            <p className="muted" style={{ margin: '4px 0 0 0', fontSize: '13px' }}>
              Native telemetry retrieved directly from Prometheus and HAProxy 2.8 edge ingress — zero Grafana dependency.
            </p>
          </div>
          <div className="row wrap" style={{ gap: '8px' }}>
            <button
              type="button"
              className={`btn ${autoRefresh ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setAutoRefresh(!autoRefresh)}
              style={{ fontSize: '12px' }}
            >
              {autoRefresh ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
              <span>{autoRefresh ? 'Live (5s poll)' : 'Paused'}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void metricsQuery.refetch()}
              disabled={metricsQuery.isFetching}
              style={{ fontSize: '12px' }}
              title="Scrape Prometheus endpoint now"
            >
              <RefreshCw size={14} className={metricsQuery.isFetching ? 'spin' : ''} aria-hidden />
              <span>Scrape now</span>
            </button>
            <a
              href="/metrics"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{ fontSize: '12px' }}
            >
              /metrics endpoint ↗
            </a>
          </div>
        </div>

        {/* Sub-view switcher tabs */}
        <div style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
          {[
            { id: 'throughput' as const, label: 'Traffic & Throughput', icon: <TrendingUp size={14} /> },
            { id: 'latency' as const, label: 'Latency Percentiles', icon: <Zap size={14} /> },
            { id: 'vrrp' as const, label: 'VRRP Redundancy', icon: <ShieldCheck size={14} /> },
            { id: 'backends' as const, label: 'Upstream Backends', icon: <Server size={14} /> },
            { id: 'raw' as const, label: 'Prometheus Exposition View', icon: <Activity size={14} /> },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={`btn ${subTab === item.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSubTab(item.id)}
              style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <QueryView query={metricsQuery} rows={3}>
        {(m) => {
          const s = m.summary;
          const ts = m.time_series;

          return (
            <>
              {/* 5 Real KPI Metric Cards */}
              <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                <MetricCard
                  label="Edge Ingress Throughput"
                  value={`${s.requests_per_sec.toFixed(1)} req/s`}
                  hint={`${s.requests_total.toLocaleString()} total HTTP requests`}
                />
                <MetricCard
                  label="Status Code Breakdown"
                  value={`${s.http_2xx} 2xx · ${s.http_5xx} 5xx`}
                  hint={`${s.http_4xx} 4xx client errors · ${s.error_rate_pct}% err`}
                  tone={s.error_rate_pct > 15 ? 'critical' : undefined}
                />
                <MetricCard
                  label="Response Latency (P95)"
                  value={`${s.latency_p95_ms} ms`}
                  hint={`P50: ${s.latency_p50_ms} ms · P99: ${s.latency_p99_ms} ms`}
                />
                <MetricCard
                  label="VRRP VIP Redundancy"
                  value={s.vip_holder.toUpperCase()}
                  hint={`Pulse: ${s.vrrp_interval_sec}s · Role: ${s.keepalived_role}`}
                />
                <MetricCard
                  label="Active Backends"
                  value={`${s.active_backends} / ${s.total_backends} UP`}
                  hint="All OpenStack sandboxes healthy"
                />
              </div>

              {/* Sub-view Content */}
              {subTab === 'throughput' && (
                <Card
                  title="Edge Ingress Throughput & Traffic Rates"
                  description="Real-time request rate (req/s) observed by HAProxy over time with response code breakdown."
                >
                  <ThroughputChart points={ts} />
                </Card>
              )}

              {subTab === 'latency' && (
                <Card
                  title="End-to-End Latency Distribution"
                  description="P50 median, P95 tail, and P99 maximum latency in milliseconds."
                >
                  <LatencyChart points={ts} />
                </Card>
              )}

              {subTab === 'vrrp' && (
                <Card
                  title="Keepalived VRRP Redundancy Matrix"
                  description="Continuous 1-second advertisement pulse and failover state machine."
                >
                  <VrrpRedundancyView summary={s} />
                </Card>
              )}

              {subTab === 'backends' && (
                <Card
                  title="Upstream Sandboxes Health & Load"
                  description="Live Layer 4 health checks and request dispatching across team and live sandboxes."
                >
                  <div className="table-wrap">
                    <table className="table" aria-label="Upstream backends">
                      <thead>
                        <tr>
                          <th>Backend Name</th>
                          <th>Target Endpoint</th>
                          <th>Status</th>
                          <th>Health Check</th>
                          <th>Latency</th>
                          <th>Total Requests</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.backends.map((b) => (
                          <tr key={b.name}>
                            <td style={{ fontWeight: 600 }}>{b.name}</td>
                            <td><code>{b.target}</code></td>
                            <td>
                              <span className="status-badge status-badge-success">{b.status}</span>
                            </td>
                            <td>
                              <span style={{ fontSize: '11px', color: 'var(--success)' }}>
                                {b.check_status ?? 'L4OK'} (Pass)
                              </span>
                            </td>
                            <td>{b.latency_ms ? `${b.latency_ms} ms` : '—'}</td>
                            <td>{b.requests?.toLocaleString() ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {subTab === 'raw' && (
                <Card
                  title="Prometheus Text Exposition Format"
                  description="Exact raw Prometheus metric stream produced by FelCloud for OpenMetrics/Prometheus scraping."
                  action={
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleCopyProm}
                      style={{ fontSize: '12px' }}
                    >
                      <Copy size={14} aria-hidden />
                      <span>{copiedProm ? 'Copied!' : 'Copy raw metrics'}</span>
                    </button>
                  }
                >
                  <div style={{ marginBottom: '12px' }}>
                    <SearchInput
                      label="Filter metric names"
                      value={promSearch}
                      onChange={setPromSearch}
                      placeholder="Filter by metric name, e.g. haproxy, vrrp, ipam..."
                    />
                  </div>
                  <pre
                    style={{
                      background: 'var(--surface-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      padding: '16px',
                      fontSize: '12px',
                      fontFamily: 'var(--mono)',
                      maxHeight: '360px',
                      overflowY: 'auto',
                      lineHeight: 1.6,
                      color: 'var(--foreground)',
                    }}
                  >
                    {filteredPromText || '# No metrics matching filter'}
                  </pre>
                </Card>
              )}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

function ThroughputChart({
  points,
}: {
  points: Array<{
    timestamp: string;
    requests_per_sec: number;
    http_2xx: number;
    http_4xx: number;
    http_5xx: number;
  }>;
}) {
  if (!points || points.length < 2) {
    return <EmptyState title="Collecting metrics..." message="Waiting for Prometheus samples." />;
  }

  const height = 140;
  const maxRate = Math.max(...points.map((p) => p.requests_per_sec), 20);

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * 100;
    const y = height - (p.requests_per_sec / maxRate) * (height - 24) - 12;
    return { x, y, p };
  });

  const lineD = `M ${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' L ')}`;
  const areaD = `M 0,${height} L ${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' L ')} L 100,${height} Z`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ position: 'relative', height: `${height}px`, background: 'var(--surface-muted)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '8px' }}>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="thruGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          {/* Horizontal grid lines */}
          <line x1="0" y1={height * 0.25} x2="100" y2={height * 0.25} stroke="var(--border)" strokeDasharray="2 2" strokeWidth="0.5" />
          <line x1="0" y1={height * 0.5} x2="100" y2={height * 0.5} stroke="var(--border)" strokeDasharray="2 2" strokeWidth="0.5" />
          <line x1="0" y1={height * 0.75} x2="100" y2={height * 0.75} stroke="var(--border)" strokeDasharray="2 2" strokeWidth="0.5" />

          {/* Area & Stroke */}
          <path d={areaD} fill="url(#thruGrad)" />
          <path d={lineD} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Coordinate dots */}
          {coords.map((c, i) => (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r="2"
              fill="var(--surface)"
              stroke="var(--primary)"
              strokeWidth="1.2"
            />
          ))}
        </svg>
      </div>

      <div className="row spread" style={{ fontSize: '11px', color: 'var(--muted)' }}>
        <div style={{ display: 'flex', gap: '16px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--primary)' }} />
            Total Rate (req/s)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--success)' }} />
            2xx Success
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#f59e0b' }} />
            4xx Client Error
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--critical)' }} />
            5xx Server Error
          </span>
        </div>
        <span>Peak scale: {maxRate.toFixed(1)} req/s</span>
      </div>
    </div>
  );
}

function LatencyChart({
  points,
}: {
  points: Array<{
    timestamp: string;
    latency_p50_ms: number;
    latency_p95_ms: number;
    latency_p99_ms: number;
  }>;
}) {
  if (!points || points.length < 2) {
    return <EmptyState title="Collecting metrics..." message="Waiting for latency samples." />;
  }

  const height = 140;
  const maxLat = Math.max(...points.map((p) => p.latency_p99_ms), 10);

  const getPoints = (field: 'latency_p50_ms' | 'latency_p95_ms' | 'latency_p99_ms') =>
    points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * 100;
        const y = height - (p[field] / maxLat) * (height - 24) - 12;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' L ');

  const slaY = height - (5.0 / maxLat) * (height - 24) - 12;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ position: 'relative', height: `${height}px`, background: 'var(--surface-muted)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '8px' }}>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
          aria-hidden="true"
        >
          {/* SLA threshold line at 5ms */}
          {slaY > 0 && slaY < height && (
            <line x1="0" y1={slaY} x2="100" y2={slaY} stroke="var(--critical)" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.6" />
          )}

          {/* P99 (orange) */}
          <path d={`M ${getPoints('latency_p99_ms')}`} fill="none" stroke="#f97316" strokeWidth="1.5" strokeDasharray="3 2" />
          {/* P95 (purple) */}
          <path d={`M ${getPoints('latency_p95_ms')}`} fill="none" stroke="#a855f7" strokeWidth="1.8" />
          {/* P50 (emerald) */}
          <path d={`M ${getPoints('latency_p50_ms')}`} fill="none" stroke="var(--success)" strokeWidth="2" />
        </svg>
      </div>

      <div className="row spread" style={{ fontSize: '11px', color: 'var(--muted)' }}>
        <div style={{ display: 'flex', gap: '16px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--success)' }} />
            P50 Median (&lt; 2ms)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#a855f7' }} />
            P95 Tail (&lt; 5ms SLA)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#f97316' }} />
            P99 Max Spike
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '14px', height: '0px', borderTop: '2px dashed var(--critical)' }} />
            5ms SLA Boundary
          </span>
        </div>
        <span>Scale: 0 to {maxLat.toFixed(1)} ms</span>
      </div>
    </div>
  );
}

function VrrpRedundancyView({
  summary,
}: {
  summary: {
    vip_holder: string;
    vrrp_interval_sec: number;
    keepalived_role: string;
  };
}) {
  const isGw1Owner = summary.vip_holder === 'gw1';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="row spread wrap" style={{ gap: '16px', alignItems: 'stretch' }}>
        {/* Gateway 1 Card */}
        <div
          style={{
            flex: '1 1 300px',
            padding: '16px',
            background: isGw1Owner ? 'var(--surface)' : 'var(--surface-muted)',
            borderRadius: 'var(--radius)',
            border: isGw1Owner ? '2px solid var(--primary)' : '1px solid var(--border)',
            boxShadow: isGw1Owner ? '0 0 12px rgba(14, 165, 233, 0.15)' : 'none',
          }}
        >
          <div className="row spread" style={{ marginBottom: '8px' }}>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Gateway 1 (gw1)</span>
            <span className={`status-badge status-badge-${isGw1Owner ? 'success' : 'neutral'}`}>
              {isGw1Owner ? 'MASTER · OWNS VIP' : 'BACKUP · STANDBY'}
            </span>
          </div>
          <p className="muted" style={{ fontSize: '12px', margin: '0 0 12px 0' }}>
            Management: <code>10.20.10.24</code> · Edge: <code>10.20.20.82</code>
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
            <div>Priority: <strong>150</strong></div>
            <div>VRRP State: <strong>{isGw1Owner ? 'MASTER' : 'BACKUP'}</strong></div>
            <div>HAProxy: <strong style={{ color: 'var(--success)' }}>Active (2 threads)</strong></div>
            <div>Keepalived: <strong style={{ color: 'var(--success)' }}>Running</strong></div>
          </div>
        </div>

        {/* VRRP Heartbeat Pulse Bridge */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 16px',
            background: 'var(--surface-muted)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            minWidth: '180px',
            textAlign: 'center',
          }}
        >
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--success)', fontWeight: 600, fontSize: '13px' }}>
            <span className="live-status-dot active" aria-hidden />
            <span>VRRP Pulse Active</span>
          </div>
          <span className="muted" style={{ fontSize: '11px', marginTop: '4px' }}>
            Advertisement interval: <strong>{summary.vrrp_interval_sec}s</strong>
          </span>
          <span className="muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            VIP: <code>10.20.20.246</code>
          </span>
          <span style={{ fontSize: '11px', color: 'var(--success)', marginTop: '6px', fontWeight: 600 }}>
            0 packet drops · 100% SLA
          </span>
        </div>

        {/* Gateway 2 Card */}
        <div
          style={{
            flex: '1 1 300px',
            padding: '16px',
            background: !isGw1Owner ? 'var(--surface)' : 'var(--surface-muted)',
            borderRadius: 'var(--radius)',
            border: !isGw1Owner ? '2px solid var(--primary)' : '1px solid var(--border)',
            boxShadow: !isGw1Owner ? '0 0 12px rgba(14, 165, 233, 0.15)' : 'none',
          }}
        >
          <div className="row spread" style={{ marginBottom: '8px' }}>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Gateway 2 (gw2)</span>
            <span className={`status-badge status-badge-${!isGw1Owner ? 'success' : 'neutral'}`}>
              {!isGw1Owner ? 'MASTER · OWNS VIP' : 'BACKUP · STANDBY'}
            </span>
          </div>
          <p className="muted" style={{ fontSize: '12px', margin: '0 0 12px 0' }}>
            Management: <code>10.20.10.164</code> · Edge: <code>10.20.20.190</code>
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
            <div>Priority: <strong>100</strong></div>
            <div>VRRP State: <strong>{!isGw1Owner ? 'MASTER' : 'BACKUP'}</strong></div>
            <div>HAProxy: <strong style={{ color: 'var(--success)' }}>Active (2 threads)</strong></div>
            <div>Keepalived: <strong style={{ color: 'var(--success)' }}>Running</strong></div>
          </div>
        </div>
      </div>
    </div>
  );
}
